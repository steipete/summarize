import type { PanelToBg } from "../../lib/panel-contracts";
import { syncNavigationWithActiveTab } from "./active-tab-sync";
import { createSidepanelChatRuntime } from "./chat-runtime";
import type { SidepanelDom } from "./dom";
import type { createMetricsController } from "./metrics-controller";
import { createNavigationRuntime } from "./navigation-runtime";
import { patchPanelState } from "./panel-state-store";
import { createPanelViewRuntime } from "./panel-view-runtime";
import type { createSidepanelPresentationRuntime } from "./presentation-runtime";
import type { PanelState } from "./types";

type MetricsController = Pick<
  ReturnType<typeof createMetricsController>,
  "clearForMode" | "setActiveMode"
>;

type PresentationRuntime = ReturnType<typeof createSidepanelPresentationRuntime>;

type RunActions = {
  abortSummaryStream: () => void;
};

export function createSidepanelSessionRuntime({
  dom,
  panelState,

  metricsController,
  presentationRuntime,
  send,
}: {
  dom: SidepanelDom;
  panelState: PanelState;

  metricsController: MetricsController;
  presentationRuntime: PresentationRuntime;
  send: (message: PanelToBg) => Promise<void>;
}) {
  const {
    markdown,
    panelCacheController,
    feedback: { errorController, headerController },
    phase: { setPhase },
    summary: { viewRuntime: summaryViewRuntime },
    slides: { renderInlineSlides, runtime: slidesRuntime },
  } = presentationRuntime;
  const navigationRuntime = createNavigationRuntime({
    getState: () => panelState.navigation,
    updateState: (value) => {
      patchPanelState(panelState, "navigation", value);
    },
  });

  const getActiveTabId = () => panelState.navigation.activeTabId;
  const getActiveTabUrl = () => panelState.navigation.activeTabUrl;
  const chatRuntime = createSidepanelChatRuntime({
    panelState,

    markdown,
    mainEl: dom.mainEl,
    renderEl: dom.renderEl,
    chatContainerEl: dom.chatContainerEl,
    chatContextStatusEl: dom.chatContextStatusEl,
    chatDockEl: dom.chatDockEl,
    chatInputEl: dom.chatInputEl,
    chatJumpBtn: dom.chatJumpBtn,
    chatMessagesEl: dom.chatMessagesEl,
    chatQueueEl: dom.chatQueueEl,
    chatSendBtn: dom.chatSendBtn,
    automationNoticeActionBtn: dom.automationNoticeActionBtn,
    automationNoticeEl: dom.automationNoticeEl,
    automationNoticeMessageEl: dom.automationNoticeMessageEl,
    automationNoticeTitleEl: dom.automationNoticeTitleEl,
    getActiveTabId,
    getActiveTabUrl,
    navigationRuntime,
    send,
    setStatus: headerController.setStatus,
    clearErrors: errorController.clearAll,
    showInlineError: errorController.showInlineError,
    clearChatMetrics: () => {
      metricsController.clearForMode("chat");
    },
    setChatMetricsMode: () => {
      metricsController.setActiveMode("chat");
    },
    setLastActionChat: () => {
      patchPanelState(panelState, "panelSession", { lastAction: "chat" });
    },
    renderInlineSlides: () => {
      renderInlineSlides(dom.chatMessagesEl);
    },
    seekToTimestamp: (seconds) => {
      void send({ type: "panel:seek", seconds });
    },
  });

  const panelViewRuntime = createPanelViewRuntime({
    summaryView: summaryViewRuntime,
    resetChatState: chatRuntime.reset,
  });
  const { applyPanelCache, resetPanelView } = panelViewRuntime;

  const syncWithActiveTab = () =>
    syncNavigationWithActiveTab({
      navigationRuntime,
      getCurrentSource: () => panelState.currentSource,
      setCurrentSource: (source) => {
        panelState.currentSource = source;
      },
      resetForNavigation: (preserveChat) => {
        setPhase("idle");
        resetPanelView({ preserveChat });
        headerController.setBaseSubtitle("");
      },
      setBaseTitle: headerController.setBaseTitle,
    });

  let runActions: RunActions | null = null;

  const bindRunActions = (actions: RunActions) => {
    if (runActions) throw new Error("sidepanel session run actions already bound");
    runActions = actions;
  };

  const clearCurrentView = async () => {
    panelState.retainedSlideSummary = null;
    if (panelState.chat.streaming) {
      chatRuntime.requestAbort("Cleared");
    }
    runActions?.abortSummaryStream();
    slidesRuntime.stopSlidesStream();
    resetPanelView();
    await chatRuntime.clearHistoryForActiveTab();
    panelCacheController.scheduleSync();
    headerController.setStatus("");
    setPhase("idle");
  };

  return {
    applyPanelCache,
    bindRunActions,
    chatRuntime,
    clearCurrentView,
    navigationRuntime,
    resetPanelView,
    syncWithActiveTab,
  };
}
