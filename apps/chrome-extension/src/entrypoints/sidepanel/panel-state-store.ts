import { defaultSettings } from "../../lib/settings";
import { createInitialSlidesSessionState } from "./slides-session-state";
import type { PanelState } from "./types";

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

export function patchPanelState<
  Key extends
    | "navigation"
    | "slidesLifecycle"
    | "slidesSummary"
    | "slidesText"
    | "slidesSession"
    | "panelSession"
    | "chat",
>(state: PanelState, key: Key, patch: Partial<PanelState[Key]>) {
  state[key] = { ...state[key], ...patch };
}

export function setPanelPhase(
  state: PanelState,
  phase: PanelState["phase"],
  error?: string | null,
) {
  state.phase = phase;
  state.error = phase === "error" ? (error ?? state.error) : null;
}

export function setPendingSummaryRun(
  state: PanelState,
  urlKey: string,
  value: PanelState["pendingRuns"]["summaryByUrl"][string] | null,
) {
  state.pendingRuns = {
    ...state.pendingRuns,
    summaryByUrl: updateKeyedValue(state.pendingRuns.summaryByUrl, urlKey, value),
  };
}

export function setPendingSlidesRun(
  state: PanelState,
  urlKey: string,
  value: PanelState["pendingRuns"]["slidesByUrl"][string] | null,
) {
  state.pendingRuns = {
    ...state.pendingRuns,
    slidesByUrl: updateKeyedValue(state.pendingRuns.slidesByUrl, urlKey, value),
  };
}

type PanelRun = {
  tabId: PanelState["activeRun"]["tabId"];
  runId: string | null;
  slidesRunId: string | null;
  source: NonNullable<PanelState["currentSource"]>;
  meta: PanelState["lastMeta"];
};

export function attachPanelRun(
  state: PanelState,
  run: PanelRun & { runId: string; plannedSlidesRun: PanelState["slidesLifecycle"]["plannedRun"] },
) {
  state.activeRun = { tabId: run.tabId };
  patchPanelState(state, "slidesLifecycle", { plannedRun: run.plannedSlidesRun });
  state.runId = run.runId;
  state.slidesRunId = run.slidesRunId;
  state.currentSource = run.source;
  state.lastMeta = run.meta;
}

export function restorePanelSession(
  state: PanelState,
  session: PanelRun & { summaryFromCache: boolean | null; slides?: PanelState["slides"] },
) {
  state.activeRun = { tabId: session.tabId };
  state.runId = session.runId;
  state.slidesRunId = session.slidesRunId;
  state.currentSource = session.source;
  state.lastMeta = session.meta;
  state.summaryFromCache = session.summaryFromCache;
  if (session.slides !== undefined) state.slides = session.slides;
}

export function resetPanelSummary(
  state: PanelState,
  options: { clearRunId: boolean; clearSlides: boolean },
) {
  state.activeRun = { tabId: null };
  state.summaryMarkdown = null;
  state.summaryFromCache = null;
  if (options.clearRunId) state.runId = null;
  if (options.clearSlides) {
    state.slides = null;
    if (options.clearRunId) state.slidesRunId = null;
  }
}

export function replacePanelChatMessage(
  state: PanelState,
  message: PanelState["chat"]["messages"][number],
) {
  patchPanelState(state, "chat", {
    messages: state.chat.messages.map((existing) =>
      existing.id === message.id ? message : existing,
    ),
  });
}

export function createInitialSlidesSummaryState(): PanelState["slidesSummary"] {
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

export function createInitialSlidesTextState(): PanelState["slidesText"] {
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
