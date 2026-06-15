import { defaultSettings } from "../../lib/settings";
import { createInitialSlidesSessionState } from "./slides-session-state";
import type { NavigationPolicyState, PanelState } from "./types";

export type PanelStateAction =
  | { type: "phase"; phase: PanelState["phase"]; error?: string | null }
  | { type: "ui"; ui: PanelState["ui"] }
  | {
      type: "active-tab";
      tabId: PanelState["navigation"]["activeTabId"];
      url: PanelState["navigation"]["activeTabUrl"];
    }
  | { type: "active-tab-url"; url: PanelState["navigation"]["activeTabUrl"] }
  | { type: "navigation-policy-update"; value: Partial<NavigationPolicyState> }
  | {
      type: "pending-summary-run";
      urlKey: string;
      value: PanelState["pendingRuns"]["summaryByUrl"][string] | null;
    }
  | {
      type: "pending-slides-run";
      urlKey: string;
      value: PanelState["pendingRuns"]["slidesByUrl"][string] | null;
    }
  | { type: "active-slides-run"; value: PanelState["slidesLifecycle"]["activeRun"] }
  | { type: "planned-slides-run"; value: PanelState["slidesLifecycle"]["plannedRun"] }
  | { type: "slides-summary-update"; value: Partial<PanelState["slidesSummary"]> }
  | { type: "slides-summary-reset" }
  | { type: "slides-text-update"; value: Partial<PanelState["slidesText"]> }
  | { type: "slides-text-reset" }
  | { type: "slides-session-update"; value: Partial<PanelState["slidesSession"]> }
  | { type: "slides-context-request-next" }
  | { type: "panel-session-update"; value: Partial<PanelState["panelSession"]> }
  | { type: "source"; source: PanelState["currentSource"] }
  | { type: "meta"; meta: PanelState["lastMeta"] }
  | { type: "summary"; markdown: string | null }
  | { type: "summary-cache"; value: boolean | null }
  | { type: "retained-slide-summary"; value: PanelState["retainedSlideSummary"] }
  | { type: "slides"; slides: PanelState["slides"] }
  | { type: "slides-run"; runId: string | null }
  | { type: "chat-streaming"; value: boolean }
  | { type: "chat-reset" }
  | { type: "chat-messages"; messages: PanelState["chat"]["messages"] }
  | { type: "chat-message-add"; message: PanelState["chat"]["messages"][number] }
  | { type: "chat-message-replace"; message: PanelState["chat"]["messages"][number] }
  | { type: "chat-message-remove"; id: string }
  | { type: "chat-queue-add"; item: PanelState["chat"]["queue"][number] }
  | { type: "chat-queue-remove"; id: string }
  | { type: "chat-queue-clear" }
  | {
      type: "attach-run";
      tabId: PanelState["activeRun"]["tabId"];
      runId: string;
      slidesRunId: string | null;
      plannedSlidesRun: PanelState["slidesLifecycle"]["plannedRun"];
      source: NonNullable<PanelState["currentSource"]>;
      meta: PanelState["lastMeta"];
    }
  | {
      type: "restore-session";
      tabId: PanelState["activeRun"]["tabId"];
      runId: string | null;
      slidesRunId: string | null;
      source: NonNullable<PanelState["currentSource"]>;
      meta: PanelState["lastMeta"];
      summaryFromCache: boolean | null;
      slides?: PanelState["slides"];
    }
  | { type: "reset-summary"; clearRunId: boolean; clearSlides: boolean };

export function createInitialPanelState(): PanelState {
  return {
    ui: null,
    navigation: {
      activeTabId: null,
      activeTabUrl: null,
      lastAgentNavigation: null,
      pendingPreserveChatForUrl: null,
    },
    activeRun: {
      tabId: null,
    },
    pendingRuns: {
      summaryByUrl: {},
      slidesByUrl: {},
    },
    slidesLifecycle: {
      activeRun: null,
      plannedRun: null,
    },
    slidesSummary: createInitialSlidesSummaryState(),
    slidesText: createInitialSlidesTextState(),
    slidesSession: createInitialSlidesSessionState({
      slidesEnabled: defaultSettings.slidesEnabled,
      slidesParallel: defaultSettings.slidesParallel,
      slidesOcrEnabled: defaultSettings.slidesOcrEnabled,
      slidesLayout: defaultSettings.slidesLayout,
    }),
    panelSession: {
      autoSummarize: false,
      chatEnabled: defaultSettings.chatEnabled,
      automationEnabled: defaultSettings.automationEnabled,
      daemonFeaturesAvailable: false,
      settingsHydrated: false,
      pendingSettingsSnapshot: null,
      lastPanelOpen: false,
      lastAction: null,
      automationNoticeSticky: false,
    },
    runId: null,
    slidesRunId: null,
    currentSource: null,
    lastMeta: { inputSummary: null, model: null, modelLabel: null },
    summaryMarkdown: null,
    summaryFromCache: null,
    retainedSlideSummary: null,
    chat: {
      messages: [],
      streaming: false,
      queue: [],
    },
    slides: null,
    phase: "idle",
    error: null,
  };
}

export function reducePanelState(state: PanelState, action: PanelStateAction): PanelState {
  switch (action.type) {
    case "phase":
      return {
        ...state,
        phase: action.phase,
        error: action.phase === "error" ? (action.error ?? state.error) : null,
      };
    case "ui":
      return { ...state, ui: action.ui };
    case "active-tab":
      return {
        ...state,
        navigation: {
          ...state.navigation,
          activeTabId: action.tabId,
          activeTabUrl: action.url,
        },
      };
    case "active-tab-url":
      return {
        ...state,
        navigation: {
          ...state.navigation,
          activeTabUrl: action.url,
        },
      };
    case "navigation-policy-update":
      return {
        ...state,
        navigation: {
          ...state.navigation,
          ...action.value,
        },
      };
    case "pending-summary-run":
      return {
        ...state,
        pendingRuns: {
          ...state.pendingRuns,
          summaryByUrl: updateKeyedValue(
            state.pendingRuns.summaryByUrl,
            action.urlKey,
            action.value,
          ),
        },
      };
    case "pending-slides-run":
      return {
        ...state,
        pendingRuns: {
          ...state.pendingRuns,
          slidesByUrl: updateKeyedValue(state.pendingRuns.slidesByUrl, action.urlKey, action.value),
        },
      };
    case "active-slides-run":
      return {
        ...state,
        slidesLifecycle: {
          ...state.slidesLifecycle,
          activeRun: action.value,
        },
      };
    case "planned-slides-run":
      return {
        ...state,
        slidesLifecycle: {
          ...state.slidesLifecycle,
          plannedRun: action.value,
        },
      };
    case "slides-summary-update":
      return {
        ...state,
        slidesSummary: {
          ...state.slidesSummary,
          ...action.value,
        },
      };
    case "slides-summary-reset":
      return {
        ...state,
        slidesSummary: createInitialSlidesSummaryState(),
      };
    case "slides-text-update":
      return {
        ...state,
        slidesText: {
          ...state.slidesText,
          ...action.value,
        },
      };
    case "slides-text-reset":
      return {
        ...state,
        slidesText: createInitialSlidesTextState(),
      };
    case "slides-session-update":
      return {
        ...state,
        slidesSession: {
          ...state.slidesSession,
          ...action.value,
        },
      };
    case "slides-context-request-next":
      return {
        ...state,
        slidesSession: {
          ...state.slidesSession,
          slidesContextRequestId: state.slidesSession.slidesContextRequestId + 1,
        },
      };
    case "panel-session-update":
      return {
        ...state,
        panelSession: {
          ...state.panelSession,
          ...action.value,
        },
      };
    case "source":
      return { ...state, currentSource: action.source };
    case "meta":
      return { ...state, lastMeta: action.meta };
    case "summary":
      return { ...state, summaryMarkdown: action.markdown };
    case "summary-cache":
      return { ...state, summaryFromCache: action.value };
    case "retained-slide-summary":
      return { ...state, retainedSlideSummary: action.value };
    case "slides":
      return { ...state, slides: action.slides };
    case "slides-run":
      return { ...state, slidesRunId: action.runId };
    case "chat-streaming":
      return {
        ...state,
        chat: {
          ...state.chat,
          streaming: action.value,
        },
      };
    case "chat-reset":
      return {
        ...state,
        chat: {
          messages: [],
          streaming: false,
          queue: [],
        },
      };
    case "chat-messages":
      return {
        ...state,
        chat: {
          ...state.chat,
          messages: action.messages,
        },
      };
    case "chat-message-add":
      return {
        ...state,
        chat: {
          ...state.chat,
          messages: [...state.chat.messages, action.message],
        },
      };
    case "chat-message-replace":
      return {
        ...state,
        chat: {
          ...state.chat,
          messages: state.chat.messages.map((message) =>
            message.id === action.message.id ? action.message : message,
          ),
        },
      };
    case "chat-message-remove":
      return {
        ...state,
        chat: {
          ...state.chat,
          messages: state.chat.messages.filter((message) => message.id !== action.id),
        },
      };
    case "chat-queue-add":
      return {
        ...state,
        chat: {
          ...state.chat,
          queue: [...state.chat.queue, action.item],
        },
      };
    case "chat-queue-remove":
      return {
        ...state,
        chat: {
          ...state.chat,
          queue: state.chat.queue.filter((item) => item.id !== action.id),
        },
      };
    case "chat-queue-clear":
      return {
        ...state,
        chat: {
          ...state.chat,
          queue: [],
        },
      };
    case "attach-run":
      return {
        ...state,
        activeRun: { tabId: action.tabId },
        slidesLifecycle: {
          ...state.slidesLifecycle,
          plannedRun: action.plannedSlidesRun,
        },
        runId: action.runId,
        slidesRunId: action.slidesRunId,
        currentSource: action.source,
        lastMeta: action.meta,
      };
    case "restore-session":
      return {
        ...state,
        activeRun: { tabId: action.tabId },
        runId: action.runId,
        slidesRunId: action.slidesRunId,
        currentSource: action.source,
        lastMeta: action.meta,
        summaryFromCache: action.summaryFromCache,
        ...(typeof action.slides === "undefined" ? {} : { slides: action.slides }),
      };
    case "reset-summary":
      return {
        ...state,
        activeRun: { tabId: null },
        summaryMarkdown: null,
        summaryFromCache: null,
        ...(action.clearRunId ? { runId: null } : {}),
        ...(action.clearSlides
          ? {
              slides: null,
              ...(action.clearRunId ? { slidesRunId: null } : {}),
            }
          : {}),
      };
  }
}

function createInitialSlidesSummaryState(): PanelState["slidesSummary"] {
  return {
    runId: null,
    url: null,
    markdown: "",
    pending: null,
    hadError: false,
    complete: false,
    model: null,
  };
}

function createInitialSlidesTextState(): PanelState["slidesText"] {
  return {
    mode: "transcript",
    toggleVisible: false,
    transcriptTimedText: null,
    transcriptAvailable: false,
    ocrAvailable: false,
    descriptionsByIndex: {},
    summariesByIndex: {},
    titlesByIndex: {},
    summarySource: null,
  };
}

function updateKeyedValue<T>(
  values: Record<string, T>,
  key: string,
  value: T | null,
): Record<string, T> {
  if (value !== null) return { ...values, [key]: value };
  if (!Object.hasOwn(values, key)) return values;
  const next = { ...values };
  delete next[key];
  return next;
}

export function applyPanelStateAction(state: PanelState, action: PanelStateAction): PanelState {
  Object.assign(state, reducePanelState(state, action));
  return state;
}

export function createPanelStateStore(initial = createInitialPanelState()) {
  const state = initial;
  return {
    state,
    dispatch(action: PanelStateAction) {
      applyPanelStateAction(state, action);
    },
  };
}
