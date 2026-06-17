import { afterEach, describe, expect, it, vi } from "vitest";
import { createBrowserAiSlidesRuntime } from "../apps/chrome-extension/src/entrypoints/sidepanel/browser-ai-slides-runtime";
import { createInitialPanelState } from "../apps/chrome-extension/src/entrypoints/sidepanel/panel-state-store";
import type { PanelState, UiState } from "../apps/chrome-extension/src/entrypoints/sidepanel/types";
import { defaultSettings } from "../apps/chrome-extension/src/lib/settings";

function buildUiState(overrides: Partial<UiState["settings"]> = {}): UiState {
  return {
    panelOpen: true,
    daemon: { ok: false, authed: false },
    tab: { id: 1, url: "https://www.youtube.com/watch?v=test", title: "Lecture" },
    media: { hasVideo: true, hasAudio: true, hasCaptions: true },
    stats: { pageWords: null, videoDurationSeconds: 180 },
    settings: {
      autoSummarize: true,
      hoverSummaries: false,
      chatEnabled: true,
      automationEnabled: false,
      slidesEnabled: true,
      slidesParallel: true,
      slidesOcrEnabled: false,
      slidesLayout: "gallery",
      slideRuntime: "browser",
      summaryRuntime: "direct",
      providerConfigured: false,
      daemonHintDismissed: false,
      fontSize: 14,
      lineHeight: 1.45,
      model: "auto",
      length: "long",
      tokenPresent: false,
      ...overrides,
    },
    status: "",
  };
}

function buildPanelState(): PanelState {
  const panelState = createInitialPanelState();
  panelState.ui = buildUiState();
  panelState.currentSource = {
    url: "https://www.youtube.com/watch?v=test",
    title: "Machine Learning Lecture",
  };
  panelState.slidesRunId = "slides-run";
  panelState.slides = {
    sourceUrl: panelState.currentSource.url,
    sourceId: "browser-slides",
    sourceKind: "youtube",
    slideRuntime: "browser",
    ocrAvailable: false,
    transcriptTimedText:
      "[00:00] The first section explains linear decision boundaries and classification.\n" +
      "[01:00] The second section derives the sigmoid function and probability model.",
    slides: [
      { index: 1, timestamp: 0, imageUrl: "", ocrText: "" },
      { index: 2, timestamp: 60, imageUrl: "", ocrText: "" },
    ],
  };
  return panelState;
}

describe("sidepanel browser AI slides runtime", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("builds canonical per-slide Nano summaries instead of transcript fallbacks", async () => {
    const panelState = buildPanelState();
    if (!panelState.slides) throw new Error("Missing slides fixture");
    panelState.slides.slides[0]!.imageUrl = "data:image/jpeg;base64,one";
    panelState.slides.slides[1]!.imageUrl = "data:image/jpeg;base64,two";
    const images = new Map([
      ["data:image/jpeg;base64,one", new Blob(["one"], { type: "image/jpeg" })],
      ["data:image/jpeg;base64,two", new Blob(["two"], { type: "image/jpeg" })],
    ]);
    const applyGeneratedSummary = vi.fn((value) => {
      panelState.slidesSummary = {
        ...panelState.slidesSummary,
        ...value,
      };
    });
    const prompt = vi.fn(async () => ({
      kind: "success" as const,
      text:
        "[slide:1] Linear classifiers divide examples with a learned decision boundary.\n" +
        "[slide:2] The sigmoid maps scores into probabilities for logistic regression.",
      contextUsage: 400,
      contextWindow: 9_216,
    }));
    const summarize = vi.fn();
    const runtime = createBrowserAiSlidesRuntime({
      panelState,
      browserAi: {
        cancel: vi.fn(),
        prompt,
        summarize,
      },
      getTranscriptTimedText: () => panelState.slides?.transcriptTimedText ?? null,
      applyGeneratedSummary,
      schedulePanelCacheSync: vi.fn(),
      loadSlideImage: vi.fn(async (imageUrl) => images.get(imageUrl) ?? null),
    });

    await runtime.refresh();

    expect(prompt).toHaveBeenCalledOnce();
    expect(prompt).toHaveBeenCalledWith(
      expect.objectContaining({
        requestKey: "slides",
        status: "Summarizing slides 1–2 with on-device AI…",
      }),
    );
    const promptInput = prompt.mock.calls[0]?.[0]?.input;
    expect(promptInput).toEqual([
      {
        role: "user",
        content: expect.arrayContaining([
          expect.objectContaining({ type: "text", value: expect.stringContaining("INDEX 1") }),
          { type: "image", value: images.get("data:image/jpeg;base64,one") },
          expect.objectContaining({ type: "text", value: expect.stringContaining("INDEX 2") }),
          { type: "image", value: images.get("data:image/jpeg;base64,two") },
        ]),
      },
    ]);
    expect(summarize).not.toHaveBeenCalled();
    const final = applyGeneratedSummary.mock.calls.at(-1)?.[0];
    expect(final).toEqual(
      expect.objectContaining({
        complete: true,
        model: "Gemini Nano",
        runId: "slides-run",
      }),
    );
    expect(final?.markdown).toContain("[slide:1]\n## Linear classifiers divide examples");
    expect(final?.markdown).toContain("[slide:2]\n## The sigmoid maps scores into");
    expect(final?.markdown).not.toContain("The first section explains");

    await runtime.refresh();
    expect(prompt).toHaveBeenCalledOnce();
  });

  it("does not use Nano when a direct provider model is selected", async () => {
    const panelState = buildPanelState();
    panelState.ui = buildUiState({
      model: "openai/gpt-5-mini",
      providerConfigured: true,
    });
    const summarize = vi.fn();
    const runtime = createBrowserAiSlidesRuntime({
      panelState,
      browserAi: {
        cancel: vi.fn(),
        prompt: vi.fn(),
        summarize,
      },
      getTranscriptTimedText: () => panelState.slides?.transcriptTimedText ?? null,
      applyGeneratedSummary: vi.fn(),
      schedulePanelCacheSync: vi.fn(),
    });

    await runtime.refresh();

    expect(summarize).not.toHaveBeenCalled();
  });

  it("keeps daemon slide summaries for default Auto and preserves copy when Nano is unavailable", async () => {
    const daemonState = buildPanelState();
    if (!daemonState.slides) throw new Error("Missing slides fixture");
    daemonState.slides.slideRuntime = "daemon";
    const daemonSummarize = vi.fn();
    const daemonRuntime = createBrowserAiSlidesRuntime({
      panelState: daemonState,
      browserAi: {
        cancel: vi.fn(),
        prompt: vi.fn(),
        summarize: daemonSummarize,
      },
      getTranscriptTimedText: () => daemonState.slides?.transcriptTimedText ?? null,
      applyGeneratedSummary: vi.fn(),
      schedulePanelCacheSync: vi.fn(),
    });

    await daemonRuntime.refresh();
    expect(daemonSummarize).not.toHaveBeenCalled();

    const browserState = buildPanelState();
    const applyGeneratedSummary = vi.fn();
    const prompt = vi.fn(async () => null);
    const summarize = vi.fn(async () => null);
    const browserRuntime = createBrowserAiSlidesRuntime({
      panelState: browserState,
      browserAi: {
        cancel: vi.fn(),
        prompt,
        summarize,
      },
      getTranscriptTimedText: () => browserState.slides?.transcriptTimedText ?? null,
      applyGeneratedSummary,
      schedulePanelCacheSync: vi.fn(),
    });

    await browserRuntime.refresh();
    expect(prompt).toHaveBeenCalledOnce();
    expect(summarize).toHaveBeenCalledTimes(2);
    expect(applyGeneratedSummary).not.toHaveBeenCalled();
  });

  it("splits a batch when Chrome reports context pressure", async () => {
    const panelState = buildPanelState();
    const prompt = vi
      .fn()
      .mockResolvedValueOnce({
        kind: "too-large",
        contextUsage: 10_000,
        contextWindow: 9_216,
      })
      .mockResolvedValueOnce({
        kind: "success",
        text: "[slide:1] Linear classifiers learn a decision boundary.",
        contextUsage: 300,
        contextWindow: 9_216,
      })
      .mockResolvedValueOnce({
        kind: "success",
        text: "[slide:2] The sigmoid converts scores into probabilities.",
        contextUsage: 300,
        contextWindow: 9_216,
      });
    const summarize = vi.fn();
    const applyGeneratedSummary = vi.fn();
    const runtime = createBrowserAiSlidesRuntime({
      panelState,
      browserAi: {
        cancel: vi.fn(),
        prompt,
        summarize,
      },
      getTranscriptTimedText: () => panelState.slides?.transcriptTimedText ?? null,
      applyGeneratedSummary,
      schedulePanelCacheSync: vi.fn(),
    });

    await runtime.refresh();

    expect(prompt).toHaveBeenCalledTimes(3);
    expect(summarize).not.toHaveBeenCalled();
    expect(applyGeneratedSummary.mock.calls.at(-1)?.[0]).toEqual(
      expect.objectContaining({
        complete: true,
        markdown: expect.stringContaining("[slide:2]"),
      }),
    );
  });

  it("only sends the daemon token to the fixed daemon slide origin", async () => {
    const panelState = buildPanelState();
    if (!panelState.slides) throw new Error("Missing slides fixture");
    panelState.slides.slides[0]!.imageUrl = "http://127.0.0.1:8787/v1/slides/run/1";
    panelState.slides.slides[1]!.imageUrl = "http://localhost:9999/v1/slides/run/2";
    const settingsResult = {
      settings: {
        ...defaultSettings,
        token: "daemon-secret",
      },
    };
    vi.stubGlobal("chrome", {
      storage: {
        local: {
          get: vi.fn((_key: string, callback: (value: typeof settingsResult) => void) => {
            callback(settingsResult);
            return Promise.resolve(settingsResult);
          }),
        },
      },
    });
    const fetchMock = vi.fn(async () => ({
      ok: true,
      blob: async () => new Blob(["image"], { type: "image/jpeg" }),
    }));
    vi.stubGlobal("fetch", fetchMock);
    const runtime = createBrowserAiSlidesRuntime({
      panelState,
      browserAi: {
        cancel: vi.fn(),
        prompt: vi.fn(async () => ({
          kind: "success" as const,
          text:
            "[slide:1] The first frame contains a decision boundary.\n" +
            "[slide:2] The second frame contains a sigmoid curve.",
          contextUsage: 400,
          contextWindow: 9_216,
        })),
        summarize: vi.fn(),
      },
      getTranscriptTimedText: () => panelState.slides?.transcriptTimedText ?? null,
      applyGeneratedSummary: vi.fn(),
      schedulePanelCacheSync: vi.fn(),
    });

    await runtime.refresh();

    const daemonCall = fetchMock.mock.calls.find(([url]) => String(url).includes("127.0.0.1:8787"));
    const untrustedCall = fetchMock.mock.calls.find(([url]) =>
      String(url).includes("localhost:9999"),
    );
    const daemonHeaders = new Headers(daemonCall?.[1]?.headers);
    const untrustedHeaders = new Headers(untrustedCall?.[1]?.headers);
    expect(daemonHeaders.get("Authorization")).toBe("Bearer daemon-secret");
    expect(untrustedHeaders.get("Authorization")).toBeNull();
  });
});
