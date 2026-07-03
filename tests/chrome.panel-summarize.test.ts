import { describe, expect, it, vi } from "vitest";
import { summarizeActiveTab } from "../apps/chrome-extension/src/entrypoints/background/panel-summarize.js";
import { buildSummarizeRequestBody } from "../apps/chrome-extension/src/lib/daemon-payload.js";
import { defaultSettings } from "../apps/chrome-extension/src/lib/settings.js";

const youtubeUrl = "https://www.youtube.com/watch?v=KnUFH5GX_fI";
const browserMediaDiagnostics = {
  chunksProcessed: 1,
  chunksTotal: 1,
  codec: "opus",
  decoder: "mediabunny-webcodecs" as const,
  durationSeconds: 42,
  input: "url-range" as const,
  whisper: { device: "wasm" as const, loadMs: 10, reused: false },
};

function createHarness() {
  const session = {
    windowId: 1,
    runController: null,
    inflightUrl: null,
    inflightRequest: null,
    lastSummarizedUrl: null,
    activeSummaryRun: null,
    daemonRecovery: { recordFailure: vi.fn() },
    daemonStatus: { markReady: vi.fn() },
  };
  const sent: unknown[] = [];
  const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    return {
      ok: true,
      status: 200,
      statusText: "OK",
      json: async () => ({ ok: true, id: body.slides ? "summary-with-slides" : "summary" }),
    } as Response;
  });

  return {
    session,
    sent,
    fetchImpl,
    summarize: (overrides: Partial<Parameters<typeof summarizeActiveTab>[0]> = {}) =>
      summarizeActiveTab({
        session,
        reason: "panel-open",
        loadSettings: vi.fn(async () => ({
          ...defaultSettings,
          token: "token",
          autoSummarize: true,
          slidesEnabled: true,
          slidesParallel: true,
          slideRuntime: "daemon",
          summaryRuntime: "daemon",
          summaryTimestamps: true,
        })),
        emitState: vi.fn(),
        getActiveTab: vi.fn(async () => ({
          id: 7,
          windowId: 1,
          url: youtubeUrl,
          title: "YouTube",
        })),
        canSummarizeUrl: () => true,
        panelSessionStore: {
          isPanelOpen: () => true,
          setCachedExtract: vi.fn(),
        },
        sendStatus: vi.fn(),
        send: (message) => {
          sent.push(message);
        },
        fetchImpl: fetchImpl as unknown as typeof fetch,
        extractFromTab: vi.fn(),
        urlsMatch: (left, right) => left === right,
        buildSummarizeRequestBody,
        friendlyFetchError: (error, fallback) =>
          error instanceof Error ? error.message : fallback,
        isDaemonUnreachableError: () => false,
        logPanel: vi.fn(),
        ...overrides,
      }),
  };
}

describe("chrome panel summarize", () => {
  it("uses one daemon summarize request for YouTube slides", async () => {
    const harness = createHarness();

    await harness.summarize();

    expect(harness.fetchImpl).toHaveBeenCalledOnce();
    const [, init] = harness.fetchImpl.mock.calls[0];
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    expect(body).toMatchObject({
      url: youtubeUrl,
      mode: "url",
      timestamps: true,
      slides: true,
    });
    expect(body.videoMode).toBeUndefined();
    expect(body.extractOnly).toBeUndefined();
    expect(harness.sent).toEqual([
      {
        type: "run:start",
        run: {
          id: "summary-with-slides",
          url: youtubeUrl,
          title: "YouTube",
          model: defaultSettings.model,
          reason: "panel-open",
          slides: true,
        },
      },
    ]);
    expect(harness.session.lastSummarizedUrl).toBeNull();
  });

  it("keeps daemon slides on YouTube URL mode when Chrome already has a transcript", async () => {
    const harness = createHarness();

    await harness.summarize({
      extractYouTubeTranscript: vi.fn(async () => ({
        ok: true as const,
        url: youtubeUrl,
        text: "Caption transcript.",
        transcriptTimedText: "[0:00] Caption transcript.",
        truncated: false,
        durationSeconds: 42,
      })),
    });

    expect(harness.fetchImpl).toHaveBeenCalledOnce();
    const [, init] = harness.fetchImpl.mock.calls[0];
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    expect(body).toMatchObject({
      url: youtubeUrl,
      mode: "url",
      timestamps: true,
      slides: true,
    });
  });

  it("dedupes automatic starts for the current inflight URL", async () => {
    const harness = createHarness();
    harness.session.inflightUrl = youtubeUrl;
    harness.session.inflightRequest = { url: youtubeUrl, inputMode: "video", slides: true };

    await harness.summarize();

    expect(harness.fetchImpl).not.toHaveBeenCalled();
    expect(harness.sent).toEqual([]);
  });

  it("does not dedupe when slides settings change for the same URL", async () => {
    const harness = createHarness();
    let slidesEnabled = false;

    await harness.summarize({
      reason: "manual",
      loadSettings: vi.fn(async () => ({
        ...defaultSettings,
        token: "token",
        autoSummarize: true,
        slidesEnabled,
        slidesParallel: true,
        slideRuntime: "daemon",
        summaryRuntime: "daemon",
        summaryTimestamps: true,
      })),
    });
    slidesEnabled = true;
    await harness.summarize({
      reason: "manual",
      loadSettings: vi.fn(async () => ({
        ...defaultSettings,
        token: "token",
        autoSummarize: true,
        slidesEnabled,
        slidesParallel: true,
        slideRuntime: "daemon",
        summaryRuntime: "daemon",
        summaryTimestamps: true,
      })),
    });

    expect(harness.fetchImpl).toHaveBeenCalledTimes(2);
    const firstBody = JSON.parse(String(harness.fetchImpl.mock.calls[0]?.[1]?.body ?? "{}")) as
      | Record<string, unknown>
      | undefined;
    const secondBody = JSON.parse(String(harness.fetchImpl.mock.calls[1]?.[1]?.body ?? "{}")) as
      | Record<string, unknown>
      | undefined;
    expect(firstBody?.slides).not.toBe(true);
    expect(secondBody?.slides).toBe(true);
  });

  it("keeps non-YouTube URL-preferred pages out of the video transcript path", async () => {
    const harness = createHarness();
    const url = "https://x.com/example/status/1234567890123456789";
    const overrides = {
      getActiveTab: vi.fn(async () => ({
        id: 7,
        windowId: 1,
        url,
        title: "Post",
      })),
      extractFromTab: vi.fn(async () => ({
        ok: true,
        data: {
          ok: true,
          url,
          title: "Post",
          text: "post text",
          truncated: false,
          media: null,
        },
      })),
    };

    await harness.summarize(overrides);
    await harness.summarize(overrides);

    expect(harness.fetchImpl).toHaveBeenCalledOnce();
    const [, init] = harness.fetchImpl.mock.calls[0];
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    expect(body).toMatchObject({
      url,
      text: "post text",
      slides: true,
    });
    expect(body.mode).toBeUndefined();
    expect(body.videoMode).toBeUndefined();
  });

  it("uses a local browser summary snapshot without a daemon token in browser runtime", async () => {
    const harness = createHarness();
    const url = "https://example.com/article";
    const emitState = vi.fn();
    const sendStatus = vi.fn();

    await harness.summarize({
      reason: "manual",
      loadSettings: vi.fn(async () => ({
        ...defaultSettings,
        token: "",
        autoSummarize: true,
        slidesEnabled: false,
        slideRuntime: "browser",
      })),
      emitState,
      sendStatus,
      getActiveTab: vi.fn(async () => ({
        id: 7,
        windowId: 1,
        url,
        title: "Browser Article",
      })),
      extractFromTab: vi.fn(async () => ({
        ok: true,
        data: {
          ok: true,
          url,
          title: "Browser Article",
          text: "First sentence. Second sentence. Third sentence.",
          truncated: false,
          media: null,
        },
      })),
    });

    expect(emitState).not.toHaveBeenCalledWith(expect.anything(), "Setup required (missing token)");
    expect(harness.fetchImpl).not.toHaveBeenCalled();
    expect(harness.sent).toHaveLength(1);
    expect(harness.sent[0]).toMatchObject({
      type: "run:snapshot",
      run: {
        url,
        title: "Browser Article",
        model: "Browser",
        reason: "manual",
        slides: false,
      },
      markdown: expect.stringContaining("First sentence\\."),
      browserAi: {
        text: "First sentence. Second sentence. Third sentence.",
        length: "long",
        keyMoments: [],
      },
    });
    expect(harness.session.lastSummarizedUrl).toBe(url);
    expect(sendStatus).toHaveBeenLastCalledWith("");
  });

  it("does not coalesce a manual Browser summary behind a recent automatic fallback", async () => {
    const harness = createHarness();
    const url = "https://example.com/article";
    const overrides = {
      loadSettings: vi.fn(async () => ({
        ...defaultSettings,
        token: "",
        autoSummarize: true,
        slidesEnabled: false,
        slideRuntime: "browser" as const,
      })),
      getActiveTab: vi.fn(async () => ({
        id: 7,
        windowId: 1,
        url,
        title: "Browser Article",
      })),
      extractFromTab: vi.fn(async () => ({
        ok: true as const,
        data: {
          ok: true as const,
          url,
          title: "Browser Article",
          text: "First sentence. Second sentence.",
          truncated: false,
          media: null,
        },
      })),
    };

    await harness.summarize({ ...overrides, reason: "panel-open" });
    await harness.summarize({ ...overrides, reason: "manual" });

    expect(harness.sent).toHaveLength(2);
    expect(harness.sent).toEqual([
      expect.objectContaining({ type: "run:snapshot" }),
      expect.objectContaining({ type: "run:snapshot" }),
    ]);
  });

  it("transcribes a captionless YouTube tab locally without a daemon token", async () => {
    const harness = createHarness();
    const transcribeYouTubeLocally = vi.fn(async () => ({
      ok: true as const,
      url: youtubeUrl,
      text: "Local Whisper transcript.",
      transcriptTimedText: "[0:00] Local Whisper transcript.",
      truncated: false,
      durationSeconds: 42,
      mediaSource: "sabr" as const,
      diagnostics: browserMediaDiagnostics,
    }));

    await harness.summarize({
      reason: "manual",
      loadSettings: vi.fn(async () => ({
        ...defaultSettings,
        token: "",
        autoSummarize: true,
        slidesEnabled: false,
        slideRuntime: "browser",
      })),
      extractFromTab: vi.fn(async () => ({
        ok: true,
        data: {
          ok: true,
          url: youtubeUrl,
          title: "YouTube",
          text: "Video description without captions.",
          truncated: false,
          media: { hasVideo: true, hasAudio: true, hasCaptions: false },
        },
      })),
      transcribeYouTubeLocally,
    });

    expect(transcribeYouTubeLocally).toHaveBeenCalledWith({
      tabId: 7,
      maxChars: defaultSettings.maxChars,
      onStatus: expect.any(Function),
    });
    expect(harness.fetchImpl).not.toHaveBeenCalled();
    expect(harness.sent[0]).toMatchObject({
      type: "run:snapshot",
      markdown: expect.stringContaining("Local Whisper transcript"),
    });
  });

  it("falls through to local transcription when the YouTube caption probe stalls", async () => {
    const harness = createHarness();
    const transcribeYouTubeLocally = vi.fn(async () => ({
      ok: true as const,
      url: youtubeUrl,
      text: "Timed fallback transcript.",
      transcriptTimedText: "[0:00] Timed fallback transcript.",
      truncated: false,
      durationSeconds: 42,
      mediaSource: "android-vr" as const,
      diagnostics: browserMediaDiagnostics,
    }));

    await harness.summarize({
      reason: "manual",
      loadSettings: vi.fn(async () => ({
        ...defaultSettings,
        token: "",
        autoSummarize: true,
        slidesEnabled: false,
        slideRuntime: "browser",
      })),
      extractYouTubeTranscript: vi.fn(async () => await new Promise(() => {})),
      youtubeTranscriptTimeoutMs: 1,
      extractFromTab: vi.fn(async () => ({
        ok: true,
        data: {
          ok: true,
          url: youtubeUrl,
          title: "YouTube",
          text: "Description only.",
          truncated: false,
          media: { hasVideo: true, hasAudio: true, hasCaptions: false },
        },
      })),
      transcribeYouTubeLocally,
    });

    expect(transcribeYouTubeLocally).toHaveBeenCalledOnce();
    expect(harness.sent[0]).toMatchObject({
      type: "run:snapshot",
      markdown: expect.stringContaining("Timed fallback transcript"),
    });
  });

  it("transcribes direct media locally in browser runtime", async () => {
    const harness = createHarness();
    const url = "https://media.example/episode.mp3";
    const transcribeMediaLocally = vi.fn(async () => ({
      ok: true as const,
      url,
      text: "Direct media transcript.",
      transcriptTimedText: "[0:00] Direct media transcript.",
      truncated: false,
      durationSeconds: 42,
      source: "direct" as const,
      diagnostics: browserMediaDiagnostics,
    }));

    await harness.summarize({
      reason: "manual",
      loadSettings: vi.fn(async () => ({
        ...defaultSettings,
        token: "",
        autoSummarize: true,
        slidesEnabled: false,
        slideRuntime: "browser",
      })),
      getActiveTab: vi.fn(async () => ({
        id: 7,
        windowId: 1,
        url,
        title: "Episode",
      })),
      extractFromTab: vi.fn(async () => ({
        ok: true,
        data: {
          ok: true,
          url,
          title: "Episode",
          text: "",
          truncated: false,
          media: { hasVideo: false, hasAudio: true, hasCaptions: false },
        },
      })),
      transcribeMediaLocally,
    });

    expect(transcribeMediaLocally).toHaveBeenCalledWith({
      tabId: 7,
      tabUrl: url,
      maxChars: defaultSettings.maxChars,
      onStatus: expect.any(Function),
    });
    expect(harness.sent[0]).toMatchObject({
      type: "run:snapshot",
      markdown: expect.stringContaining("Direct media transcript"),
    });
  });

  it("keeps browser summaries local when browser runtime has a daemon token", async () => {
    const harness = createHarness();
    const url = "https://example.com/article";

    await harness.summarize({
      reason: "manual",
      loadSettings: vi.fn(async () => ({
        ...defaultSettings,
        token: "token",
        autoSummarize: true,
        slidesEnabled: false,
        slideRuntime: "browser",
      })),
      getActiveTab: vi.fn(async () => ({
        id: 7,
        windowId: 1,
        url,
        title: "Browser Article",
      })),
      extractFromTab: vi.fn(async () => ({
        ok: true,
        data: {
          ok: true,
          url,
          title: "Browser Article",
          text: "First sentence. Second sentence.",
          truncated: false,
          media: null,
        },
      })),
    });

    expect(harness.fetchImpl).not.toHaveBeenCalled();
    expect(harness.sent[0]).toMatchObject({
      type: "run:snapshot",
      run: {
        url,
        title: "Browser Article",
        model: "Browser",
        reason: "manual",
        slides: false,
      },
    });
  });

  it("keeps explicit Gemini Nano summaries local in Daemon mode", async () => {
    const harness = createHarness();
    const url = "https://example.com/article";

    await harness.summarize({
      reason: "manual",
      loadSettings: vi.fn(async () => ({
        ...defaultSettings,
        token: "token",
        summaryRuntime: "daemon",
        model: "browser/gemini-nano",
        autoSummarize: true,
        slidesEnabled: false,
        slideRuntime: "browser",
      })),
      getActiveTab: vi.fn(async () => ({
        id: 7,
        windowId: 1,
        url,
        title: "Nano Article",
      })),
      extractFromTab: vi.fn(async () => ({
        ok: true,
        data: {
          ok: true,
          url,
          title: "Nano Article",
          text: "First sentence. Second sentence.",
          truncated: false,
          media: null,
        },
      })),
    });

    expect(harness.fetchImpl).not.toHaveBeenCalled();
    expect(harness.sent[0]).toMatchObject({
      type: "run:snapshot",
      run: { url, model: "Browser", slides: false },
      browserAi: { text: "First sentence. Second sentence." },
    });
  });

  it("starts daemon slides alongside an explicit Gemini Nano summary", async () => {
    const harness = createHarness();

    await harness.summarize({
      reason: "manual",
      loadSettings: vi.fn(async () => ({
        ...defaultSettings,
        token: "token",
        summaryRuntime: "daemon",
        model: "browser/gemini-nano",
        autoSummarize: true,
        slidesEnabled: true,
        slideRuntime: "daemon",
      })),
      extractYouTubeTranscript: vi.fn(async () => ({
        ok: true as const,
        url: youtubeUrl,
        text: "Caption transcript.",
        transcriptTimedText: "[0:00] Caption transcript.",
        truncated: false,
        durationSeconds: 42,
      })),
    });

    expect(harness.sent).toEqual([
      expect.objectContaining({
        type: "run:snapshot",
        run: expect.objectContaining({
          url: youtubeUrl,
          model: "Browser",
          slides: true,
        }),
      }),
      {
        type: "slides:run",
        ok: true,
        runId: "summary-with-slides",
        url: youtubeUrl,
      },
    ]);
    expect(harness.fetchImpl).toHaveBeenCalledOnce();
    const [, init] = harness.fetchImpl.mock.calls[0];
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    expect(body).toMatchObject({
      url: youtubeUrl,
      mode: "url",
      model: "auto",
      slides: true,
      timestamps: true,
    });
  });

  it("starts daemon slides alongside a direct provider summary", async () => {
    const harness = createHarness();
    const encoder = new TextEncoder();
    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.startsWith("https://api.openai.com/")) {
        return new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(
                encoder.encode('data: {"choices":[{"delta":{"content":"Direct summary."}}]}\n\n'),
              );
              controller.enqueue(encoder.encode("data: [DONE]\n\n"));
              controller.close();
            },
          }),
          { status: 200, headers: { "content-type": "text/event-stream" } },
        );
      }
      const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      return new Response(
        JSON.stringify({ ok: true, id: body.slides ? "direct-slides" : "summary" }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });

    await harness.summarize({
      reason: "manual",
      fetchImpl: fetchImpl as unknown as typeof fetch,
      loadSettings: vi.fn(async () => ({
        ...defaultSettings,
        token: "token",
        summaryRuntime: "direct",
        model: "auto",
        provider: "openai",
        providerApiKeys: {
          ...defaultSettings.providerApiKeys,
          openai: "openai-key",
        },
        autoSummarize: true,
        slidesEnabled: true,
        slideRuntime: "daemon",
      })),
      extractYouTubeTranscript: vi.fn(async () => ({
        ok: true as const,
        url: youtubeUrl,
        text: "Caption transcript.",
        transcriptTimedText: "[0:00] Caption transcript.",
        truncated: false,
        durationSeconds: 42,
      })),
    });

    expect(harness.sent).toEqual([
      expect.objectContaining({
        type: "run:snapshot",
        run: expect.objectContaining({
          url: youtubeUrl,
          model: "OpenAI · gpt-5-mini",
          slides: true,
        }),
        markdown: "Direct summary.",
      }),
      {
        type: "slides:run",
        ok: true,
        runId: "direct-slides",
        url: youtubeUrl,
      },
    ]);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    const daemonCall = fetchImpl.mock.calls.find(([input]) =>
      String(input).startsWith("http://127.0.0.1:8787/"),
    );
    expect(daemonCall).toBeDefined();
    const daemonBody = JSON.parse(String(daemonCall?.[1]?.body ?? "{}")) as Record<string, unknown>;
    expect(daemonBody).toMatchObject({
      model: "auto",
      mode: "url",
      slides: true,
      timestamps: true,
    });
  });

  it("keeps a Direct provider on 127.0.0.1 off the daemon bridge", async () => {
    const harness = createHarness();
    const url = "https://example.com/article";
    const encoder = new TextEncoder();
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(
                encoder.encode('data: {"choices":[{"delta":{"content":"Local summary."}}]}\n\n'),
              );
              controller.enqueue(encoder.encode("data: [DONE]\n\n"));
              controller.close();
            },
          }),
          { status: 200, headers: { "content-type": "text/event-stream" } },
        ),
    );
    const daemonFetchImpl = vi.fn(async () => {
      throw new Error("daemon bridge must not handle Direct provider requests");
    });

    await harness.summarize({
      reason: "manual",
      fetchImpl: fetchImpl as unknown as typeof fetch,
      daemonFetchImpl: daemonFetchImpl as unknown as typeof fetch,
      loadSettings: vi.fn(async () => ({
        ...defaultSettings,
        token: "",
        summaryRuntime: "direct",
        model: "auto",
        provider: "ollama",
        providerBaseUrls: { ollama: "http://127.0.0.1:11434/v1" },
        autoSummarize: true,
        slidesEnabled: false,
        slideRuntime: "browser",
      })),
      getActiveTab: vi.fn(async () => ({ id: 7, windowId: 1, url, title: "Article" })),
      extractFromTab: vi.fn(async () => ({
        ok: true,
        data: {
          ok: true,
          url,
          title: "Article",
          text: "Article body.",
          truncated: false,
          media: null,
        },
      })),
    });

    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(String(fetchImpl.mock.calls[0]?.[0])).toBe("http://127.0.0.1:11434/v1/chat/completions");
    expect(daemonFetchImpl).not.toHaveBeenCalled();
    expect(harness.sent[0]).toMatchObject({
      type: "run:snapshot",
      markdown: "Local summary.",
      run: { model: "Ollama · llama3.2" },
    });
  });

  it("does not probe an unreachable daemon in browser runtime", async () => {
    const harness = createHarness();
    const url = "https://example.com/article";
    const sendStatus = vi.fn();
    const fetchImpl = vi.fn(async () => {
      throw new Error("Failed to fetch");
    });

    await harness.summarize({
      reason: "manual",
      sendStatus,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      isDaemonUnreachableError: () => true,
      loadSettings: vi.fn(async () => ({
        ...defaultSettings,
        token: "token",
        autoSummarize: true,
        slidesEnabled: false,
        slideRuntime: "browser",
      })),
      getActiveTab: vi.fn(async () => ({
        id: 7,
        windowId: 1,
        url,
        title: "Browser Article",
      })),
      extractFromTab: vi.fn(async () => ({
        ok: true,
        data: {
          ok: true,
          url,
          title: "Browser Article",
          text: "First sentence. Second sentence.",
          truncated: false,
          media: null,
        },
      })),
    });

    expect(harness.sent).toHaveLength(1);
    expect(harness.sent[0]).toMatchObject({
      type: "run:snapshot",
      run: { url, model: "Browser", slides: false },
      markdown: expect.stringContaining("First sentence\\."),
    });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(harness.session.daemonRecovery.recordFailure).not.toHaveBeenCalled();
    expect(sendStatus).toHaveBeenLastCalledWith("");
  });

  it("does not probe a stale daemon token in browser runtime", async () => {
    const harness = createHarness();
    const url = "https://example.com/article";
    const fetchImpl = vi.fn(async () => ({
      ok: false,
      status: 401,
      statusText: "Unauthorized",
      json: async () => ({ ok: false, error: "Unauthorized" }),
    }));

    await harness.summarize({
      reason: "manual",
      fetchImpl: fetchImpl as unknown as typeof fetch,
      isDaemonUnreachableError: () => false,
      loadSettings: vi.fn(async () => ({
        ...defaultSettings,
        token: "stale-token",
        autoSummarize: true,
        slidesEnabled: false,
        slideRuntime: "browser",
      })),
      getActiveTab: vi.fn(async () => ({
        id: 7,
        windowId: 1,
        url,
        title: "Browser Article",
      })),
      extractFromTab: vi.fn(async () => ({
        ok: true,
        data: {
          ok: true,
          url,
          title: "Browser Article",
          text: "First sentence. Second sentence.",
          truncated: false,
          media: null,
        },
      })),
    });

    expect(harness.sent).toHaveLength(1);
    expect(harness.sent[0]).toMatchObject({
      type: "run:snapshot",
      run: { url, model: "Browser", slides: false },
      markdown: expect.stringContaining("First sentence\\."),
    });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(harness.session.daemonRecovery.recordFailure).not.toHaveBeenCalled();
  });

  it("reports browser media transcription failures instead of summarizing descriptions", async () => {
    const harness = createHarness();

    await harness.summarize({
      reason: "manual",
      loadSettings: vi.fn(async () => ({
        ...defaultSettings,
        token: "",
        autoSummarize: true,
        slidesEnabled: false,
        slideRuntime: "browser",
      })),
      extractFromTab: vi.fn(async () => ({
        ok: true,
        data: {
          ok: true,
          url: youtubeUrl,
          title: "YouTube",
          text: "Video description without captions.",
          truncated: false,
          media: { hasVideo: true, hasAudio: true, hasCaptions: false },
        },
      })),
      transcribeYouTubeLocally: vi.fn(async () => ({
        ok: false as const,
        error: "decoder unavailable",
      })),
    });

    expect(harness.fetchImpl).not.toHaveBeenCalled();
    expect(harness.sent).toEqual([
      {
        type: "run:error",
        message:
          "Could not transcribe this media in standalone mode: decoder unavailable. Switch Runtime to Daemon for broader media support.",
      },
    ]);
    expect(harness.session.lastSummarizedUrl).toBeNull();
  });

  it("summarizes usable text-first preferred URLs when no local media is available", async () => {
    const harness = createHarness();
    const url = "https://x.com/example/status/1234567890123456789";

    await harness.summarize({
      reason: "manual",
      loadSettings: vi.fn(async () => ({
        ...defaultSettings,
        token: "",
        autoSummarize: true,
        slidesEnabled: false,
        slideRuntime: "browser",
      })),
      getActiveTab: vi.fn(async () => ({
        id: 7,
        windowId: 1,
        url,
        title: "Post",
      })),
      extractFromTab: vi.fn(async () => ({
        ok: true,
        data: {
          ok: true,
          url,
          title: "Post",
          text: "Useful post text without fetchable media.",
          truncated: false,
          media: null,
        },
      })),
      transcribeMediaLocally: vi.fn(async () => ({
        ok: false as const,
        error: "No fetchable media source.",
      })),
    });

    expect(harness.fetchImpl).not.toHaveBeenCalled();
    expect(harness.sent[0]).toMatchObject({
      type: "run:snapshot",
      run: { url, model: "Browser", slides: false },
      markdown: expect.stringContaining("Useful post text without fetchable media\\."),
    });
  });

  it("reports empty browser page extraction instead of caching a fake summary", async () => {
    const harness = createHarness();
    const url = "https://example.com/empty";

    await harness.summarize({
      reason: "manual",
      loadSettings: vi.fn(async () => ({
        ...defaultSettings,
        token: "",
        autoSummarize: true,
        slidesEnabled: false,
        slideRuntime: "browser",
      })),
      getActiveTab: vi.fn(async () => ({
        id: 7,
        windowId: 1,
        url,
        title: "Empty",
      })),
      extractFromTab: vi.fn(async () => ({
        ok: false,
        error: "blocked",
      })),
    });

    expect(harness.sent).toEqual([
      {
        type: "run:error",
        message:
          "No readable text was available in standalone mode. Reload the page or switch Runtime to Daemon for URL extraction.",
      },
    ]);
    expect(harness.session.lastSummarizedUrl).toBeNull();
  });
});
