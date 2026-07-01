import type {
  AgentAssistantMessage as AssistantMessage,
  AgentMessage as Message,
} from "@steipete/summarize-core/runtime";
import type { SseSlidesData } from "./runtime-contracts";

export type UiState = {
  panelOpen: boolean;
  daemon: { ok: boolean; authed: boolean; error?: string };
  tab: { id: number | null; url: string | null; title: string | null };
  media: { hasVideo: boolean; hasAudio: boolean; hasCaptions: boolean } | null;
  stats: { pageWords: number | null; videoDurationSeconds: number | null };
  settings: {
    autoSummarize: boolean;
    hoverSummaries: boolean;
    chatEnabled: boolean;
    automationEnabled: boolean;
    slidesEnabled: boolean;
    slidesParallel: boolean;
    slidesOcrEnabled: boolean;
    slidesLayout: "strip" | "gallery";
    slideRuntime: "browser" | "daemon";
    summaryRuntime: "direct" | "daemon";
    providerConfigured: boolean;
    daemonAllowed: boolean;
    daemonManaged: boolean;
    daemonHintDismissed: boolean;
    fontSize: number;
    lineHeight: number;
    model: string;
    length: string;
    tokenPresent: boolean;
  };
  status: string;
};

export type BrowserAiSummaryInput = {
  text: string;
  length: "short" | "medium" | "long";
  keyMoments: Array<{
    startSeconds: number;
    text: string;
  }>;
};

export type RunStart = {
  id: string;
  url: string;
  title: string | null;
  model: string;
  reason: string;
  slides?: boolean;
};

type PanelCacheMeta = {
  inputSummary: string | null;
  model: string | null;
  modelLabel: string | null;
};

export type PanelCachePayload = {
  tabId: number;
  url: string;
  title: string | null;
  runId: string | null;
  slidesRunId: string | null;
  summaryMarkdown: string | null;
  summaryFromCache: boolean | null;
  slidesSummaryMarkdown: string | null;
  slidesSummaryComplete: boolean | null;
  slidesSummaryModel: string | null;
  lastMeta: PanelCacheMeta;
  slides: SseSlidesData | null;
  transcriptTimedText: string | null;
};

export type PanelToBg =
  | { type: "panel:ready" }
  | { type: "panel:summarize"; refresh?: boolean; inputMode?: "page" | "video" }
  | {
      type: "panel:agent";
      requestId: string;
      messages: Message[];
      tools: string[];
      summary?: string | null;
    }
  | {
      type: "panel:chat-history";
      requestId: string;
      summary?: string | null;
    }
  | { type: "panel:seek"; seconds: number }
  | { type: "panel:ping" }
  | { type: "panel:closed" }
  | { type: "panel:rememberUrl"; url: string }
  | { type: "panel:setAuto"; value: boolean }
  | { type: "panel:setLength"; value: string }
  | { type: "panel:slides-context"; requestId: string; url?: string }
  | { type: "panel:slides-local"; requestId: string; runId: string }
  | { type: "panel:slides-capture"; manual?: boolean }
  | { type: "panel:cache"; cache: PanelCachePayload }
  | { type: "panel:get-cache"; requestId: string; tabId: number; url: string }
  | { type: "panel:openOptions" };

export type BgToPanel =
  | { type: "ui:state"; state: UiState }
  | { type: "ui:status"; status: string }
  | { type: "run:start"; run: RunStart }
  | {
      type: "run:snapshot";
      run: RunStart;
      markdown: string;
      browserAi?: BrowserAiSummaryInput;
    }
  | { type: "run:error"; message: string }
  | { type: "ui:cache-cleared" }
  | {
      type: "slides:run";
      ok: boolean;
      runId?: string;
      url?: string;
      local?: boolean;
      error?: string;
    }
  | {
      type: "slides:local";
      requestId: string;
      ok: boolean;
      slides?: SseSlidesData;
      error?: string;
    }
  | { type: "chat:history"; requestId: string; ok: boolean; messages?: Message[]; error?: string }
  | { type: "agent:chunk"; requestId: string; text: string }
  | {
      type: "agent:response";
      requestId: string;
      ok: boolean;
      assistant?: AssistantMessage;
      error?: string;
    }
  | {
      type: "slides:context";
      requestId: string;
      ok: boolean;
      transcriptTimedText?: string | null;
      error?: string;
    }
  | { type: "ui:cache"; requestId: string; ok: boolean; cache?: PanelCachePayload };
