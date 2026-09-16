import { message as uiMessage, type LocalizedText } from "../../lib/i18n";
import { planMediaExtraction } from "../../lib/media-extraction-plan";
import type { BgToPanel, PanelCachePayload } from "../../lib/panel-contracts";

type BrowserSlidesSession = {
  windowId: number;
};

type BrowserSlidesSettings = {
  autoSummarize: boolean;
  maxChars: number;
  slideRuntime: "browser" | "daemon";
  slidesEnabled: boolean;
};

export type BrowserSlidesStartOptions = {
  inputMode?: "page" | "video";
  reason?: string;
};

type SummarizeOptions = {
  refresh?: boolean;
  inputMode?: "page" | "video";
};

export function createBrowserSlidesRuntime<Session extends BrowserSlidesSession>(options: {
  loadSettings: () => Promise<BrowserSlidesSettings>;
  getActiveTab: (windowId: number) => Promise<chrome.tabs.Tab | null>;
  canSummarizeUrl: (url: string | undefined) => url is string;
  panelSessionStore: {
    getPanelCache(tabId: number, url?: string | null): PanelCachePayload | null;
  };
  send: (session: Session, message: BgToPanel) => void;
  sendStatus: (session: Session, status: LocalizedText) => void;
  summarizeActiveTab: (session: Session, reason: string, options?: SummarizeOptions) => unknown;
  runBrowserSlidesForTab: typeof import("./browser-slides").runBrowserSlidesForTab;
  extractYouTubeTranscriptInTab: typeof import("./youtube-transcript").extractYouTubeTranscriptInTab;
  beginSlideFrameCaptureInTab: typeof import("./content-script-bridge").beginSlideFrameCaptureInTab;
  prepareSlideFrameInTab: typeof import("./content-script-bridge").prepareSlideFrameInTab;
  prepareCurrentSlideFrameInTab: typeof import("./content-script-bridge").prepareCurrentSlideFrameInTab;
  restoreSlideFrameInTab: typeof import("./content-script-bridge").restoreSlideFrameInTab;
  getPrimaryMediaInfoInTab: typeof import("./content-script-bridge").getPrimaryMediaInfoInTab;
  logExtensionEvent: typeof import("../../lib/extension-logs").logExtensionEvent;
}) {
  const {
    loadSettings,
    getActiveTab,
    canSummarizeUrl,
    panelSessionStore,
    send,
    sendStatus,
    summarizeActiveTab,
    runBrowserSlidesForTab,
    extractYouTubeTranscriptInTab,
    beginSlideFrameCaptureInTab,
    prepareSlideFrameInTab,
    prepareCurrentSlideFrameInTab,
    restoreSlideFrameInTab,
    getPrimaryMediaInfoInTab,
    logExtensionEvent,
  } = options;
  const inFlightByWindowId = new Map<number, { key: string; userInitiated: boolean }>();
  const retryByWindowId = new Map<number, BrowserSlidesStartOptions>();

  const setDebugResult = (value: unknown) => {
    (
      globalThis as typeof globalThis & {
        __summarizeBrowserSlidesLastResult?: unknown;
      }
    ).__summarizeBrowserSlidesLastResult = value;
  };

  async function start(session: Session, startOptions: BrowserSlidesStartOptions): Promise<void> {
    const tab = await getActiveTab(session.windowId);
    const tabUrl = tab?.url ?? "";
    const extractionPlan = planMediaExtraction({
      url: tabUrl,
      requestedInputMode: startOptions.inputMode,
    });
    const inputMode = extractionPlan.inputMode;
    const canAttemptBrowserCapture =
      extractionPlan.isYouTubeVideo ||
      startOptions.inputMode === "video" ||
      startOptions.reason === "slides-capture";
    if (inputMode !== "video") return;
    if (!canAttemptBrowserCapture) {
      setDebugResult({ ok: false, error: "skipped: browser capture requires video" });
      return;
    }

    const settings = await loadSettings();
    const isUserInitiatedCapture =
      startOptions.reason === "manual" ||
      startOptions.reason === "refresh" ||
      startOptions.reason === "length-change" ||
      startOptions.reason === "slides-capture";
    if (
      !isUserInitiatedCapture &&
      startOptions.reason !== "cache-restore" &&
      !settings.autoSummarize
    ) {
      setDebugResult({ ok: false, error: "skipped: auto summarize disabled" });
      return;
    }
    if (!settings.slidesEnabled) {
      setDebugResult({ ok: false, error: "skipped: slides disabled" });
      return;
    }
    if (settings.slideRuntime !== "browser") {
      setDebugResult({ ok: false, error: "skipped: daemon runtime selected" });
      return;
    }
    if (!tab?.id || !canSummarizeUrl(tab.url)) {
      setDebugResult({ ok: false, error: "skipped: no capturable active tab" });
      return;
    }

    const cachedPanel = panelSessionStore.getPanelCache(tab.id, tab.url ?? null);
    if (!isUserInitiatedCapture && cachedPanel?.slides?.slides?.length) {
      setDebugResult({ ok: false, error: "skipped: slides already cached" });
      return;
    }

    const captureKey = tab.url ?? String(tab.id);
    const activeCapture = inFlightByWindowId.get(session.windowId);
    if (activeCapture) {
      if (
        activeCapture.key !== captureKey ||
        (isUserInitiatedCapture && !activeCapture.userInitiated)
      ) {
        retryByWindowId.set(session.windowId, startOptions);
      }
      return;
    }

    inFlightByWindowId.set(session.windowId, {
      key: captureKey,
      userInitiated: isUserInitiatedCapture,
    });
    sendStatus(session, uiMessage("progress.captureSlides"));
    delete (
      globalThis as typeof globalThis & {
        __summarizeBrowserMediaFallback?: string;
      }
    ).__summarizeBrowserMediaFallback;

    let result: Awaited<ReturnType<typeof runBrowserSlidesForTab>>;
    try {
      const transcript = extractionPlan.isYouTubeVideo
        ? await extractYouTubeTranscriptInTab(tab.id, settings.maxChars)
        : null;
      result = await runBrowserSlidesForTab({
        tab,
        windowId: session.windowId,
        beginFrameCapture: beginSlideFrameCaptureInTab,
        prepareFrame: prepareSlideFrameInTab,
        prepareCurrentFrame: prepareCurrentSlideFrameInTab,
        restoreFrame: restoreSlideFrameInTab,
        getMediaInfo: getPrimaryMediaInfoInTab,
        transcriptTimedText: transcript?.ok ? transcript.transcriptTimedText : null,
        captureMode: isUserInitiatedCapture ? "seek" : "current",
        onStatus: (status) => sendStatus(session, status),
        onMediaDecoderFallback: (error) => {
          (
            globalThis as typeof globalThis & {
              __summarizeBrowserMediaFallback?: string;
            }
          ).__summarizeBrowserMediaFallback = error;
          logExtensionEvent({
            event: "slides.browser-media.fallback",
            detail: { error, url: tabUrl },
            scope: "slides",
            level: "verbose",
          });
          sendStatus(session, uiMessage("progress.captureSlides"));
        },
      });
    } catch (error) {
      result = {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      };
    } finally {
      if (inFlightByWindowId.get(session.windowId)?.key === captureKey) {
        inFlightByWindowId.delete(session.windowId);
      }
    }

    const retry = retryByWindowId.get(session.windowId) ?? null;
    if (retry) retryByWindowId.delete(session.windowId);
    setDebugResult(result);
    if (!result.ok) {
      if (retry) {
        void start(session, retry);
        return;
      }
      send(session, { type: "slides:run", ok: false, error: result.error });
      sendStatus(session, uiMessage("error.slidesFailed", { error: result.error }));
      return;
    }

    send(session, {
      type: "slides:run",
      ok: true,
      runId: result.runId,
      url: result.slides.sourceUrl,
      local: true,
    });
    sendStatus(session, "");
    if (retry) void start(session, retry);
  }

  function summarize(session: Session, reason: string, summarizeOptions?: SummarizeOptions): void {
    void summarizeActiveTab(session, reason, summarizeOptions);
    void start(session, {
      inputMode: summarizeOptions?.inputMode,
      reason,
    });
  }

  return { start, summarize };
}
