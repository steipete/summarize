import { afterEach, describe, expect, it, vi } from "vitest";
import { createBrowserSlidesRuntime } from "../apps/chrome-extension/src/entrypoints/background/browser-slides-runtime.js";
import { message } from "../apps/chrome-extension/src/lib/i18n";
import type { PanelCachePayload } from "../apps/chrome-extension/src/lib/panel-contracts.js";

const session = { windowId: 3 };
const defaultTab = {
  id: 7,
  url: "https://example.com/video",
  title: "Example video",
} as chrome.tabs.Tab;
const defaultSettings = {
  autoSummarize: true,
  maxChars: 120_000,
  slideRuntime: "browser" as const,
  slidesEnabled: true,
};
const slides = {
  sourceUrl: defaultTab.url ?? "",
  sourceId: "browser-run-1",
  sourceKind: "browser-capture",
  slideRuntime: "browser" as const,
  ocrAvailable: false,
  transcriptTimedText: null,
  slides: [
    {
      index: 1,
      timestamp: 1,
      imageUrl: "data:image/jpeg;base64,AQID",
      ocrText: null,
      ocrConfidence: null,
    },
  ],
};
const successResult = {
  ok: true as const,
  runId: "browser-run-1",
  slides,
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((nextResolve) => {
    resolve = nextResolve;
  });
  return { promise, resolve };
}

function createHarness({
  activeTab = defaultTab,
  cachedPanel = null,
  settings = {},
}: {
  activeTab?: chrome.tabs.Tab | null;
  cachedPanel?: PanelCachePayload | null;
  settings?: Partial<typeof defaultSettings>;
} = {}) {
  const send = vi.fn();
  const sendStatus = vi.fn();
  const summarizeActiveTab = vi.fn();
  const runBrowserSlidesForTab = vi.fn(async () => successResult);
  const extractYouTubeTranscriptInTab = vi.fn(async () => ({
    ok: false as const,
    error: "no transcript",
  }));
  const logExtensionEvent = vi.fn();
  const panelSessionStore = {
    getPanelCache: vi.fn(() => cachedPanel),
  };
  const runtime = createBrowserSlidesRuntime({
    loadSettings: vi.fn(async () => ({ ...defaultSettings, ...settings })),
    getActiveTab: vi.fn(async () => activeTab),
    canSummarizeUrl: (url): url is string => Boolean(url?.startsWith("http")),
    panelSessionStore,
    send,
    sendStatus,
    summarizeActiveTab,
    runBrowserSlidesForTab: runBrowserSlidesForTab as never,
    extractYouTubeTranscriptInTab: extractYouTubeTranscriptInTab as never,
    beginSlideFrameCaptureInTab: vi.fn() as never,
    prepareSlideFrameInTab: vi.fn() as never,
    prepareCurrentSlideFrameInTab: vi.fn() as never,
    restoreSlideFrameInTab: vi.fn() as never,
    getPrimaryMediaInfoInTab: vi.fn() as never,
    logExtensionEvent,
  });

  return {
    runtime,
    send,
    sendStatus,
    summarizeActiveTab,
    runBrowserSlidesForTab,
    extractYouTubeTranscriptInTab,
    logExtensionEvent,
    panelSessionStore,
  };
}

function debugResult() {
  return (
    globalThis as typeof globalThis & {
      __summarizeBrowserSlidesLastResult?: unknown;
    }
  ).__summarizeBrowserSlidesLastResult;
}

afterEach(() => {
  vi.restoreAllMocks();
  delete (
    globalThis as typeof globalThis & {
      __summarizeBrowserSlidesLastResult?: unknown;
      __summarizeBrowserMediaFallback?: string;
    }
  ).__summarizeBrowserSlidesLastResult;
  delete (
    globalThis as typeof globalThis & {
      __summarizeBrowserSlidesLastResult?: unknown;
      __summarizeBrowserMediaFallback?: string;
    }
  ).__summarizeBrowserMediaFallback;
});

describe("chrome browser slides runtime", () => {
  it("does nothing for page-mode requests", async () => {
    const harness = createHarness();

    await harness.runtime.start(session, {
      inputMode: "page",
      reason: "manual",
    });

    expect(harness.runBrowserSlidesForTab).not.toHaveBeenCalled();
    expect(harness.sendStatus).not.toHaveBeenCalled();
    expect(debugResult()).toBeUndefined();
  });

  it("rejects inferred direct-media capture without explicit video intent", async () => {
    const harness = createHarness({
      activeTab: {
        id: 7,
        url: "https://cdn.example.com/video.mp4",
      } as chrome.tabs.Tab,
    });

    await harness.runtime.start(session, { reason: "navigation" });

    expect(debugResult()).toEqual({
      ok: false,
      error: "skipped: browser capture requires video",
    });
    expect(harness.runBrowserSlidesForTab).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: "automatic capture is disabled",
      settings: { autoSummarize: false },
      activeTab: defaultTab,
      reason: "navigation",
      cachedPanel: null,
      error: "skipped: auto summarize disabled",
    },
    {
      name: "slides are disabled",
      settings: { slidesEnabled: false },
      activeTab: defaultTab,
      reason: "manual",
      cachedPanel: null,
      error: "skipped: slides disabled",
    },
    {
      name: "daemon runtime is selected",
      settings: { slideRuntime: "daemon" as const },
      activeTab: defaultTab,
      reason: "manual",
      cachedPanel: null,
      error: "skipped: daemon runtime selected",
    },
    {
      name: "the active tab is not capturable",
      settings: {},
      activeTab: { id: 7, url: "chrome://settings" } as chrome.tabs.Tab,
      reason: "manual",
      cachedPanel: null,
      error: "skipped: no capturable active tab",
    },
    {
      name: "automatic slides are already cached",
      settings: {},
      activeTab: defaultTab,
      reason: "navigation",
      cachedPanel: {
        slides: { slides: [{ index: 1 }] },
      } as PanelCachePayload,
      error: "skipped: slides already cached",
    },
  ])("skips when $name", async ({ settings, activeTab, reason, cachedPanel, error }) => {
    const harness = createHarness({
      settings,
      activeTab,
      cachedPanel,
    });

    await harness.runtime.start(session, {
      inputMode: "video",
      reason,
    });

    expect(debugResult()).toEqual({ ok: false, error });
    expect(harness.runBrowserSlidesForTab).not.toHaveBeenCalled();
  });

  it("captures YouTube slides with transcript and forwards progress and fallback events", async () => {
    const youtubeTab = {
      id: 11,
      url: "https://www.youtube.com/watch?v=demo",
      title: "Demo",
    } as chrome.tabs.Tab;
    const harness = createHarness({ activeTab: youtubeTab });
    harness.extractYouTubeTranscriptInTab.mockResolvedValueOnce({
      ok: true,
      url: youtubeTab.url ?? "",
      text: "Transcript",
      transcriptTimedText: "0:01 Transcript",
      truncated: false,
      durationSeconds: 30,
    });
    harness.runBrowserSlidesForTab.mockImplementationOnce(async (options) => {
      options.onStatus?.("Preparing frames");
      options.onMediaDecoderFallback?.("decoder failed");
      return {
        ...successResult,
        slides: {
          ...slides,
          sourceUrl: youtubeTab.url ?? "",
        },
      };
    });

    await harness.runtime.start(session, { reason: "manual" });

    expect(harness.extractYouTubeTranscriptInTab).toHaveBeenCalledWith(11, 120_000);
    expect(harness.runBrowserSlidesForTab).toHaveBeenCalledWith(
      expect.objectContaining({
        tab: youtubeTab,
        windowId: 3,
        transcriptTimedText: "0:01 Transcript",
        captureMode: "seek",
      }),
    );
    expect(harness.sendStatus).toHaveBeenCalledWith(session, "Preparing frames");
    expect(harness.sendStatus).toHaveBeenCalledWith(session, message("progress.captureSlides"));
    expect(harness.logExtensionEvent).toHaveBeenCalledWith({
      event: "slides.browser-media.fallback",
      detail: { error: "decoder failed", url: youtubeTab.url },
      scope: "slides",
      level: "verbose",
    });
    expect(
      (
        globalThis as typeof globalThis & {
          __summarizeBrowserMediaFallback?: string;
        }
      ).__summarizeBrowserMediaFallback,
    ).toBe("decoder failed");
    expect(harness.send).toHaveBeenCalledWith(session, {
      type: "slides:run",
      ok: true,
      runId: "browser-run-1",
      url: youtubeTab.url,
      local: true,
    });
    expect(harness.sendStatus).toHaveBeenLastCalledWith(session, "");
    expect(debugResult()).toEqual(
      expect.objectContaining({
        ok: true,
        runId: "browser-run-1",
      }),
    );
  });

  it("uses current-frame mode for automatic capture", async () => {
    const harness = createHarness();

    await harness.runtime.start(session, {
      inputMode: "video",
      reason: "navigation",
    });

    expect(harness.extractYouTubeTranscriptInTab).not.toHaveBeenCalled();
    expect(harness.runBrowserSlidesForTab).toHaveBeenCalledWith(
      expect.objectContaining({
        captureMode: "current",
        transcriptTimedText: null,
      }),
    );
  });

  it("reports capture failures through slide and status protocols", async () => {
    const harness = createHarness();
    harness.runBrowserSlidesForTab.mockResolvedValueOnce({
      ok: false,
      error: "capture failed",
    });

    await harness.runtime.start(session, {
      inputMode: "video",
      reason: "manual",
    });

    expect(harness.send).toHaveBeenCalledWith(session, {
      type: "slides:run",
      ok: false,
      error: "capture failed",
    });
    expect(harness.sendStatus).toHaveBeenLastCalledWith(
      session,
      message("error.slidesFailed", { error: "capture failed" }),
    );
    expect(debugResult()).toEqual({
      ok: false,
      error: "capture failed",
    });
  });

  it("normalizes thrown capture failures", async () => {
    const harness = createHarness();
    harness.runBrowserSlidesForTab.mockRejectedValueOnce("capture threw");

    await harness.runtime.start(session, {
      inputMode: "video",
      reason: "manual",
    });

    expect(harness.send).toHaveBeenCalledWith(session, {
      type: "slides:run",
      ok: false,
      error: "capture threw",
    });
  });

  it("queues a newer capture while one is in flight", async () => {
    const firstResult = deferred<typeof successResult>();
    const secondTab = {
      id: 8,
      url: "https://example.com/next-video",
      title: "Next video",
    } as chrome.tabs.Tab;
    const harness = createHarness();
    const getActiveTab = vi
      .fn()
      .mockResolvedValueOnce(defaultTab)
      .mockResolvedValueOnce(secondTab)
      .mockResolvedValue(secondTab);
    const runtime = createBrowserSlidesRuntime({
      loadSettings: vi.fn(async () => defaultSettings),
      getActiveTab,
      canSummarizeUrl: (url): url is string => Boolean(url?.startsWith("http")),
      panelSessionStore: harness.panelSessionStore,
      send: harness.send,
      sendStatus: harness.sendStatus,
      summarizeActiveTab: harness.summarizeActiveTab,
      runBrowserSlidesForTab: vi
        .fn()
        .mockImplementationOnce(async () => firstResult.promise)
        .mockResolvedValue(successResult) as never,
      extractYouTubeTranscriptInTab: harness.extractYouTubeTranscriptInTab as never,
      beginSlideFrameCaptureInTab: vi.fn() as never,
      prepareSlideFrameInTab: vi.fn() as never,
      prepareCurrentSlideFrameInTab: vi.fn() as never,
      restoreSlideFrameInTab: vi.fn() as never,
      getPrimaryMediaInfoInTab: vi.fn() as never,
      logExtensionEvent: harness.logExtensionEvent,
    });

    const first = runtime.start(session, {
      inputMode: "video",
      reason: "navigation",
    });
    await vi.waitFor(() => {
      expect(getActiveTab).toHaveBeenCalledTimes(1);
    });
    await runtime.start(session, {
      inputMode: "video",
      reason: "manual",
    });
    firstResult.resolve(successResult);
    await first;

    await vi.waitFor(() => {
      expect(getActiveTab).toHaveBeenCalledTimes(3);
      expect(harness.send).toHaveBeenCalledTimes(2);
    });
    expect(harness.send).toHaveBeenNthCalledWith(2, session, {
      type: "slides:run",
      ok: true,
      runId: "browser-run-1",
      url: slides.sourceUrl,
      local: true,
    });
  });

  it("suppresses a stale failure when a queued capture can replace it", async () => {
    const firstResult = deferred<{ ok: false; error: string }>();
    const harness = createHarness();
    const runBrowserSlidesForTab = vi
      .fn()
      .mockImplementationOnce(async () => firstResult.promise)
      .mockResolvedValue(successResult);
    const runtime = createBrowserSlidesRuntime({
      loadSettings: vi.fn(async () => defaultSettings),
      getActiveTab: vi.fn(async () => defaultTab),
      canSummarizeUrl: (url): url is string => Boolean(url?.startsWith("http")),
      panelSessionStore: harness.panelSessionStore,
      send: harness.send,
      sendStatus: harness.sendStatus,
      summarizeActiveTab: harness.summarizeActiveTab,
      runBrowserSlidesForTab: runBrowserSlidesForTab as never,
      extractYouTubeTranscriptInTab: harness.extractYouTubeTranscriptInTab as never,
      beginSlideFrameCaptureInTab: vi.fn() as never,
      prepareSlideFrameInTab: vi.fn() as never,
      prepareCurrentSlideFrameInTab: vi.fn() as never,
      restoreSlideFrameInTab: vi.fn() as never,
      getPrimaryMediaInfoInTab: vi.fn() as never,
      logExtensionEvent: harness.logExtensionEvent,
    });

    const first = runtime.start(session, {
      inputMode: "video",
      reason: "navigation",
    });
    await vi.waitFor(() => {
      expect(runBrowserSlidesForTab).toHaveBeenCalledTimes(1);
    });
    await runtime.start(session, {
      inputMode: "video",
      reason: "manual",
    });
    firstResult.resolve({ ok: false, error: "stale failure" });
    await first;

    await vi.waitFor(() => {
      expect(runBrowserSlidesForTab).toHaveBeenCalledTimes(2);
      expect(harness.send).toHaveBeenCalledTimes(1);
    });
    expect(harness.send).toHaveBeenCalledWith(session, {
      type: "slides:run",
      ok: true,
      runId: "browser-run-1",
      url: slides.sourceUrl,
      local: true,
    });
    expect(harness.send).not.toHaveBeenCalledWith(
      session,
      expect.objectContaining({ ok: false, error: "stale failure" }),
    );
  });

  it("does not queue an identical automatic request", async () => {
    const pending = deferred<typeof successResult>();
    const harness = createHarness();
    harness.runBrowserSlidesForTab.mockImplementationOnce(async () => pending.promise);

    const first = harness.runtime.start(session, {
      inputMode: "video",
      reason: "navigation",
    });
    await vi.waitFor(() => {
      expect(harness.runBrowserSlidesForTab).toHaveBeenCalledTimes(1);
    });
    await harness.runtime.start(session, {
      inputMode: "video",
      reason: "navigation",
    });
    pending.resolve(successResult);
    await first;
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(harness.runBrowserSlidesForTab).toHaveBeenCalledTimes(1);
    expect(harness.send).toHaveBeenCalledTimes(1);
  });

  it("fans summary requests out to summary and slide runtimes", async () => {
    const harness = createHarness();

    harness.runtime.summarize(session, "refresh", {
      refresh: true,
      inputMode: "video",
    });

    expect(harness.summarizeActiveTab).toHaveBeenCalledWith(session, "refresh", {
      refresh: true,
      inputMode: "video",
    });
    await vi.waitFor(() => {
      expect(harness.runBrowserSlidesForTab).toHaveBeenCalledTimes(1);
    });
  });
});
