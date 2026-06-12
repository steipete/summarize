import type { PanelState } from "./types";

export type PanelStateAction =
  | { type: "phase"; phase: PanelState["phase"]; error?: string | null }
  | { type: "ui"; ui: PanelState["ui"] }
  | { type: "source"; source: PanelState["currentSource"] }
  | { type: "meta"; meta: PanelState["lastMeta"] }
  | { type: "summary"; markdown: string | null }
  | { type: "summary-cache"; value: boolean | null }
  | { type: "slides"; slides: PanelState["slides"] }
  | { type: "slides-run"; runId: string | null }
  | { type: "chat-streaming"; value: boolean }
  | {
      type: "attach-run";
      runId: string;
      slidesRunId: string | null;
      source: NonNullable<PanelState["currentSource"]>;
      meta: PanelState["lastMeta"];
    }
  | {
      type: "restore-session";
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
    runId: null,
    slidesRunId: null,
    currentSource: null,
    lastMeta: { inputSummary: null, model: null, modelLabel: null },
    summaryMarkdown: null,
    summaryFromCache: null,
    slides: null,
    phase: "idle",
    error: null,
    chatStreaming: false,
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
    case "source":
      return { ...state, currentSource: action.source };
    case "meta":
      return { ...state, lastMeta: action.meta };
    case "summary":
      return { ...state, summaryMarkdown: action.markdown };
    case "summary-cache":
      return { ...state, summaryFromCache: action.value };
    case "slides":
      return { ...state, slides: action.slides };
    case "slides-run":
      return { ...state, slidesRunId: action.runId };
    case "chat-streaming":
      return { ...state, chatStreaming: action.value };
    case "attach-run":
      return {
        ...state,
        runId: action.runId,
        slidesRunId: action.slidesRunId,
        currentSource: action.source,
        lastMeta: action.meta,
      };
    case "restore-session":
      return {
        ...state,
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
