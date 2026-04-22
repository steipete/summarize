import { shouldPreferUrlMode } from "@steipete/summarize-core/content/url";
import type { PanelCachePayload } from "./panel-cache";
import {
  resolvePanelNavigationDecision,
  shouldIgnoreTransientPanelTabState,
  shouldInvalidateCurrentSource,
} from "./session-policy";
import type { ChatMessage, PanelPhase, PanelState, UiState } from "./types";

type AppearanceControlsLike = {
  setAutoValue: (value: boolean) => void;
  syncLengthFromState: (value: string) => boolean;
  getFontFamily: () => string;
};

type TypographyControllerLike = {
  getCurrentFontSize: () => number;
  getCurrentLineHeight: () => number;
  apply: (fontFamily: string, fontSize: number, lineHeight: number) => void;
  setCurrentFontSize: (value: number) => void;
  setCurrentLineHeight: (value: number) => void;
};

type HeaderControllerLike = {
  setBaseTitle: (value: string) => void;
  setBaseSubtitle: (value: string) => void;
  setStatus: (value: string) => void;
};

type NavigationRuntimeLike = {
  isRecentAgentNavigation: (tabId: number | null, url: string | null) => boolean;
  notePreserveChatForUrl: (url: string | null) => void;
  getLastAgentNavigationUrl: () => string | null;
};

type ChatControllerLike = {
  getMessages: () => ChatMessage[];
};

type PanelCacheControllerLike = {
  resolve: (tabId: number, url: string) => PanelCachePayload | null;
  request: (tabId: number, url: string, preserveChat: boolean) => void;
};

type UiStateRuntimeOpts = {
  panelState: PanelState;
  chatController: ChatControllerLike;
  appearanceControls: AppearanceControlsLike;
  typographyController: TypographyControllerLike;
  navigationRuntime: NavigationRuntimeLike;
  panelCacheController: PanelCacheControllerLike;
  headerController: HeaderControllerLike;
  clearInlineError: () => void;
  requestAgentAbort: (reason: string) => void;
  clearChatHistoryForActiveTab: () => void | Promise<void>;
  resetChatState: () => void;
  migrateChatHistory: (
    fromTabId: number | null,
    toTabId: number | null,
    toUrl: string | null,
  ) => void | Promise<void>;
  maybeStartPendingSummaryRunForUrl: (url: string | null) => boolean;
  maybeStartPendingSlidesForUrl: (url: string | null) => void;
  resolveActiveSlidesRunId: () => string | null;
  applyPanelCache: (payload: PanelCachePayload, opts?: { preserveChat?: boolean }) => void;
  resetSummaryView: (opts?: { preserveChat?: boolean }) => void;
  hideAutomationNotice: () => void;
  hideSlideNotice: () => void;
  maybeApplyPendingSlidesSummary: () => void;
  applyChatEnabled: () => void;
  restoreChatHistory: () => void | Promise<void>;
  rebuildSlideDescriptions: () => void;
  renderInlineSlides: (container: HTMLElement, opts?: { fallback?: boolean }) => void;
  setSlidesLayout: (value: string) => void;
  maybeSeedPlannedSlidesForPendingRun: () => void;
  refreshSummarizeControl: () => void;
  maybeShowSetup: (state: UiState) => boolean;
  setPhase: (phase: PanelPhase, opts?: { error?: string | null }) => void;
  renderMarkdownDisplay: () => void;
  readCurrentModelValue: () => string;
  setModelValue: (value: string) => void;
  updateModelRowUI: () => void;
  isRefreshFreeRunning: () => boolean;
  setModelRefreshDisabled: (value: boolean) => void;
  renderMarkdownHostEl: HTMLElement;
  getActiveTabId: () => number | null;
  setActiveTabId: (value: number | null) => void;
  getActiveTabUrl: () => string | null;
  setActiveTabUrl: (value: string | null) => void;
  getCurrentRunTabId: () => number | null;
  setCurrentRunTabId: (value: number | null) => void;
  getLastPanelOpen: () => boolean;
  setLastPanelOpen: (value: boolean) => void;
  getAutoValue: () => boolean;
  setAutoValue: (value: boolean) => void;
  getChatEnabledValue: () => boolean;
  setChatEnabledValue: (value: boolean) => void;
  setAutomationEnabledValue: (value: boolean) => void;
  getAutomationEnabledValue: () => boolean;
  setSlidesEnabledValue: (value: boolean) => void;
  getSlidesEnabledValue: () => boolean;
  setSlidesParallelValue: (value: boolean) => void;
  getSlidesParallelValue: () => boolean;
  setSlidesOcrEnabledValue: (value: boolean) => void;
  getSlidesOcrEnabledValue: () => boolean;
  getInputMode: () => "page" | "video";
  setInputMode: (value: "page" | "video") => void;
  getInputModeOverride: () => "page" | "video" | null;
  setInputModeOverride: (value: "page" | "video" | null) => void;
  getMediaAvailable: () => boolean;
  setMediaAvailable: (value: boolean) => void;
  getSlidesLayoutValue: () => string;
  setSummarizeVideoLabel: (value: string) => void;
  setSummarizePageWords: (value: number | null) => void;
  setSummarizeVideoDurationSeconds: (value: number | null) => void;
  isStreaming: () => boolean;
  getSlidesBusy: () => boolean;
  onSlidesOcrChanged: () => void;
};

function applyCachedOrReset(
  opts: Pick<
    UiStateRuntimeOpts,
    | "panelState"
    | "panelCacheController"
    | "applyPanelCache"
    | "resetSummaryView"
    | "setCurrentRunTabId"
  >,
  tabId: number | null,
  url: string | null,
  preserveChat: boolean,
) {
  if (tabId && url) {
    const cached = opts.panelCacheController.resolve(tabId, url);
    if (cached) {
      opts.applyPanelCache(cached, { preserveChat });
    } else {
      opts.panelState.currentSource = null;
      opts.setCurrentRunTabId(null);
      opts.resetSummaryView({ preserveChat });
      opts.panelCacheController.request(tabId, url, preserveChat);
    }
    return;
  }

  opts.panelState.currentSource = null;
  opts.setCurrentRunTabId(null);
  opts.resetSummaryView({ preserveChat });
}

export function createUiStateRuntime(opts: UiStateRuntimeOpts) {
  function apply(state: UiState) {
    if (state.panelOpen && !opts.getLastPanelOpen()) {
      opts.clearInlineError();
    }
    opts.setLastPanelOpen(state.panelOpen);

    const activeTabId = opts.getActiveTabId();
    const activeTabUrl = opts.getActiveTabUrl();
    const currentSource = opts.panelState.currentSource;
    const inputModeOverride = opts.getInputModeOverride();
    const inputMode = opts.getInputMode();
    const mediaAvailable = opts.getMediaAvailable();
    const chatEnabledValue = opts.getChatEnabledValue();
    const slidesLayoutValue = opts.getSlidesLayoutValue();

    const ignoreTransientTabState = shouldIgnoreTransientPanelTabState({
      nextTabUrl: state.tab.url ?? null,
      activeTabUrl,
      currentSourceUrl: currentSource?.url ?? null,
    });
    const nextTabId = ignoreTransientTabState ? activeTabId : (state.tab.id ?? null);
    const nextTabUrl = ignoreTransientTabState ? activeTabUrl : (state.tab.url ?? null);
    const nextTabTitle = ignoreTransientTabState
      ? (currentSource?.title ?? null)
      : (state.tab.title ?? null);
    const preferUrlMode = nextTabUrl ? shouldPreferUrlMode(nextTabUrl) : false;
    const hasActiveChat =
      opts.panelState.chatStreaming ||
      opts.chatController.getMessages().length > 0 ||
      opts.getChatEnabledValue();
    const hasMediaInfo = state.media != null;
    const mediaFromState = Boolean(state.media && (state.media.hasVideo || state.media.hasAudio));
    const preserveChatForTab =
      (activeTabId === null && nextTabId !== null && hasActiveChat) ||
      opts.navigationRuntime.isRecentAgentNavigation(nextTabId, nextTabUrl);
    const preserveChatForUrl =
      (activeTabUrl === null && nextTabUrl !== null && hasActiveChat) ||
      opts.navigationRuntime.isRecentAgentNavigation(activeTabId, nextTabUrl);
    const navigation = resolvePanelNavigationDecision({
      activeTabId,
      activeTabUrl,
      nextTabId,
      nextTabUrl,
      hasActiveChat,
      chatEnabled: chatEnabledValue,
      preserveChat: nextTabId !== activeTabId ? preserveChatForTab : preserveChatForUrl,
      preferUrlMode,
      inputModeOverride,
    });
    const nextMediaAvailable = hasMediaInfo
      ? mediaFromState || preferUrlMode
      : navigation.kind !== "none"
        ? preferUrlMode
        : mediaAvailable || preferUrlMode;
    const nextVideoLabel = state.media?.hasAudio && !state.media.hasVideo ? "Audio" : "Video";

    if (navigation.kind === "tab") {
      if (navigation.preserveChat) {
        opts.navigationRuntime.notePreserveChatForUrl(
          nextTabUrl ?? opts.navigationRuntime.getLastAgentNavigationUrl(),
        );
      }
      const previousTabId = activeTabId;
      opts.setActiveTabId(nextTabId);
      opts.setActiveTabUrl(nextTabUrl);
      if (opts.panelState.chatStreaming && navigation.shouldAbortChatStream) {
        opts.requestAgentAbort("Tab changed");
      }
      if (navigation.shouldClearChat) {
        void opts.clearChatHistoryForActiveTab();
        opts.resetChatState();
      } else if (navigation.shouldMigrateChat) {
        void opts.migrateChatHistory(previousTabId, nextTabId, nextTabUrl);
      }
      if (navigation.nextInputMode) {
        opts.setInputMode(navigation.nextInputMode);
      }
      if (navigation.resetInputModeOverride) {
        opts.setInputModeOverride(null);
      }
      if (!opts.maybeStartPendingSummaryRunForUrl(nextTabUrl)) {
        applyCachedOrReset(opts, nextTabId, nextTabUrl, navigation.preserveChat);
      }
    } else if (navigation.kind === "url") {
      opts.setActiveTabUrl(nextTabUrl);
      if (navigation.preserveChat) {
        opts.navigationRuntime.notePreserveChatForUrl(nextTabUrl);
      } else if (navigation.shouldClearChat) {
        void opts.clearChatHistoryForActiveTab();
        opts.resetChatState();
      }
      if (!opts.maybeStartPendingSummaryRunForUrl(nextTabUrl)) {
        applyCachedOrReset(opts, opts.getActiveTabId(), nextTabUrl, navigation.preserveChat);
      }
      if (navigation.nextInputMode) {
        opts.setInputMode(navigation.nextInputMode);
      }
    }

    opts.setAutoValue(state.settings.autoSummarize);
    opts.appearanceControls.setAutoValue(state.settings.autoSummarize);
    opts.setChatEnabledValue(state.settings.chatEnabled);
    opts.setAutomationEnabledValue(state.settings.automationEnabled);
    opts.setSlidesEnabledValue(state.settings.slidesEnabled);
    opts.setSlidesParallelValue(state.settings.slidesParallel);
    const nextSlidesOcrEnabled = Boolean(state.settings.slidesOcrEnabled);
    if (nextSlidesOcrEnabled !== opts.getSlidesOcrEnabledValue()) {
      opts.setSlidesOcrEnabledValue(nextSlidesOcrEnabled);
      opts.onSlidesOcrChanged();
    }
    const fallbackModel =
      typeof state.settings.model === "string" ? state.settings.model.trim() : "";
    if (
      fallbackModel &&
      (!opts.panelState.lastMeta.model || !opts.panelState.lastMeta.model.trim())
    ) {
      opts.panelState.lastMeta = {
        ...opts.panelState.lastMeta,
        model: fallbackModel,
        modelLabel: fallbackModel,
      };
    }
    if (opts.getSlidesEnabledValue() && nextMediaAvailable) {
      opts.setInputMode("video");
      opts.setInputModeOverride("video");
    }
    if (state.settings.slidesLayout && state.settings.slidesLayout !== slidesLayoutValue) {
      opts.setSlidesLayout(state.settings.slidesLayout);
    }
    if (opts.getAutomationEnabledValue()) opts.hideAutomationNotice();
    if (!opts.getSlidesEnabledValue()) opts.hideSlideNotice();
    if (
      opts.getSlidesEnabledValue() &&
      (opts.getInputModeOverride() ?? opts.getInputMode()) === "video"
    ) {
      opts.maybeApplyPendingSlidesSummary();
      opts.maybeStartPendingSummaryRunForUrl(nextTabUrl ?? null);
      opts.maybeStartPendingSlidesForUrl(nextTabUrl ?? null);
    }
    opts.applyChatEnabled();
    if (
      opts.getChatEnabledValue() &&
      opts.getActiveTabId() &&
      opts.chatController.getMessages().length === 0
    ) {
      void opts.restoreChatHistory();
    }
    if (opts.appearanceControls.syncLengthFromState(state.settings.length)) {
      opts.rebuildSlideDescriptions();
      if (opts.panelState.summaryMarkdown) {
        opts.renderInlineSlides(opts.renderMarkdownHostEl, { fallback: true });
      }
    }
    if (
      state.settings.fontSize !== opts.typographyController.getCurrentFontSize() ||
      state.settings.lineHeight !== opts.typographyController.getCurrentLineHeight()
    ) {
      opts.typographyController.apply(
        opts.appearanceControls.getFontFamily(),
        state.settings.fontSize,
        state.settings.lineHeight,
      );
      opts.typographyController.setCurrentFontSize(state.settings.fontSize);
      opts.typographyController.setCurrentLineHeight(state.settings.lineHeight);
    }
    if (opts.readCurrentModelValue() !== state.settings.model) {
      opts.setModelValue(state.settings.model);
    }
    opts.updateModelRowUI();
    opts.setModelRefreshDisabled(!state.settings.tokenPresent || opts.isRefreshFreeRunning());
    if (opts.panelState.currentSource) {
      if (
        shouldInvalidateCurrentSource({
          stateTabUrl: nextTabUrl,
          currentSourceUrl: opts.panelState.currentSource.url,
        })
      ) {
        const preserveChat = opts.navigationRuntime.isRecentAgentNavigation(
          opts.getActiveTabId(),
          nextTabUrl,
        );
        if (preserveChat) {
          opts.navigationRuntime.notePreserveChatForUrl(nextTabUrl);
        }
        opts.panelState.currentSource = null;
        opts.setCurrentRunTabId(null);
        opts.resetSummaryView({ preserveChat });
      } else if (nextTabTitle && nextTabTitle !== opts.panelState.currentSource.title) {
        opts.panelState.currentSource = {
          ...opts.panelState.currentSource,
          title: nextTabTitle,
        };
        opts.headerController.setBaseTitle(nextTabTitle);
      }
    }
    if (!opts.panelState.currentSource) {
      if (!ignoreTransientTabState) {
        opts.panelState.lastMeta = { inputSummary: null, model: null, modelLabel: null };
        opts.headerController.setBaseTitle(nextTabTitle || nextTabUrl || "Summarize");
        opts.headerController.setBaseSubtitle("");
      }
    }
    if (!opts.isStreaming()) {
      opts.headerController.setStatus(state.status);
    }
    if (!nextMediaAvailable && hasMediaInfo) {
      opts.setInputMode("page");
      opts.setInputModeOverride(null);
    }
    opts.setMediaAvailable(nextMediaAvailable);
    opts.setSummarizeVideoLabel(nextVideoLabel);
    opts.setSummarizePageWords(state.stats.pageWords);
    opts.setSummarizeVideoDurationSeconds(state.stats.videoDurationSeconds);
    opts.maybeSeedPlannedSlidesForPendingRun();
    opts.refreshSummarizeControl();
    const showingSetup = opts.maybeShowSetup(state);
    if (showingSetup && opts.panelState.phase !== "setup") {
      opts.setPhase("setup");
    } else if (!showingSetup && opts.panelState.phase === "setup") {
      opts.setPhase("idle");
    }
    if (!opts.panelState.summaryMarkdown?.trim()) {
      opts.renderMarkdownDisplay();
    }
  }

  return { apply };
}
