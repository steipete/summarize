import { createSlidesHydrator } from "./slides-hydrator";
import { createSlidesRunRuntime } from "./slides-run-runtime";
import { createSlidesSummaryController } from "./slides-summary-controller";

export function createSidepanelSlidesRuntime({
  applySlidesPayload,
  clearSummarySource,
  friendlyFetchError,
  getActiveTabUrl,
  getInputMode,
  getInputModeOverride,
  getLengthValue,
  getPanelPhase,
  getPanelState,
  getSlidesEnabled,
  getToken,
  resolveLocalSlides,
  getTranscriptTimedText,
  getUiState,
  headerSetStatus,
  hideSlideNotice,
  isStreaming,
  panelUrlsMatch,
  refreshSummarizeControl,
  renderInlineSlidesFallback,
  renderMarkdown,
  schedulePanelCacheSync,
  setInputMode,
  setInputModeOverride,
  setSlidesBusy,
  setSlidesRunId,
  showSlideNotice,
  stopSlidesStream,
  stopSlidesSummaryStream,
  updateSlideSummaryFromMarkdown,
}: {
  applySlidesPayload: (
    data: Parameters<typeof createSlidesHydrator>[0]["onSlides"] extends (value: infer T) => void
      ? T
      : never,
  ) => void;
  clearSummarySource: () => void;
  friendlyFetchError: (error: unknown, fallback: string) => string;
  getActiveTabUrl: () => string | null;
  getInputMode: () => "page" | "video";
  getInputModeOverride: () => "page" | "video" | null;
  getLengthValue: () => string;
  getPanelPhase: () => "idle" | "connecting" | "streaming" | "error" | "setup";
  getPanelState: Parameters<typeof createSlidesSummaryController>[0]["getPanelState"];
  getSlidesEnabled: () => boolean;
  getToken: () => Promise<string>;
  resolveLocalSlides?: (
    runId: string,
  ) => Promise<
    Parameters<typeof createSlidesHydrator>[0]["onSlides"] extends (value: infer T) => void
      ? T | null
      : null
  >;
  getTranscriptTimedText: () => string | null;
  getUiState: Parameters<typeof createSlidesSummaryController>[0]["getUiState"];
  headerSetStatus: (text: string) => void;
  hideSlideNotice: () => void;
  isStreaming: () => boolean;
  panelUrlsMatch: Parameters<typeof createSlidesSummaryController>[0]["panelUrlsMatch"];
  refreshSummarizeControl: () => void;
  renderInlineSlidesFallback: () => void;
  renderMarkdown: (markdown: string) => void;
  schedulePanelCacheSync: () => void;
  setInputMode: (value: "page" | "video") => void;
  setInputModeOverride: (value: "page" | "video" | null) => void;
  setSlidesBusy: (value: boolean) => void;
  setSlidesRunId: (value: string | null) => void;
  showSlideNotice: (message: string, opts?: { allowRetry?: boolean }) => void;
  stopSlidesStream: () => void;
  stopSlidesSummaryStream: () => void;
  updateSlideSummaryFromMarkdown: Parameters<
    typeof createSlidesSummaryController
  >[0]["updateSlideSummaryFromMarkdown"];
}) {
  const slidesSummaryController = createSlidesSummaryController({
    getToken,
    friendlyFetchError,
    panelUrlsMatch,
    getPanelState,
    getUiState,
    getActiveTabUrl,
    getInputMode,
    getInputModeOverride,
    getSlidesEnabled,
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
      if (getPanelPhase() === "idle") {
        headerSetStatus("");
      }
    },
  });

  const slidesRunRuntime = createSlidesRunRuntime({
    getPanelPhase,
    getPanelState,
    getUiState,
    getActiveTabUrl,
    getInputMode,
    setInputMode,
    getInputModeOverride,
    setInputModeOverride,
    getSlidesEnabled,
    refreshSummarizeControl,
    stopSlidesStream,
    stopSlidesSummaryStream,
    hideSlideNotice,
    setSlidesBusy,
    schedulePanelCacheSync,
    startSlidesHydrator: (runId, opts) => {
      void slidesHydrator.start(runId, opts);
    },
    startSlidesSummaryController: (payload) => {
      void slidesSummaryController.start(payload);
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
    setSlidesRunId,
    headerSetStatus,
  });

  return {
    applySlidesSummaryMarkdown,
    handleSlidesStatus: slidesRunRuntime.handleSlidesStatus,
    maybeApplyPendingSlidesSummary,
    slidesHydrator,
    slidesSummaryController,
    startSlidesStream: slidesRunRuntime.startSlidesStream,
    startSlidesStreamForRunId: slidesRunRuntime.startSlidesStreamForRunId,
    startSlidesSummaryStreamForRunId: slidesRunRuntime.startSlidesSummaryStreamForRunId,
  };
}
