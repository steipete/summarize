import { describe, expect, it, vi } from "vitest";
import type { routeExtract } from "../apps/chrome-extension/src/entrypoints/background/extractors/router.js";
import {
  ensurePreparedPanelTranscript,
  preparePanelContent,
  type PreparedPanelContent,
} from "../apps/chrome-extension/src/entrypoints/background/panel-content-preparation.js";
import { message } from "../apps/chrome-extension/src/lib/i18n";
import { defaultSettings } from "../apps/chrome-extension/src/lib/settings.js";

const articleUrl = "https://example.com/article";
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

function createHarness(overrides: Record<string, unknown> = {}) {
  const sendStatus = vi.fn();
  const logPanel = vi.fn();
  const routeExtractImpl = vi.fn<typeof routeExtract>(async (context) => {
    context.log("extract:attempt");
    context.log("extract:inject:ok");
    context.log("extract:message:ok");
    return {
      extracted: {
        ok: true,
        url: articleUrl,
        title: "Extracted title",
        text: "Article body",
        truncated: false,
        media: null,
      },
      source: "url",
      diagnostics: { strategy: "daemon" },
    };
  });
  const extractFromTab = vi.fn(async () => ({
    ok: true as const,
    data: {
      ok: true as const,
      url: articleUrl,
      title: "Content title",
      text: "Content body",
      truncated: false,
      media: null,
    },
  }));
  return {
    sendStatus,
    logPanel,
    routeExtractImpl,
    extractFromTab,
    args: {
      tab: { id: 7, url: articleUrl, title: "Tab title" },
      tabUrl: articleUrl,
      settings: { ...defaultSettings, token: "secret" },
      reason: "manual",
      refresh: false,
      requestedInputMode: null,
      useBrowserSummary: false,
      panelOpen: () => true,
      isSuperseded: () => false,
      signal: new AbortController().signal,
      fetchImpl: vi.fn() as unknown as typeof fetch,
      extractFromTab,
      routeExtractImpl,
      sendStatus,
      logPanel,
      urlsMatch: (left: string, right: string) => left === right,
      ...overrides,
    },
  };
}

async function prepareBilibiliWithoutCaptions() {
  const url = "https://www.bilibili.com/video/BV1ipnr6cExW/";
  const captionError = "No Bilibili caption tracks are available in this browser session.";
  const harness = createHarness({
    tab: { id: 7, url, title: "Bilibili video" },
    tabUrl: url,
    useBrowserSummary: true,
    extractBilibiliTranscript: vi.fn(async () => ({
      ok: false,
      reason: "failed",
      error: captionError,
    })),
  });
  const prepared = await preparePanelContent(harness.args);
  if (prepared.kind !== "ready") throw new Error("Expected ready Bilibili content");
  return { harness, content: prepared.content, captionError, url };
}

describe("chrome panel content preparation", () => {
  it("retains the actionable Bilibili caption error when local audio cannot recover", async () => {
    const { harness, content, captionError } = await prepareBilibiliWithoutCaptions();
    const mediaError = "The active media source is not fetchable outside the page.";
    const result = await ensurePreparedPanelTranscript({
      ...harness.args,
      content,
      transcribeYouTubeLocally: vi.fn(),
      transcribeMediaLocally: vi.fn(async () => ({ ok: false as const, error: mediaError })),
    });
    expect(result.payload.text).toBe("");
    expect(result.localTranscriptError).toBe(captionError);
    expect(result.localTranscriptMessage).toEqual({
      key: "error.bilibiliCaptionsUnavailable",
      values: {},
    });
    expect(harness.logPanel).toHaveBeenCalledWith("extract:browser-media:local-transcript-failed", {
      error: mediaError,
    });
  });

  it("clears the Bilibili caption error when local audio recovers", async () => {
    const { harness, content, url } = await prepareBilibiliWithoutCaptions();
    const result = await ensurePreparedPanelTranscript({
      ...harness.args,
      content,
      transcribeYouTubeLocally: vi.fn(),
      transcribeMediaLocally: vi.fn(async () => ({
        ok: true as const,
        url,
        text: "Recovered audio transcript",
        transcriptTimedText: "[0:00] Recovered audio transcript",
        truncated: false,
        durationSeconds: 42,
        source: "embedded" as const,
        diagnostics: browserMediaDiagnostics,
      })),
    });
    expect(result.payload.text).toBe("Recovered audio transcript");
    expect(result.transcriptTimedText).toBe("[0:00] Recovered audio transcript");
    expect(result.localTranscriptError).toBeNull();
    expect(result.localTranscriptMessage).toBeUndefined();
  });

  it("uses logged-in Bilibili captions before page extraction in default mode", async () => {
    const url = "https://www.bilibili.com/video/BV1ipnr6cExW/?p=2";
    const extractBilibiliTranscript = vi.fn(async () => ({
      ok: true as const,
      url,
      text: "Transcript:\n[0:01] Second part captions",
      transcriptTimedText: "[0:01] Second part captions",
      truncated: false,
      durationSeconds: 567,
      language: "ai-en",
      generated: true,
    }));
    const harness = createHarness({
      tab: { id: 7, url, title: "Bilibili video" },
      tabUrl: url,
      extractBilibiliTranscript,
    });

    const result = await preparePanelContent(harness.args);

    expect(result).toMatchObject({
      kind: "ready",
      content: {
        payload: {
          url,
          text: "Transcript:\n[0:01] Second part captions",
          mediaDurationSeconds: 567,
          media: { hasVideo: true, hasAudio: true, hasCaptions: true },
        },
        transcriptTimedText: "[0:01] Second part captions",
        diagnostics: {
          strategy: "bilibili-captions",
          transcript: { provider: "bilibili-ai-captions/ai-en" },
        },
      },
    });
    expect(extractBilibiliTranscript).toHaveBeenCalledWith(7, defaultSettings.maxChars, url);
    expect(harness.extractFromTab).not.toHaveBeenCalled();
    expect(harness.routeExtractImpl).not.toHaveBeenCalled();
  });

  it("does not use a Bilibili description as a failed video transcript", async () => {
    const url = "https://www.bilibili.com/video/BV1ipnr6cExW/";
    const harness = createHarness({
      tab: { id: 7, url, title: "Bilibili video" },
      tabUrl: url,
      requestedInputMode: "video",
      extractBilibiliTranscript: vi.fn(async () => ({
        ok: false as const,
        reason: "failed",
        error: "No Bilibili caption tracks are available in this browser session.",
      })),
    });
    const result = await preparePanelContent(harness.args);
    expect(result).toMatchObject({
      kind: "ready",
      content: { payload: { url, text: "", media: { hasCaptions: false } } },
    });
    expect(harness.extractFromTab).not.toHaveBeenCalled();
    expect(harness.routeExtractImpl).not.toHaveBeenCalled();
  });

  it("discards Bilibili captions when the tab changes part during retrieval", async () => {
    const url = "https://www.bilibili.com/video/BV1ipnr6cExW/";
    const harness = createHarness({
      tab: { id: 7, url, title: "Bilibili video" },
      tabUrl: url,
      extractBilibiliTranscript: vi.fn(async () => ({
        ok: false,
        reason: "stale",
        error: "Page changed",
      })),
    });
    expect(await preparePanelContent(harness.args)).toEqual({ kind: "stale" });
    expect(harness.extractFromTab).not.toHaveBeenCalled();
  });

  it("preserves routed source and diagnostics behind a prepared content contract", async () => {
    const harness = createHarness();

    const result = await preparePanelContent(harness.args);

    expect(result).toEqual({
      kind: "ready",
      content: {
        payload: {
          ok: true,
          url: articleUrl,
          title: "Tab title",
          text: "Article body",
          truncated: false,
          media: null,
        },
        title: "Tab title",
        transcriptTimedText: null,
        localTranscriptError: null,
        source: "url",
        diagnostics: { strategy: "daemon" },
        prefersUrlMode: false,
      },
    });
    expect(harness.routeExtractImpl).toHaveBeenCalledWith(
      expect.objectContaining({
        url: articleUrl,
        noCache: false,
        allowDaemon: true,
        signal: harness.args.signal,
      }),
    );
    expect(harness.sendStatus).toHaveBeenCalledWith(
      message("progress.panelExtract", { stage: "page" }),
    );
    expect(harness.sendStatus).toHaveBeenCalledWith(
      message("progress.panelExtract", { stage: "inject" }),
    );
    expect(harness.sendStatus).toHaveBeenCalledWith(
      message("progress.panelExtract", { stage: "read" }),
    );
  });

  it("uses content-script extraction for URL-preferred non-YouTube pages", async () => {
    const url = "https://x.com/example/status/1234567890123456789";
    const harness = createHarness({
      tab: { id: 7, url, title: "Post" },
      tabUrl: url,
      requestedInputMode: "video",
    });
    harness.extractFromTab.mockResolvedValueOnce({
      ok: false,
      error: "blocked",
    });

    const result = await preparePanelContent(harness.args);

    expect(result).toMatchObject({
      kind: "ready",
      content: {
        payload: { url, title: "Post", text: "", media: null },
        source: "page",
        prefersUrlMode: true,
      },
    });
    expect(harness.routeExtractImpl).not.toHaveBeenCalled();
    expect(harness.extractFromTab).toHaveBeenCalledWith(
      7,
      defaultSettings.maxChars,
      expect.objectContaining({ inputMode: "video" }),
    );
  });

  it("rejects a stale YouTube caption result", async () => {
    const harness = createHarness({
      tab: { id: 7, url: youtubeUrl, title: "Video" },
      tabUrl: youtubeUrl,
      requestedInputMode: "video",
      extractYouTubeTranscript: vi.fn(async () => ({
        ok: true as const,
        url: `${youtubeUrl}-stale`,
        text: "Transcript",
        transcriptTimedText: "[0:00] Transcript",
        truncated: false,
        durationSeconds: 42,
      })),
    });

    await expect(preparePanelContent(harness.args)).resolves.toEqual({ kind: "stale" });
    expect(harness.extractFromTab).not.toHaveBeenCalled();
  });

  it("uses a current YouTube caption result without content-script extraction", async () => {
    const harness = createHarness({
      tab: { id: 7, url: youtubeUrl, title: "Video" },
      tabUrl: youtubeUrl,
      requestedInputMode: "video",
      extractYouTubeTranscript: vi.fn(async () => ({
        ok: true as const,
        url: youtubeUrl,
        text: "Transcript",
        transcriptTimedText: "[0:00] Transcript",
        truncated: false,
        durationSeconds: 42,
      })),
    });

    const result = await preparePanelContent(harness.args);

    expect(result).toMatchObject({
      kind: "ready",
      content: {
        payload: {
          url: youtubeUrl,
          text: "Transcript",
          mediaDurationSeconds: 42,
          media: { hasVideo: true, hasAudio: true, hasCaptions: true },
        },
        transcriptTimedText: "[0:00] Transcript",
      },
    });
    expect(harness.extractFromTab).not.toHaveBeenCalled();
  });

  it("falls back to content-script video text when YouTube captions are empty", async () => {
    const harness = createHarness({
      tab: { id: 7, url: youtubeUrl, title: "Video" },
      tabUrl: youtubeUrl,
      requestedInputMode: "video",
      extractYouTubeTranscript: vi.fn(async () => ({
        ok: true as const,
        url: youtubeUrl,
        text: "",
        transcriptTimedText: "",
        truncated: false,
        durationSeconds: 42,
      })),
    });
    harness.extractFromTab.mockImplementationOnce(async (_tabId, _maxChars, options) => {
      options?.log?.("extract:message:ok", { source: "content-script" });
      return {
        ok: true,
        data: {
          ok: true,
          url: youtubeUrl,
          title: "Video",
          text: "Video description",
          truncated: false,
        },
      };
    });

    const result = await preparePanelContent(harness.args);

    expect(result).toMatchObject({
      kind: "ready",
      content: {
        payload: {
          text: "Video description",
          media: { hasVideo: true, hasAudio: true, hasCaptions: true },
        },
        transcriptTimedText: "",
      },
    });
    expect(harness.logPanel).toHaveBeenCalledWith("extract:message:ok", {
      source: "content-script",
    });
  });

  it("retries a stale routed extract and clears its routed metadata", async () => {
    const staleUrl = `${articleUrl}/stale`;
    const harness = createHarness();
    harness.routeExtractImpl.mockResolvedValueOnce({
      extracted: {
        ok: true,
        url: staleUrl,
        title: "Stale",
        text: "Stale body",
        truncated: false,
        media: null,
      },
      source: "url",
      diagnostics: { strategy: "daemon" },
    });

    const result = await preparePanelContent(harness.args);

    expect(result).toMatchObject({
      kind: "ready",
      content: {
        payload: { url: articleUrl, text: "Content body" },
        source: "page",
        diagnostics: null,
      },
    });
    expect(harness.extractFromTab).toHaveBeenCalledWith(
      7,
      defaultSettings.maxChars,
      expect.objectContaining({ inputMode: undefined }),
    );
  });

  it("enriches prepared video content with a current local transcript", async () => {
    const content: PreparedPanelContent = {
      payload: {
        ok: true,
        url: youtubeUrl,
        title: "Video",
        text: "Description",
        truncated: false,
        media: { hasVideo: true, hasAudio: true, hasCaptions: false },
      },
      title: "Video",
      transcriptTimedText: null,
      localTranscriptError: null,
      source: "page",
      diagnostics: null,
      prefersUrlMode: true,
    };
    const transcribeYouTubeLocally = vi.fn(async () => ({
      ok: true as const,
      url: youtubeUrl,
      text: "Local transcript",
      transcriptTimedText: "[0:00] Local transcript",
      truncated: false,
      durationSeconds: 42,
      mediaSource: "sabr" as const,
      diagnostics: browserMediaDiagnostics,
    }));
    const logPanel = vi.fn();

    const result = await ensurePreparedPanelTranscript({
      content,
      tab: { id: 7, url: youtubeUrl, title: "Video" },
      tabUrl: youtubeUrl,
      settings: defaultSettings,
      requestedInputMode: "video",
      sendStatus: vi.fn(),
      logPanel,
      urlsMatch: (left, right) => left === right,
      transcribeYouTubeLocally,
      transcribeMediaLocally: vi.fn(),
    });

    expect(result).toMatchObject({
      payload: {
        text: "Local transcript",
        mediaDurationSeconds: 42,
        media: { hasVideo: true, hasAudio: true, hasCaptions: false },
      },
      transcriptTimedText: "[0:00] Local transcript",
    });
    expect(logPanel).toHaveBeenCalledWith(
      "extract:url-direct:local-transcript",
      expect.objectContaining({ textLength: 16, mediaSource: "sabr" }),
    );
  });

  it("keeps prepared content when local transcription belongs to another URL", async () => {
    const content: PreparedPanelContent = {
      payload: {
        ok: true,
        url: articleUrl,
        title: "Media",
        text: "",
        truncated: false,
        media: { hasVideo: false, hasAudio: true, hasCaptions: false },
      },
      title: "Media",
      transcriptTimedText: null,
      localTranscriptError: null,
      source: "page",
      diagnostics: null,
      prefersUrlMode: false,
    };

    const result = await ensurePreparedPanelTranscript({
      content,
      tab: { id: 7, url: articleUrl, title: "Media" },
      tabUrl: articleUrl,
      settings: defaultSettings,
      requestedInputMode: "video",
      sendStatus: vi.fn(),
      logPanel: vi.fn(),
      urlsMatch: (left, right) => left === right,
      transcribeYouTubeLocally: vi.fn(),
      transcribeMediaLocally: vi.fn(async () => ({
        ok: true as const,
        url: `${articleUrl}/stale`,
        text: "Stale transcript",
        transcriptTimedText: "[0:00] Stale transcript",
        truncated: false,
        durationSeconds: 42,
        source: "direct" as const,
        diagnostics: browserMediaDiagnostics,
      })),
    });

    expect(result).toEqual({
      ...content,
      localTranscriptError: "The page changed before browser transcription completed",
      localTranscriptMessage: message("error.transcriptPageChanged"),
    });
  });

  it("keeps prepared content and logs a local transcription failure", async () => {
    const content: PreparedPanelContent = {
      payload: {
        ok: true,
        url: youtubeUrl,
        title: "Video",
        text: "",
        truncated: false,
        media: { hasVideo: true, hasAudio: true, hasCaptions: false },
      },
      title: "Video",
      transcriptTimedText: null,
      localTranscriptError: null,
      source: "page",
      diagnostics: null,
      prefersUrlMode: true,
    };
    const logPanel = vi.fn();

    const result = await ensurePreparedPanelTranscript({
      content,
      tab: { id: 7, url: youtubeUrl, title: "Video" },
      tabUrl: youtubeUrl,
      settings: defaultSettings,
      requestedInputMode: "video",
      sendStatus: vi.fn(),
      logPanel,
      urlsMatch: (left, right) => left === right,
      transcribeYouTubeLocally: vi.fn(async () => ({
        ok: false as const,
        error: "decoder unavailable",
      })),
      transcribeMediaLocally: vi.fn(),
    });

    expect(result).toEqual({
      ...content,
      localTranscriptError: "decoder unavailable",
    });
    expect(logPanel).toHaveBeenCalledWith("extract:url-direct:local-transcript-failed", {
      error: "decoder unavailable",
    });
  });

  it("disables daemon URL fallback for browser summaries", async () => {
    const harness = createHarness({ useBrowserSummary: true });

    await preparePanelContent(harness.args);

    expect(harness.routeExtractImpl).toHaveBeenCalledWith(
      expect.objectContaining({ allowDaemon: false }),
    );
  });
});
