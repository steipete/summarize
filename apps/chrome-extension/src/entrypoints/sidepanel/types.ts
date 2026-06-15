import type { Message } from "@earendil-works/pi-ai";
import type { BrowserAiSummaryInput, RunStart, UiState } from "../../lib/panel-contracts";
import type { SseSlidesData } from "../../lib/runtime-contracts";
import type { Settings } from "../../lib/settings";
import type { SlidesSessionState } from "./slides-session-state";
import type { SlideTextMode } from "./slides-state";
export type { RunStart, UiState } from "../../lib/panel-contracts";

export type PanelPhase = "idle" | "setup" | "connecting" | "streaming" | "error";

export type ChatMessage = Message & { id: string };

export type ChatQueueItem = {
  id: string;
  text: string;
  createdAt: number;
};

export type SlideSummarySource = "summary" | "slides" | "slides-partial" | null;

export type NavigationPolicyState = {
  lastAgentNavigation: {
    url: string;
    tabId: number | null;
    at: number;
  } | null;
  pendingPreserveChatForUrl: {
    url: string;
    at: number;
  } | null;
};

export type PendingSummaryResult =
  | { type: "run"; run: RunStart }
  | { type: "snapshot"; run: RunStart; markdown: string; browserAi?: BrowserAiSummaryInput };

export type PendingSlidesRun = {
  runId: string;
  url: string | null;
  local?: boolean;
};

export type PanelState = {
  ui: UiState | null;
  navigation: NavigationPolicyState & {
    activeTabId: number | null;
    activeTabUrl: string | null;
  };
  activeRun: {
    tabId: number | null;
  };
  pendingRuns: {
    summaryByUrl: Record<string, PendingSummaryResult>;
    slidesByUrl: Record<string, PendingSlidesRun>;
  };
  slidesLifecycle: {
    activeRun: {
      runId: string;
      url: string | null;
      local: boolean;
    } | null;
    plannedRun: RunStart | null;
  };
  slidesSummary: {
    runId: string | null;
    url: string | null;
    markdown: string;
    pending: string | null;
    hadError: boolean;
    complete: boolean;
    model: string | null;
  };
  slidesText: {
    mode: SlideTextMode;
    toggleVisible: boolean;
    transcriptTimedText: string | null;
    transcriptAvailable: boolean;
    ocrAvailable: boolean;
    descriptionsByIndex: Record<number, string>;
    summariesByIndex: Record<number, string>;
    titlesByIndex: Record<number, string>;
    summarySource: SlideSummarySource;
  };
  slidesSession: SlidesSessionState;
  panelSession: {
    autoSummarize: boolean;
    chatEnabled: boolean;
    automationEnabled: boolean;
    daemonFeaturesAvailable: boolean;
    settingsHydrated: boolean;
    pendingSettingsSnapshot: Partial<Settings> | null;
    lastPanelOpen: boolean;
    lastAction: "summarize" | "chat" | null;
    automationNoticeSticky: boolean;
  };
  runId: string | null;
  slidesRunId: string | null;
  currentSource: { url: string; title: string | null } | null;
  lastMeta: { inputSummary: string | null; model: string | null; modelLabel: string | null };
  summaryMarkdown: string | null;
  summaryFromCache: boolean | null;
  retainedSlideSummary: {
    markdown: string;
    url: string | null;
  } | null;
  chat: {
    messages: ChatMessage[];
    streaming: boolean;
    queue: ChatQueueItem[];
  };
  slides: SseSlidesData | null;
  phase: PanelPhase;
  error: string | null;
};
