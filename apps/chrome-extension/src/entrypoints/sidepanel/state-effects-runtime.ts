import type { BgToPanel, UiState } from "../../lib/panel-contracts";
import type { SlidesLayout } from "../../lib/settings";
import type { createAppearanceControls } from "./appearance-controls";
import { createSidepanelBgMessageRuntime } from "./bg-message-runtime";
import type { createDaemonHintRuntime } from "./daemon-hint-runtime";
import type { SidepanelDom } from "./dom";
import type { PanelCachePayload } from "./panel-cache";
import type { createPanelMessagingRuntime } from "./panel-messaging";
import { patchPanelState } from "./panel-state-store";
import type { createSidepanelPresentationRuntime } from "./presentation-runtime";
import type { createSidepanelRunRuntime } from "./run-runtime";
import type { createSidepanelSessionRuntime } from "./session-runtime";
import type { createSetupControlsRuntime } from "./setup-controls-runtime";
import type { PanelState } from "./types";
import type { createTypographyController } from "./typography-controller";
import { createUiStateRuntime } from "./ui-state-runtime";

type AppearanceControls = ReturnType<typeof createAppearanceControls>;
type DaemonHintRuntime = ReturnType<typeof createDaemonHintRuntime>;
type PanelMessagingRuntime = ReturnType<typeof createPanelMessagingRuntime>;
type PresentationRuntime = ReturnType<typeof createSidepanelPresentationRuntime>;
type RunRuntime = ReturnType<typeof createSidepanelRunRuntime>;
type SessionRuntime = ReturnType<typeof createSidepanelSessionRuntime>;
type SetupControlsRuntime = ReturnType<typeof createSetupControlsRuntime>;
type TypographyController = ReturnType<typeof createTypographyController>;

export function createSidepanelStateEffectsRuntime({
  dom,
  panelState,

  appearanceControls,
  typographyController,
  panelMessagingRuntime,
  presentationRuntime,
  runRuntime,
  sessionRuntime,
  setupControlsRuntime,
  daemonHintRuntime,
}: {
  dom: SidepanelDom;
  panelState: PanelState;

  appearanceControls: AppearanceControls;
  typographyController: TypographyController;
  panelMessagingRuntime: PanelMessagingRuntime;
  presentationRuntime: PresentationRuntime;
  runRuntime: RunRuntime;
  sessionRuntime: SessionRuntime;
  setupControlsRuntime: SetupControlsRuntime;
  daemonHintRuntime: DaemonHintRuntime;
}) {
  const {
    isStreaming,
    panelCacheController,
    feedback: { errorController, headerController, hideSlideNotice, showSlideNotice },
    phase: { setPhase },
    slides: {
      controlRuntime: summarizeControlRuntime,
      refreshSummarizeControl,
      renderInlineSlides,
      runtime: slidesRuntime,
      setSlidesTranscriptTimedText,
      updateSlideSummaryFromMarkdown,
      viewRuntime: slidesViewRuntime,
    },
  } = presentationRuntime;
  const {
    maybeApplyPendingSlidesSummary,
    maybeStartPendingSlidesForUrl,
    rememberPendingSlidesRun,
    resolveActiveSlidesRunId,
    startSlidesStreamForRunId,
    startSlidesSummaryStreamForRunId,
    refreshBrowserAiSlides,
  } = slidesRuntime;
  const { rebuildSlideDescriptions, renderMarkdownDisplay, setSlidesBusy, updateSlidesTextState } =
    slidesViewRuntime;
  const { setSlidesLayout } = summarizeControlRuntime;
  const { plannedSlidesRuntime, streamController, summaryRunRuntime } = runRuntime;
  const { applyPanelCache, chatRuntime, navigationRuntime, resetPanelView } = sessionRuntime;
  const { handleLocalSlidesResponse, send } = panelMessagingRuntime;
  const {
    isRefreshFreeRunning,
    maybeShowSetup,
    readCurrentModelValue,
    setModelValue,
    updateModelRowUI,
  } = setupControlsRuntime;

  const uiStateRuntime = createUiStateRuntime({
    panelState,

    appearanceControls,
    typographyController,
    navigationRuntime,
    panelCacheController,
    headerController,
    clearInlineError: errorController.clearInlineError,
    requestAgentAbort: chatRuntime.requestAbort,
    clearChatHistoryForActiveTab: chatRuntime.clearHistoryForActiveTab,
    migrateChatHistory: chatRuntime.migrateHistory,
    maybeStartPendingSummaryRunForUrl: summaryRunRuntime.maybeStartPendingForUrl,
    maybeStartPendingSlidesForUrl,
    requestSlidesCapture: () => {
      void send({ type: "panel:slides-capture" });
    },
    resolveActiveSlidesRunId,
    applyPanelCache,
    resetSummaryView: resetPanelView,
    abortSummaryStream: streamController.abort,
    hideAutomationNotice: chatRuntime.hideAutomationNotice,
    hideSlideNotice,
    maybeApplyPendingSlidesSummary,
    applyChatEnabled: chatRuntime.applyEnabled,
    restoreChatHistory: chatRuntime.restoreHistory,
    rebuildSlideDescriptions,
    renderInlineSlides,
    setSlidesLayout: (value) => {
      setSlidesLayout(value as SlidesLayout);
    },
    maybeSeedPlannedSlidesForPendingRun: plannedSlidesRuntime.maybeSeedPendingRun,
    refreshSummarizeControl,
    updateDaemonHint: daemonHintRuntime.update,
    maybeShowSetup,
    setPhase,
    renderMarkdownDisplay,
    readCurrentModelValue,
    setModelValue,
    updateModelRowUI,
    isRefreshFreeRunning,
    setModelRefreshDisabled: (value) => {
      dom.modelRefreshBtn.disabled = value;
    },
    renderMarkdownHostEl: dom.renderMarkdownHostEl,
    isStreaming,
    onSlidesOcrChanged: updateSlidesTextState,
  });

  const applyUiState = (state: UiState) => {
    uiStateRuntime.apply(state);
  };

  const bgMessageRuntime = createSidepanelBgMessageRuntime({
    panelState,

    applyUiState,
    setStatus: headerController.setStatus,
    isStreaming,
    setPhase,
    finishStreamingMessage: chatRuntime.finishStreamingMessage,
    setSlidesBusy,
    showSlideNotice,
    getActiveTabUrl: () => panelState.navigation.activeTabUrl,
    rememberPendingSlidesRun,
    startSlidesStreamForRunId,
    startSlidesSummaryStreamForRunId: (runId, url) => {
      startSlidesSummaryStreamForRunId(runId, url ?? null);
    },
    handleSlidesLocal: handleLocalSlidesResponse,
    getSlidesContextRequestId: () => panelState.slidesSession.slidesContextRequestId,
    setSlidesContextPending: (value) => {
      patchPanelState(panelState, "slidesSession", { slidesContextPending: value });
    },
    setSlidesTranscriptTimedText,
    updateSlidesTextState,
    refreshBrowserAiSlides,
    updateSlideSummaryFromMarkdown,
    renderInlineSlidesFallback: () => {
      renderInlineSlides(dom.renderMarkdownHostEl, { fallback: true });
    },
    schedulePanelCacheSync: panelCacheController.scheduleSync,
    consumeUiCache: panelCacheController.consumeResponse,
    clearPanelCache: panelCacheController.clear,
    getActiveTabId: () => panelState.navigation.activeTabId,
    applyPanelCache: (cache, options) => {
      applyPanelCache(cache as PanelCachePayload, options);
    },
    rememberPendingSummaryRun: summaryRunRuntime.rememberPendingRun,
    rememberPendingSummarySnapshot: summaryRunRuntime.rememberPendingSnapshot,
    attachSummaryRun: summaryRunRuntime.attachRun,
    applySummarySnapshot: summaryRunRuntime.applySnapshot,
    handleChatHistory: chatRuntime.handleHistory,
    handleAgentChunk: chatRuntime.handleAgentChunk,
    handleAgentResponse: chatRuntime.handleAgentResponse,
  });

  return {
    applyUiState,
    handleBgMessage(message: BgToPanel) {
      bgMessageRuntime.handle(message);
    },
  };
}
