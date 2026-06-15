import { isYouTubeVideoUrl, shouldPreferUrlMode } from "@steipete/summarize-core/content/url";
import type { PanelCachePayload } from "./panel-cache";
import { isPanelChatAvailable } from "./panel-capabilities";
import { applyPanelStateAction, type PanelStateAction } from "./panel-state-store";
import {
  resolvePanelNavigationDecision,
  shouldIgnoreTransientPanelTabState,
  shouldInvalidateCurrentSource,
} from "./session-policy";
import type { SetupDisplay } from "./setup-runtime";
import type { PanelPhase, PanelState, UiState } from "./types";

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

type PanelCacheControllerLike = {
  resolve: (tabId: number, url: string) => PanelCachePayload | null;
  request: (tabId: number, url: string, preserveChat: boolean) => void;
};

type UiStateRuntimeOpts = {
  panelState: PanelState;
  dispatchPanelState?: (action: PanelStateAction) => void;
  appearanceControls: AppearanceControlsLike;
  typographyController: TypographyControllerLike;
  navigationRuntime: NavigationRuntimeLike;
  panelCacheController: PanelCacheControllerLike;
  headerController: HeaderControllerLike;
  clearInlineError: () => void;
  requestAgentAbort: (reason: string) => void;
  clearChatHistoryForActiveTab: () => void | Promise<void>;
  migrateChatHistory: (
    fromTabId: number | null,
    toTabId: number | null,
    toUrl: string | null,
  ) => void | Promise<void>;
  maybeStartPendingSummaryRunForUrl: (url: string | null) => boolean;
  maybeStartPendingSlidesForUrl: (url: string | null) => void;
  requestSlidesCapture: () => void;
  resolveActiveSlidesRunId: () => string | null;
  applyPanelCache: (payload: PanelCachePayload, opts?: { preserveChat?: boolean }) => void;
  resetSummaryView: (opts?: { preserveChat?: boolean }) => void;
  abortSummaryStream: () => void;
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
  maybeShowSetup: (state: UiState) => SetupDisplay;
  setPhase: (phase: PanelPhase, opts?: { error?: string | null }) => void;
  renderMarkdownDisplay: () => void;
  readCurrentModelValue: () => string;
  setModelValue: (value: string) => void;
  updateModelRowUI: () => void;
  isRefreshFreeRunning: () => boolean;
  setModelRefreshDisabled: (value: boolean) => void;
  renderMarkdownHostEl: HTMLElement;
  isStreaming: () => boolean;
  onSlidesOcrChanged: () => void;
};

function dispatchPanelState(
  opts: Pick<UiStateRuntimeOpts, "panelState" | "dispatchPanelState">,
  action: PanelStateAction,
) {
  if (opts.dispatchPanelState) {
    opts.dispatchPanelState(action);
  } else {
    applyPanelStateAction(opts.panelState, action);
  }
}

function applyCachedOrReset(
  opts: Pick<
    UiStateRuntimeOpts,
    | "panelState"
    | "dispatchPanelState"
    | "panelCacheController"
    | "applyPanelCache"
    | "requestSlidesCapture"
    | "resetSummaryView"
  >,
  tabId: number | null,
  url: string | null,
  preserveChat: boolean,
) {
  if (tabId && url) {
    const cached = opts.panelCacheController.resolve(tabId, url);
    if (cached) {
      opts.applyPanelCache(cached, { preserveChat });
      if (
        cached.summaryMarkdown &&
        !cached.slides?.slides.length &&
        cached.url &&
        isYouTubeVideoUrl(cached.url)
      ) {
        opts.requestSlidesCapture();
      }
    } else {
      dispatchPanelState(opts, { type: "source", source: null });
      opts.resetSummaryView({ preserveChat });
      opts.panelCacheController.request(tabId, url, preserveChat);
    }
    return;
  }

  dispatchPanelState(opts, { type: "source", source: null });
  opts.resetSummaryView({ preserveChat });
}

export function createUiStateRuntime(opts: UiStateRuntimeOpts) {
  function apply(state: UiState) {
    if (state.panelOpen && !opts.panelState.panelSession.lastPanelOpen) {
      opts.clearInlineError();
    }
    dispatchPanelState(opts, {
      type: "panel-session-update",
      value: {
        lastPanelOpen: state.panelOpen,
        autoSummarize: state.settings.autoSummarize,
      },
    });
    opts.appearanceControls.setAutoValue(state.settings.autoSummarize);

    const { activeTabId, activeTabUrl } = opts.panelState.navigation;
    const currentSource = opts.panelState.currentSource;
    const inputModeOverride = opts.panelState.slidesSession.inputModeOverride;
    const mediaAvailable = opts.panelState.slidesSession.mediaAvailable;
    const chatEnabledValue = state.settings.chatEnabled;
    const slidesLayoutValue = opts.panelState.slidesSession.slidesLayout;

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
      opts.panelState.chat.streaming ||
      opts.panelState.chat.messages.length > 0 ||
      chatEnabledValue;
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
      dispatchPanelState(opts, { type: "active-tab", tabId: nextTabId, url: nextTabUrl });
      if (opts.panelState.chat.streaming && navigation.shouldAbortChatStream) {
        opts.requestAgentAbort("Tab changed");
      }
      if (navigation.shouldClearChat) {
        void opts.clearChatHistoryForActiveTab();
      } else if (navigation.shouldMigrateChat) {
        void opts.migrateChatHistory(previousTabId, nextTabId, nextTabUrl);
      }
      if (navigation.nextInputMode) {
        dispatchPanelState(opts, {
          type: "slides-session-update",
          value: { inputMode: navigation.nextInputMode },
        });
      }
      if (navigation.resetInputModeOverride) {
        dispatchPanelState(opts, {
          type: "slides-session-update",
          value: { inputModeOverride: null },
        });
      }
      opts.abortSummaryStream();
      if (!opts.maybeStartPendingSummaryRunForUrl(nextTabUrl)) {
        applyCachedOrReset(opts, nextTabId, nextTabUrl, navigation.preserveChat);
      }
    } else if (navigation.kind === "url") {
      dispatchPanelState(opts, { type: "active-tab-url", url: nextTabUrl });
      if (navigation.preserveChat) {
        opts.navigationRuntime.notePreserveChatForUrl(nextTabUrl);
      } else if (navigation.shouldClearChat) {
        void opts.clearChatHistoryForActiveTab();
      }
      opts.abortSummaryStream();
      if (!opts.maybeStartPendingSummaryRunForUrl(nextTabUrl)) {
        applyCachedOrReset(
          opts,
          opts.panelState.navigation.activeTabId,
          nextTabUrl,
          navigation.preserveChat,
        );
      }
      if (navigation.nextInputMode) {
        dispatchPanelState(opts, {
          type: "slides-session-update",
          value: { inputMode: navigation.nextInputMode },
        });
      }
    }

    dispatchPanelState(opts, {
      type: "panel-session-update",
      value: {
        chatEnabled: state.settings.chatEnabled,
        automationEnabled: state.settings.automationEnabled,
        daemonFeaturesAvailable:
          (state.settings.summaryRuntime === "direct" && state.settings.providerConfigured) ||
          (state.settings.summaryRuntime === "daemon" && state.daemon.ok && state.daemon.authed),
      },
    });
    const nextSlidesOcrEnabled = Boolean(state.settings.slidesOcrEnabled);
    const slidesOcrChanged =
      nextSlidesOcrEnabled !== opts.panelState.slidesSession.slidesOcrEnabled;
    dispatchPanelState(opts, {
      type: "slides-session-update",
      value: {
        slidesEnabled: state.settings.slidesEnabled,
        slidesParallel: state.settings.slidesParallel,
        ...(slidesOcrChanged ? { slidesOcrEnabled: nextSlidesOcrEnabled } : {}),
      },
    });
    if (slidesOcrChanged) {
      opts.onSlidesOcrChanged();
    }
    const fallbackModel =
      typeof state.settings.model === "string" ? state.settings.model.trim() : "";
    if (
      fallbackModel &&
      (!opts.panelState.lastMeta.model || !opts.panelState.lastMeta.model.trim())
    ) {
      dispatchPanelState(opts, {
        type: "meta",
        meta: {
          ...opts.panelState.lastMeta,
          model: fallbackModel,
          modelLabel: fallbackModel,
        },
      });
    }
    if (opts.panelState.slidesSession.slidesEnabled && nextMediaAvailable) {
      dispatchPanelState(opts, {
        type: "slides-session-update",
        value: {
          inputMode: "video",
          inputModeOverride: "video",
        },
      });
    }
    if (state.settings.slidesLayout && state.settings.slidesLayout !== slidesLayoutValue) {
      opts.setSlidesLayout(state.settings.slidesLayout);
    }
    if (opts.panelState.panelSession.automationEnabled) opts.hideAutomationNotice();
    if (!opts.panelState.slidesSession.slidesEnabled) opts.hideSlideNotice();
    if (
      opts.panelState.slidesSession.slidesEnabled &&
      (opts.panelState.slidesSession.inputModeOverride ??
        opts.panelState.slidesSession.inputMode) === "video"
    ) {
      opts.maybeApplyPendingSlidesSummary();
      opts.maybeStartPendingSummaryRunForUrl(nextTabUrl ?? null);
      opts.maybeStartPendingSlidesForUrl(nextTabUrl ?? null);
    }
    opts.applyChatEnabled();
    if (
      isPanelChatAvailable(opts.panelState) &&
      opts.panelState.navigation.activeTabId &&
      !shouldPreferUrlMode(nextTabUrl ?? "") &&
      opts.panelState.chat.messages.length === 0
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
          opts.panelState.navigation.activeTabId,
          nextTabUrl,
        );
        if (preserveChat) {
          opts.navigationRuntime.notePreserveChatForUrl(nextTabUrl);
        }
        dispatchPanelState(opts, { type: "source", source: null });
        if (opts.isStreaming()) {
          opts.abortSummaryStream();
        }
        opts.resetSummaryView({ preserveChat });
      } else if (nextTabTitle && nextTabTitle !== opts.panelState.currentSource.title) {
        dispatchPanelState(opts, {
          type: "source",
          source: {
            ...opts.panelState.currentSource,
            title: nextTabTitle,
          },
        });
        opts.headerController.setBaseTitle(nextTabTitle);
      }
    }
    if (!opts.panelState.currentSource) {
      if (!ignoreTransientTabState) {
        dispatchPanelState(opts, {
          type: "meta",
          meta: { inputSummary: null, model: null, modelLabel: null },
        });
        opts.headerController.setBaseTitle(nextTabTitle || nextTabUrl || "Summarize");
        opts.headerController.setBaseSubtitle("");
      }
    }
    if (!opts.isStreaming()) {
      opts.headerController.setStatus(state.status);
    }
    if (!nextMediaAvailable && hasMediaInfo) {
      dispatchPanelState(opts, {
        type: "slides-session-update",
        value: {
          inputMode: "page",
          inputModeOverride: null,
        },
      });
    }
    dispatchPanelState(opts, {
      type: "slides-session-update",
      value: {
        mediaAvailable: nextMediaAvailable,
        summarizeVideoLabel: nextVideoLabel,
        summarizePageWords: state.stats.pageWords,
        summarizeVideoDurationSeconds: state.stats.videoDurationSeconds,
      },
    });
    opts.maybeSeedPlannedSlidesForPendingRun();
    opts.refreshSummarizeControl();
    const setupDisplay = opts.maybeShowSetup(state);
    if (setupDisplay === "blocking" && opts.panelState.phase !== "setup") {
      opts.setPhase("setup");
    } else if (setupDisplay !== "blocking" && opts.panelState.phase === "setup") {
      opts.setPhase("idle");
    }
    if (!opts.panelState.summaryMarkdown?.trim()) {
      opts.renderMarkdownDisplay();
    }
  }

  return { apply };
}
