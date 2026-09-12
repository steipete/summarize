import {
  createBrowserAiSlidesRuntime,
  shouldUseBrowserAiForSlides,
} from "./browser-ai-slides-runtime";
import type { createBrowserAiSummaryRuntime } from "./browser-ai-summary-runtime";
import { createSlidesHydrator } from "./slides-hydrator";
import { createSlidesRunRuntime } from "./slides-run-runtime";
import { createSlidesSummaryController } from "./slides-summary-controller";
import type { PanelState } from "./types";

export function createSidepanelSlidesRuntime({
  applySlidesPayload,
  browserAi,
  clearSummarySource,
  panelState,

  friendlyFetchError,
  getLengthValue,
  getToken,
  resolveLocalSlides,
  getTranscriptTimedText,
  headerSetStatus,
  hideSlideNotice,
  isStreaming,
  panelUrlsMatch,
  refreshSummarizeControl,
  renderInlineSlidesFallback,
  renderMarkdown,
  schedulePanelCacheSync,
  setSlidesBusy,
  showSlideNotice,
  updateSlideSummaryFromMarkdown,
}: {
  applySlidesPayload: (
    data: Parameters<typeof createSlidesHydrator>[0]["onSlides"] extends (value: infer T) => void
      ? T
      : never,
  ) => void;
  browserAi: ReturnType<typeof createBrowserAiSummaryRuntime>;
  clearSummarySource: () => void;
  panelState: PanelState;

  friendlyFetchError: (error: unknown, fallback: string) => string;
  getLengthValue: () => string;
  getToken: () => Promise<string>;
  resolveLocalSlides?: (
    runId: string,
  ) => Promise<
    Parameters<typeof createSlidesHydrator>[0]["onSlides"] extends (value: infer T) => void
      ? T | null
      : null
  >;
  getTranscriptTimedText: () => string | null;
  headerSetStatus: (text: string) => void;
  hideSlideNotice: () => void;
  isStreaming: () => boolean;
  panelUrlsMatch: Parameters<typeof createSlidesSummaryController>[0]["panelUrlsMatch"];
  refreshSummarizeControl: () => void;
  renderInlineSlidesFallback: () => void;
  renderMarkdown: (markdown: string) => void;
  schedulePanelCacheSync: () => void;
  setSlidesBusy: (value: boolean) => void;
  showSlideNotice: (message: string, opts?: { allowRetry?: boolean }) => void;
  updateSlideSummaryFromMarkdown: Parameters<
    typeof createSlidesSummaryController
  >[0]["updateSlideSummaryFromMarkdown"];
}) {
  const slidesSummaryController = createSlidesSummaryController({
    getToken,

    friendlyFetchError,
    panelUrlsMatch,
    getPanelState: () => panelState,
    getUiState: () => panelState.ui,
    getActiveTabUrl: () => panelState.navigation.activeTabUrl,
    getInputMode: () => panelState.slidesSession.inputMode,
    getInputModeOverride: () => panelState.slidesSession.inputModeOverride,
    getSlidesEnabled: () => panelState.slidesSession.slidesEnabled,
    getLengthValue,
    getTranscriptTimedText,
    clearSummarySource,
    updateSlideSummaryFromMarkdown,
    renderMarkdown,
    renderInlineSlidesFallback,
  });

  const applySlidesSummaryMarkdown = (markdown: string) => {
    slidesSummaryController.applyMarkdown(markdown);
  };

  const maybeApplyPendingSlidesSummary = () => {
    slidesSummaryController.maybeApplyPending();
  };

  const browserAiSlidesRuntime = createBrowserAiSlidesRuntime({
    panelState,
    browserAi,
    getTranscriptTimedText,
    applyGeneratedSummary: slidesSummaryController.applyGeneratedSummary,
    schedulePanelCacheSync,
  });

  const slidesHydrator = createSlidesHydrator({
    getToken,
    resolveLocalSlides,
    onSlides: (data) => {
      applySlidesPayload(data);
      slidesSummaryController.maybeApplyPending();
      const markdown = slidesSummaryController.getMarkdown();
      if (markdown.trim()) {
        slidesSummaryController.applyMarkdown(markdown);
      }
    },
    onStatus: (text) => {
      slidesRunRuntime.handleSlidesStatus(text);
    },
    onError: (err) => {
      const message = friendlyFetchError(err, "Slides stream failed");
      showSlideNotice(message, { allowRetry: true });
      setSlidesBusy(false);
      if (!isStreaming()) {
        headerSetStatus("");
      }
      void slidesHydrator.hydrateSnapshot("timeout");
      return message;
    },
    onSnapshotError: (err) => {
      const message = err instanceof Error ? err.message : String(err);
      console.debug("[summarize] slides snapshot failed", message);
    },
    onDone: () => {
      setSlidesBusy(false);
      if (panelState.phase === "idle") {
        headerSetStatus("");
      }
    },
  });

  const slidesRunRuntime = createSlidesRunRuntime({
    panelState,

    refreshSummarizeControl,
    hideSlideNotice,
    setSlidesBusy,
    schedulePanelCacheSync,
    isSlidesHydratorStreaming: slidesHydrator.isStreaming,
    startSlidesHydrator: (runId, opts) => {
      void slidesHydrator.start(runId, opts);
    },
    stopSlidesHydrator: slidesHydrator.stop,
    startSlidesSummaryController: (payload) => {
      browserAiSlidesRuntime.cancel();
      void slidesSummaryController.start(payload);
    },
    stopSlidesSummaryController: () => {
      browserAiSlidesRuntime.cancel();
      slidesSummaryController.stop();
    },
    getSlidesSummaryRunId: () => slidesSummaryController.getRunId(),
    setSlidesSummaryRunId: (value) => {
      slidesSummaryController.setRunId(value);
    },
    setSlidesSummaryUrl: (value) => {
      slidesSummaryController.setUrl(value);
    },
    resetSlidesSummaryState: () => {
      slidesSummaryController.resetSummaryState();
    },
    setSlidesSummaryModel: (value) => {
      slidesSummaryController.setModel(value);
    },
    shouldUseBrowserAiSlides: () => shouldUseBrowserAiForSlides(panelState),
    headerSetStatus,
  });

  return {
    applySlidesSummaryMarkdown,
    handleSlidesStatus: slidesRunRuntime.handleSlidesStatus,
    maybeApplyPendingSlidesSummary,
    refreshBrowserAiSlides: browserAiSlidesRuntime.refresh,
    slidesHydrator,
    isActiveSlidesRunLocal: slidesRunRuntime.isActiveSlidesRunLocal,
    maybeStartPendingSlidesForUrl: slidesRunRuntime.maybeStartPendingSlidesForUrl,
    rememberPendingSlidesRun: slidesRunRuntime.rememberPendingSlidesRun,
    resolveActiveSlidesRunId: slidesRunRuntime.resolveActiveSlidesRunId,
    startSlidesStream: slidesRunRuntime.startSlidesStream,
    startSlidesStreamForRunId: slidesRunRuntime.startSlidesStreamForRunId,
    startSlidesSummaryStreamForRunId: slidesRunRuntime.startSlidesSummaryStreamForRunId,
    stopSlidesStream: slidesRunRuntime.stopSlidesStream,
  };
}
