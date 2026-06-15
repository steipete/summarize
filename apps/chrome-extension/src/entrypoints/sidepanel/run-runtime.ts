import type { PanelToBg } from "../../lib/panel-contracts";
import { loadSettings } from "../../lib/settings";
import type { createAppearanceControls } from "./appearance-controls";
import { createAutoSummarizeRuntime } from "./auto-summarize-runtime";
import { createBrowserAiSnapshotRuntime } from "./browser-ai-snapshot-runtime";
import type { createSidepanelChatRuntime } from "./chat-runtime";
import type { HeaderController } from "./header-controller";
import type { createMetricsController } from "./metrics-controller";
import type { NavigationRuntime } from "./navigation-runtime";
import type { PanelCacheController } from "./panel-cache";
import type { PanelStateAction } from "./panel-state-store";
import { createPlannedSlidesRuntime } from "./planned-slides-runtime";
import type { createSidepanelPresentationRuntime } from "./presentation-runtime";
import { friendlyFetchError } from "./setup-runtime";
import { createSummaryRunRuntime } from "./summary-run-runtime";
import { createSummaryStreamRuntime } from "./summary-stream-runtime";
import type { PanelState } from "./types";

type AppearanceControls = Pick<ReturnType<typeof createAppearanceControls>, "getLengthValue">;

type ChatRuntime = Pick<
  ReturnType<typeof createSidepanelChatRuntime>,
  "clearHistoryForActiveTab" | "finishStreamingMessage" | "reset"
>;

type MetricsController = Pick<
  ReturnType<typeof createMetricsController>,
  "setActiveMode" | "setForMode"
>;

type PresentationRuntime = ReturnType<typeof createSidepanelPresentationRuntime>;

export function createSidepanelRunRuntime({
  panelState,
  dispatchPanelState,
  getActiveTabId,
  getActiveTabUrl,
  appearanceControls,
  chatRuntime,
  navigationRuntime,
  metricsController,
  headerController,
  panelCacheController,
  presentationRuntime,
  send,
  syncWithActiveTab,
}: {
  panelState: PanelState;
  dispatchPanelState: (action: PanelStateAction) => void;
  getActiveTabId: () => number | null;
  getActiveTabUrl: () => string | null;
  appearanceControls: AppearanceControls;
  chatRuntime: ChatRuntime;
  navigationRuntime: Pick<NavigationRuntime, "shouldPreserveChatForRun">;
  metricsController: MetricsController;
  headerController: HeaderController;
  panelCacheController: PanelCacheController;
  presentationRuntime: PresentationRuntime;
  send: (message: PanelToBg) => Promise<void>;
  syncWithActiveTab: () => Promise<void>;
}) {
  const {
    isStreaming,
    phase: { setPhase },
    summary: { renderMarkdown, sendSummarize, viewRuntime: summaryViewRuntime },
    slides: {
      runtime: slidesRuntime,
      setSlidesTranscriptTimedText,
      textController: slidesTextController,
      viewRuntime: slidesViewRuntime,
    },
  } = presentationRuntime;
  const { maybeApplyPendingSlidesSummary, slidesHydrator, startSlidesStream, stopSlidesStream } =
    slidesRuntime;
  const {
    queueSlidesRender,
    rebuildSlideDescriptions,
    renderMarkdownDisplay,
    setSlidesBusy,
    updateSlidesTextState,
  } = slidesViewRuntime;

  const plannedSlidesRuntime = createPlannedSlidesRuntime({
    panelState,
    dispatchPanelState,
    getActiveTabUrl,
    getLengthValue: appearanceControls.getLengthValue,
    updateSlidesTextState,
    queueSlidesRender,
    schedulePanelCacheSync: panelCacheController.scheduleSync,
  });

  const summaryStreamRuntime = createSummaryStreamRuntime({
    friendlyFetchError,
    getFallbackModel: () => panelState.ui?.settings.model ?? null,
    getToken: async () => (await loadSettings()).token,
    handleSlides: slidesHydrator.handlePayload,
    handleSummaryFromCache: slidesHydrator.handleSummaryFromCache,
    headerArmProgress: headerController.armProgress,
    headerSetBaseSubtitle: headerController.setBaseSubtitle,
    headerSetBaseTitle: headerController.setBaseTitle,
    headerSetStatus: headerController.setStatus,
    headerStopProgress: headerController.stopProgress,
    isStreaming,
    maybeApplyPendingSlidesSummary,
    panelState,
    dispatchPanelState,
    queueSlidesRender,
    rebuildSlideDescriptions,
    refreshSummaryMetrics: (summary) => {
      metricsController.setForMode(
        "summary",
        summary,
        panelState.lastMeta.inputSummary,
        panelState.currentSource?.url ?? null,
      );
      metricsController.setActiveMode("summary");
    },
    rememberUrl: (url) => {
      void send({ type: "panel:rememberUrl", url });
    },
    renderMarkdown,
    resetSummaryView: summaryViewRuntime.resetSummaryView,
    schedulePanelCacheSync: panelCacheController.scheduleSync,
    seedPlannedSlidesForPendingRun: plannedSlidesRuntime.seedPendingRunAndConsumeWhenReady,
    setSlidesBusy,
    setPhase,
    shouldRebuildSlideDescriptions: () => !slidesTextController.hasSummaryTitles(),
    syncWithActiveTab,
  });
  const { streamController } = summaryStreamRuntime;

  const autoSummarizeRuntime = createAutoSummarizeRuntime({
    getEnabled: () => panelState.panelSession.autoSummarize,
    getPhase: () => panelState.phase,
    hasSummary: () => Boolean(panelState.summaryMarkdown),
    summarize: sendSummarize,
  });
  const browserAiSnapshotRuntime = createBrowserAiSnapshotRuntime({
    panelState,
    dispatchPanelState,
    browserAi: presentationRuntime.summary.browserAiRuntime,
    renderMarkdown,
  });

  const summaryRunRuntime = createSummaryRunRuntime({
    panelState,
    dispatchPanelState,
    getActiveTabId,
    cancelAutoSummarize: autoSummarizeRuntime.cancel,
    summaryStream: {
      isStreaming: streamController.isStreaming,
      start: streamController.start,
    },
    slides: {
      queueRender: queueSlidesRender,
      seedPlannedRun: plannedSlidesRuntime.seedForRun,
      setTranscriptTimedText: setSlidesTranscriptTimedText,
      start: startSlidesStream,
      stop: stopSlidesStream,
      updateTextState: updateSlidesTextState,
    },
    chat: {
      clearHistory: chatRuntime.clearHistoryForActiveTab,
      finishStreamingMessage: chatRuntime.finishStreamingMessage,
      reset: chatRuntime.reset,
      shouldPreserveForRun: navigationRuntime.shouldPreserveChatForRun,
    },
    view: {
      queueEmptyRender: renderMarkdownDisplay,
      renderMarkdown,
      reset: summaryViewRuntime.resetSummaryView,
      setHeaderSubtitle: headerController.setBaseSubtitle,
      setHeaderTitle: headerController.setBaseTitle,
      setMetricsMode: metricsController.setActiveMode,
      setPhase,
    },
    browserAi: browserAiSnapshotRuntime,
  });

  return {
    autoSummarizeRuntime,
    plannedSlidesRuntime,
    streamController,
    summaryRunRuntime,
  };
}
