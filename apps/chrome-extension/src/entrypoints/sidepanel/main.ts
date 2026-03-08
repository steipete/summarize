import type { AssistantMessage, Message, ToolCall, ToolResultMessage } from "@mariozechner/pi-ai";
import { extractYouTubeVideoId, shouldPreferUrlMode } from "@steipete/summarize-core/content/url";
import MarkdownIt from "markdown-it";
import {
  parseTranscriptTimedText,
  splitSummaryFromSlides,
} from "../../../../../src/run/flows/url/slides-text.js";
import type { SseSlidesData } from "../../../../../src/shared/sse-events.js";
import { listSkills } from "../../automation/skills-store";
import { executeToolCall, getAutomationToolNames } from "../../automation/tools";
import { buildIdleSubtitle } from "../../lib/header";
import {
  defaultSettings,
  loadSettings,
  patchSettings,
  type SlidesLayout,
} from "../../lib/settings";
import { applyTheme } from "../../lib/theme";
import { generateToken } from "../../lib/token";
import { mountCheckbox } from "../../ui/zag-checkbox";
import { ChatController } from "./chat-controller";
import {
  buildEmptyUsage,
  createChatHistoryStore,
  normalizeStoredMessage,
} from "./chat-history-store";
import { compactChatHistory, type ChatHistoryLimits } from "./chat-state";
import { createErrorController } from "./error-controller";
import { createHeaderController } from "./header-controller";
import { createMetricsController } from "./metrics-controller";
import { createModelPresetsController } from "./model-presets";
import { createPanelCacheController, type PanelCachePayload } from "./panel-cache";
import {
  mountSidepanelLengthPicker,
  mountSidepanelPickers,
  mountSummarizeControl,
} from "./pickers";
import {
  normalizePanelUrl,
  panelUrlsMatch,
  resolvePanelNavigationDecision,
  shouldAcceptRunForCurrentPage,
  shouldAcceptSlidesForCurrentPage,
  shouldInvalidateCurrentSource,
} from "./session-policy";
import { installStepsHtml, wireSetupButtons } from "./setup-view";
import { createSlideImageLoader, normalizeSlideImageUrl } from "./slide-images";
import { createSlidesHydrator } from "./slides-hydrator";
import { resolveSlidesPayload, slidesPayloadChanged } from "./slides-payload";
import { hasResolvedSlidesPayload } from "./slides-pending";
import { createSlidesRenderer } from "./slides-renderer";
import {
  buildSlideDescriptions,
  deriveSlideSummaries,
  formatSlideTimestamp,
  normalizeSlideText,
  resolveSlidesLengthArg,
  resolveSlidesTextState,
  selectMarkdownForLayout,
  splitSlidesMarkdown,
} from "./slides-state";
import { resolveSlidesRenderLayout } from "./slides-view-policy";
import { createStreamController } from "./stream-controller";
import { buildSummaryEmptyState } from "./summary-empty-state";
import { linkifyTimestamps, parseTimestampHref } from "./timestamp-links";
import type { ChatMessage, PanelPhase, PanelState, RunStart, UiState } from "./types";
import { createTypographyController } from "./typography-controller";

type PanelToBg =
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
  | { type: "panel:cache"; cache: PanelCachePayload }
  | { type: "panel:get-cache"; requestId: string; tabId: number; url: string }
  | { type: "panel:openOptions" };

type BgToPanel =
  | { type: "ui:state"; state: UiState }
  | { type: "ui:status"; status: string }
  | { type: "run:start"; run: RunStart }
  | { type: "run:error"; message: string }
  | { type: "slides:run"; ok: boolean; runId?: string; url?: string; error?: string }
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

let panelPort: chrome.runtime.Port | null = null;
let panelPortConnecting: Promise<chrome.runtime.Port | null> | null = null;
let panelWindowId: number | null = null;
let currentRunTabId: number | null = null;

function getCurrentWindowId(): Promise<number | null> {
  return new Promise((resolve) => {
    chrome.windows.getCurrent((window) => {
      resolve(typeof window?.id === "number" ? window.id : null);
    });
  });
}

async function ensurePanelPort(): Promise<chrome.runtime.Port | null> {
  if (panelPort) return panelPort;
  if (panelPortConnecting) return panelPortConnecting;
  panelPortConnecting = (async () => {
    const windowId = panelWindowId ?? (await getCurrentWindowId());
    panelWindowId = windowId;
    if (typeof windowId !== "number") return null;
    const port = chrome.runtime.connect({ name: `sidepanel:${windowId}` });
    panelPort = port;
    (window as unknown as { __summarizePanelPort?: chrome.runtime.Port }).__summarizePanelPort =
      port;
    port.onMessage.addListener((msg) => {
      handleBgMessage(msg as BgToPanel);
    });
    port.onDisconnect.addListener(() => {
      if (panelPort !== port) return;
      panelPort = null;
      panelPortConnecting = null;
      (window as unknown as { __summarizePanelPort?: chrome.runtime.Port }).__summarizePanelPort =
        undefined;
    });
    return port;
  })();
  const resolved = await panelPortConnecting;
  if (!resolved) panelPortConnecting = null;
  return resolved;
}

function byId<T extends HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) throw new Error(`Missing #${id}`);
  return el as T;
}

const subtitleEl = byId<HTMLDivElement>("subtitle");
const titleEl = byId<HTMLDivElement>("title");
const headerEl = document.querySelector("header") as HTMLElement;
if (!headerEl) throw new Error("Missing <header>");
const progressFillEl = byId<HTMLDivElement>("progressFill");
const drawerEl = byId<HTMLElement>("drawer");
const setupEl = byId<HTMLDivElement>("setup");
const errorEl = byId<HTMLDivElement>("error");
const errorMessageEl = byId<HTMLParagraphElement>("errorMessage");
const errorRetryBtn = byId<HTMLButtonElement>("errorRetry");
const errorLogsBtn = byId<HTMLButtonElement>("errorLogs");
const slideNoticeEl = byId<HTMLDivElement>("slideNotice");
const slideNoticeMessageEl = byId<HTMLSpanElement>("slideNoticeMessage");
const slideNoticeRetryBtn = byId<HTMLButtonElement>("slideNoticeRetry");
const renderEl = byId<HTMLElement>("render");
const renderSlidesHostEl = document.createElement("div");
renderSlidesHostEl.className = "render__slidesHost";
const renderMarkdownHostEl = document.createElement("div");
renderMarkdownHostEl.className = "render__markdownHost";
renderEl.append(renderSlidesHostEl, renderMarkdownHostEl);
const mainEl = document.querySelector("main") as HTMLElement;
if (!mainEl) throw new Error("Missing <main>");
const metricsEl = byId<HTMLDivElement>("metrics");
const metricsHomeEl = byId<HTMLDivElement>("metricsHome");
const chatMetricsSlotEl = byId<HTMLDivElement>("chatMetricsSlot");
const chatDockEl = byId<HTMLDivElement>("chatDock");
const slideImageLoader = createSlideImageLoader();

const summarizeControlRoot = byId<HTMLElement>("summarizeControlRoot");
const drawerToggleBtn = byId<HTMLButtonElement>("drawerToggle");
const refreshBtn = byId<HTMLButtonElement>("refresh");
const clearBtn = byId<HTMLButtonElement>("clear");
const advancedBtn = byId<HTMLButtonElement>("advanced");
const autoToggleRoot = byId<HTMLDivElement>("autoToggle");
const lengthRoot = byId<HTMLDivElement>("lengthRoot");
const pickersRoot = byId<HTMLDivElement>("pickersRoot");
const sizeSmBtn = byId<HTMLButtonElement>("sizeSm");
const sizeLgBtn = byId<HTMLButtonElement>("sizeLg");
const lineTightBtn = byId<HTMLButtonElement>("lineTight");
const lineLooseBtn = byId<HTMLButtonElement>("lineLoose");
const advancedSettingsEl = byId<HTMLDetailsElement>("advancedSettings");
const advancedSettingsSummaryEl = advancedSettingsEl.querySelector("summary");
if (!advancedSettingsSummaryEl) throw new Error("Missing advanced settings summary");
const advancedSettingsBodyEl = advancedSettingsEl.querySelector<HTMLElement>(".drawerAdvancedBody");
if (!advancedSettingsBodyEl) throw new Error("Missing advanced settings body");
const modelPresetEl = byId<HTMLSelectElement>("modelPreset");
const modelCustomEl = byId<HTMLInputElement>("modelCustom");
const modelRefreshBtn = byId<HTMLButtonElement>("modelRefresh");

const metricsController = createMetricsController({
  metricsEl,
  metricsHomeEl,
  chatMetricsSlotEl,
});

const typographyController = createTypographyController({
  sizeSmBtn,
  sizeLgBtn,
  lineTightBtn,
  lineLooseBtn,
  defaultFontSize: defaultSettings.fontSize,
  defaultLineHeight: defaultSettings.lineHeight,
});
const modelStatusEl = byId<HTMLDivElement>("modelStatus");
const modelRowEl = byId<HTMLDivElement>("modelRow");
const slidesLayoutEl = byId<HTMLSelectElement>("slidesLayout");

const chatContainerEl = byId<HTMLElement>("chatContainer");
const chatMessagesEl = byId<HTMLDivElement>("chatMessages");
const chatInputEl = byId<HTMLTextAreaElement>("chatInput");
const chatSendBtn = byId<HTMLButtonElement>("chatSend");
const chatContextStatusEl = byId<HTMLDivElement>("chatContextStatus");
const automationNoticeEl = byId<HTMLDivElement>("automationNotice");
const automationNoticeTitleEl = byId<HTMLDivElement>("automationNoticeTitle");
const automationNoticeMessageEl = byId<HTMLDivElement>("automationNoticeMessage");
const automationNoticeActionBtn = byId<HTMLButtonElement>("automationNoticeAction");
const chatJumpBtn = byId<HTMLButtonElement>("chatJump");
const chatQueueEl = byId<HTMLDivElement>("chatQueue");
const inlineErrorEl = byId<HTMLDivElement>("inlineError");
const inlineErrorMessageEl = byId<HTMLDivElement>("inlineErrorMessage");
const inlineErrorRetryBtn = byId<HTMLButtonElement>("inlineErrorRetry");
const inlineErrorLogsBtn = byId<HTMLButtonElement>("inlineErrorLogs");
const inlineErrorCloseBtn = byId<HTMLButtonElement>("inlineErrorClose");

const md = new MarkdownIt({
  html: false,
  linkify: true,
  breaks: false,
});

const slideTagPattern = /^\[slide:(\d+)\]/i;
const slideTagPlugin = (markdown: MarkdownIt) => {
  markdown.inline.ruler.before("emphasis", "slide_tag", (state, silent) => {
    const match = state.src.slice(state.pos).match(slideTagPattern);
    if (!match) return false;
    if (!silent) {
      const token = state.push("slide_tag", "span", 0);
      token.meta = { index: Number(match[1]) };
    }
    state.pos += match[0].length;
    return true;
  });
  markdown.renderer.rules.slide_tag = (tokens, idx) => {
    const index = tokens[idx]?.meta?.index;
    if (!Number.isFinite(index)) return "";
    return `<span class="slideInline" data-slide-index="${index}"></span>`;
  };
};

md.use(slideTagPlugin);

const panelState: PanelState = {
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
let drawerAnimation: Animation | null = null;
let advancedSettingsAnimation: Animation | null = null;
let autoValue = false;
let chatEnabledValue = defaultSettings.chatEnabled;
let automationEnabledValue = defaultSettings.automationEnabled;
let slidesEnabledValue = defaultSettings.slidesEnabled;
let slidesParallelValue = defaultSettings.slidesParallel;
let slidesOcrEnabledValue = defaultSettings.slidesOcrEnabled;
let autoKickTimer = 0;

const MAX_CHAT_MESSAGES = 1000;
const MAX_CHAT_CHARACTERS = 160_000;
const MAX_CHAT_QUEUE = 10;
const chatLimits: ChatHistoryLimits = {
  maxMessages: MAX_CHAT_MESSAGES,
  maxChars: MAX_CHAT_CHARACTERS,
};
type ChatQueueItem = {
  id: string;
  text: string;
  createdAt: number;
};
let chatQueue: ChatQueueItem[] = [];
let chatHistoryLoadId = 0;
let activeTabId: number | null = null;
let activeTabUrl: string | null = null;
let lastPanelOpen = false;
let lastStreamError: string | null = null;
let lastAction: "summarize" | "chat" | null = null;
let abortAgentRequested = false;
let lastNavigationMessageUrl: string | null = null;
let inputMode: "page" | "video" = "page";
let inputModeOverride: "page" | "video" | null = null;
let mediaAvailable = false;
let preserveChatOnNextReset = false;
let automationNoticeSticky = false;
let summarizeVideoLabel = "Video";
let summarizePageWords: number | null = null;
let summarizeVideoDurationSeconds: number | null = null;

type SlideTextMode = "transcript" | "ocr";
let slidesBusy = false;
let slidesExpanded = true;
let slidesTextMode: SlideTextMode = "transcript";
let slidesTextToggleVisible = false;
let slidesTranscriptTimedText: string | null = null;
let slidesTranscriptAvailable = false;
let slidesOcrAvailable = false;
let slidesLayoutValue: SlidesLayout = defaultSettings.slidesLayout;
let slideDescriptions = new Map<number, string>();
let slideSummaryByIndex = new Map<number, string>();
let slideTitleByIndex = new Map<number, string>();
let slideSummarySource: "summary" | "slides" | null = null;
let slidesContextRequestId = 0;
let slidesContextPending = false;
let slidesContextUrl: string | null = null;
let slidesSeededSourceId: string | null = null;
let slidesAppliedRunId: string | null = null;
let slidesSummaryRunId: string | null = null;
let slidesSummaryUrl: string | null = null;
let slidesSummaryMarkdown = "";
let slidesSummaryPending: string | null = null;
let slidesSummaryHadError = false;
let slidesSummaryComplete = false;
let slidesSummaryModel: string | null = null;
let pendingRunForPlannedSlides: RunStart | null = null;
const pendingSummaryRunsByUrl = new Map<string, RunStart>();
const pendingSlidesRunsByUrl = new Map<string, { runId: string; url: string }>();

const AGENT_NAV_TTL_MS = 20_000;
type AgentNavigation = { url: string; tabId: number | null; at: number };
let lastAgentNavigation: AgentNavigation | null = null;
let pendingPreserveChatForUrl: { url: string; at: number } | null = null;
const chatHistoryStore = createChatHistoryStore({ chatLimits });

const chatController = new ChatController({
  messagesEl: chatMessagesEl,
  inputEl: chatInputEl,
  sendBtn: chatSendBtn,
  contextEl: chatContextStatusEl,
  markdown: md,
  limits: chatLimits,
  scrollToBottom: () => scrollToBottom(),
  onNewContent: () => {
    renderInlineSlides(chatMessagesEl);
  },
});

type AutomationNoticeAction = "extensions" | "options";

function hideAutomationNotice(opts?: { force?: boolean }) {
  if (automationNoticeSticky && !opts?.force) return;
  automationNoticeSticky = false;
  automationNoticeEl.classList.add("hidden");
}

function showSlideNotice(message: string, opts?: { allowRetry?: boolean }) {
  slideNoticeMessageEl.textContent = message;
  slideNoticeRetryBtn.hidden = !opts?.allowRetry;
  slideNoticeEl.classList.remove("hidden");
  headerController.updateHeaderOffset();
}

function hideSlideNotice() {
  slideNoticeEl.classList.add("hidden");
  slideNoticeMessageEl.textContent = "";
  slideNoticeRetryBtn.hidden = true;
  headerController.updateHeaderOffset();
}

function stopSlidesStream() {
  slidesHydrator.stop();
  setSlidesBusy(false);
  panelState.slidesRunId = null;
  stopSlidesSummaryStream();
}

function setSlidesTranscriptTimedText(value: string | null) {
  slidesTranscriptTimedText = value ?? null;
  const segments = parseTranscriptTimedText(slidesTranscriptTimedText);
  slidesTranscriptAvailable = segments.length > 0;
}

function stopSlidesSummaryStream() {
  slidesSummaryController.abort();
  slidesSummaryRunId = null;
  slidesSummaryUrl = null;
  slidesSummaryMarkdown = "";
  slidesSummaryPending = null;
  slidesSummaryHadError = false;
  slidesSummaryComplete = false;
  slidesSummaryModel = null;
  slideSummarySource = null;
}

function resolveActiveSlidesRunId(): string | null {
  if (panelState.slidesRunId) return panelState.slidesRunId;
  if (!slidesParallelValue && panelState.runId) return panelState.runId;
  return null;
}

function maybeStartPendingSummaryRunForUrl(url: string | null) {
  if (!url) return false;
  const key = normalizePanelUrl(url);
  const pending = pendingSummaryRunsByUrl.get(key);
  if (!pending) return false;
  if (streamController.isStreaming()) return false;
  pendingSummaryRunsByUrl.delete(key);
  attachSummaryRun(pending);
  return true;
}

function maybeStartPendingSlidesForUrl(url: string | null) {
  if (!url) return;
  const key = normalizePanelUrl(url);
  const pending = pendingSlidesRunsByUrl.get(key);
  if (!pending) return;
  if (!slidesEnabledValue) return;
  const effectiveInputMode = inputModeOverride ?? inputMode;
  if (effectiveInputMode !== "video") return;
  if (slidesHydrator.isStreaming()) return;
  if (hasResolvedSlidesPayload(panelState.slides, slidesSeededSourceId)) return;
  pendingSlidesRunsByUrl.delete(key);
  startSlidesStreamForRunId(pending.runId);
  startSlidesSummaryStreamForRunId(pending.runId, pending.url);
}

function attachSummaryRun(run: RunStart) {
  stopSlidesStream();
  setPhase("connecting");
  lastAction = "summarize";
  window.clearTimeout(autoKickTimer);
  if (panelState.chatStreaming) {
    finishStreamingMessage();
  }
  const preserveChat = shouldPreserveChatForRun(run.url);
  if (!preserveChat) {
    void clearChatHistoryForActiveTab();
    resetChatState();
  } else {
    preserveChatOnNextReset = true;
  }
  metricsController.setActiveMode("summary");
  panelState.runId = run.id;
  panelState.slidesRunId = slidesParallelValue ? null : run.id;
  panelState.currentSource = { url: run.url, title: run.title };
  currentRunTabId = activeTabId;
  headerController.setBaseTitle(run.title || run.url || "Summarize");
  headerController.setBaseSubtitle("");
  {
    const fallbackModel = panelState.ui?.settings.model ?? null;
    panelState.lastMeta = {
      inputSummary: null,
      model: fallbackModel,
      modelLabel: fallbackModel,
    };
  }
  pendingRunForPlannedSlides = run;
  if (!panelState.summaryMarkdown?.trim()) {
    renderMarkdownDisplay();
  }
  if (!slidesParallelValue) {
    startSlidesStream(run);
  }
  void streamController.start(run);
}

async function fetchSlideTools(requireOcr: boolean): Promise<{
  ok: boolean;
  missing: string[];
}> {
  const token = (await loadSettings()).token.trim();
  if (!token) {
    return { ok: false, missing: ["daemon token"] };
  }
  const res = await fetch("http://127.0.0.1:8787/v1/tools", {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    return { ok: false, missing: ["daemon tools endpoint"] };
  }
  const json = (await res.json()) as {
    ok?: boolean;
    tools?: {
      ytDlp?: { available?: boolean };
      ffmpeg?: { available?: boolean };
      tesseract?: { available?: boolean };
    };
  };
  if (!json.ok || !json.tools) {
    return { ok: false, missing: ["daemon tools endpoint"] };
  }
  const missing: string[] = [];
  if (!json.tools.ytDlp?.available) missing.push("yt-dlp");
  if (!json.tools.ffmpeg?.available) missing.push("ffmpeg");
  if (requireOcr && !json.tools.tesseract?.available) missing.push("tesseract");
  return { ok: missing.length === 0, missing };
}

function showAutomationNotice({
  title,
  message,
  ctaLabel,
  ctaAction,
  sticky,
}: {
  title: string;
  message: string;
  ctaLabel?: string;
  ctaAction?: AutomationNoticeAction;
  sticky?: boolean;
}) {
  automationNoticeSticky = Boolean(sticky);
  automationNoticeTitleEl.textContent = title;
  automationNoticeMessageEl.textContent = message;
  automationNoticeActionBtn.textContent = ctaLabel || "Open extension details";
  automationNoticeActionBtn.onclick = () => {
    if (ctaAction === "options") {
      void chrome.runtime.openOptionsPage();
      return;
    }
    void chrome.tabs.create({ url: `chrome://extensions/?id=${chrome.runtime.id}` });
  };
  automationNoticeEl.classList.remove("hidden");
}

window.addEventListener("summarize:automation-permissions", (event) => {
  const detail = (
    event as CustomEvent<{
      title?: string;
      message?: string;
      ctaLabel?: string;
      ctaAction?: AutomationNoticeAction;
    }>
  ).detail;
  if (!detail?.message) return;
  showAutomationNotice({
    title: detail.title ?? "Automation permission required",
    message: detail.message,
    ctaLabel: detail.ctaLabel,
    ctaAction: detail.ctaAction,
    sticky: true,
  });
});

type AgentResponse = { ok: boolean; assistant?: AssistantMessage; error?: string };
const pendingAgentRequests = new Map<
  string,
  {
    resolve: (response: AgentResponse) => void;
    reject: (error: Error) => void;
    onChunk?: (text: string) => void;
  }
>();

type ChatHistoryResponse = { ok: boolean; messages?: Message[]; error?: string };
const pendingChatHistoryRequests = new Map<
  string,
  { resolve: (response: ChatHistoryResponse) => void; reject: (error: Error) => void }
>();

function abortPendingAgentRequests(reason: string) {
  for (const pending of pendingAgentRequests.values()) {
    pending.reject(new Error(reason));
  }
  pendingAgentRequests.clear();
}

async function hideReplOverlayForActiveTab() {
  if (!activeTabId) return;
  try {
    await chrome.tabs.sendMessage(activeTabId, {
      type: "automation:repl-overlay",
      action: "hide",
      message: null,
    });
  } catch {
    // ignore
  }
}

function requestAgentAbort(reason: string) {
  abortAgentRequested = true;
  abortPendingAgentRequests(reason);
  headerController.setStatus(reason);
  void hideReplOverlayForActiveTab();
}

function wrapMessage(message: Message): ChatMessage {
  return { ...message, id: crypto.randomUUID() };
}

function buildStreamingAssistantMessage(): ChatMessage {
  return {
    id: crypto.randomUUID(),
    role: "assistant",
    content: [],
    api: "openai-completions",
    provider: "openai",
    model: "streaming",
    usage: buildEmptyUsage(),
    stopReason: "stop",
    timestamp: Date.now(),
  };
}

function handleAgentResponse(msg: Extract<BgToPanel, { type: "agent:response" }>) {
  const pending = pendingAgentRequests.get(msg.requestId);
  if (!pending) return;
  pendingAgentRequests.delete(msg.requestId);
  pending.resolve({ ok: msg.ok, assistant: msg.assistant, error: msg.error });
}

function handleAgentChunk(msg: Extract<BgToPanel, { type: "agent:chunk" }>) {
  const pending = pendingAgentRequests.get(msg.requestId);
  if (!pending?.onChunk) return;
  pending.onChunk(msg.text);
}

function handleChatHistoryResponse(msg: Extract<BgToPanel, { type: "chat:history" }>) {
  const pending = pendingChatHistoryRequests.get(msg.requestId);
  if (!pending) return;
  pendingChatHistoryRequests.delete(msg.requestId);
  pending.resolve({ ok: msg.ok, messages: msg.messages, error: msg.error });
}

async function requestAgent(
  messages: Message[],
  tools: string[],
  summary?: string | null,
  opts?: { onChunk?: (text: string) => void },
) {
  const requestId = crypto.randomUUID();
  const response = new Promise<AgentResponse>((resolve, reject) => {
    const timeout = window.setTimeout(() => {
      pendingAgentRequests.delete(requestId);
      reject(new Error("Agent request timed out"));
    }, 60_000);
    pendingAgentRequests.set(requestId, {
      resolve: (result) => {
        window.clearTimeout(timeout);
        resolve(result);
      },
      reject: (error) => {
        window.clearTimeout(timeout);
        reject(error);
      },
      onChunk: opts?.onChunk,
    });
    void send({ type: "panel:agent", requestId, messages, tools, summary });
  });
  return response;
}

async function requestChatHistory(summary?: string | null) {
  const requestId = crypto.randomUUID();
  const response = new Promise<ChatHistoryResponse>((resolve, reject) => {
    const timeout = window.setTimeout(() => {
      pendingChatHistoryRequests.delete(requestId);
      reject(new Error("Chat history request timed out"));
    }, 20_000);
    pendingChatHistoryRequests.set(requestId, {
      resolve: (result) => {
        window.clearTimeout(timeout);
        resolve(result);
      },
      reject: (error) => {
        window.clearTimeout(timeout);
        reject(error);
      },
    });
    void send({ type: "panel:chat-history", requestId, summary });
  });
  return response;
}

chatMessagesEl.addEventListener("click", (event) => {
  const target = event.target as HTMLElement | null;
  if (!target) return;
  const link = target.closest("a.chatTimestamp") as HTMLAnchorElement | null;
  if (!link) return;
  const href = link.getAttribute("href") ?? "";
  if (!href.startsWith("timestamp:")) return;
  const seconds = parseTimestampHref(href);
  if (seconds == null) return;
  event.preventDefault();
  event.stopPropagation();
  void send({ type: "panel:seek", seconds });
});

renderEl.addEventListener("click", (event) => {
  const target = event.target as HTMLElement | null;
  if (!target) return;
  const link = target.closest("a.chatTimestamp") as HTMLAnchorElement | null;
  if (!link) return;
  const href = link.getAttribute("href") ?? "";
  if (!href.startsWith("timestamp:")) return;
  const seconds = parseTimestampHref(href);
  if (seconds == null) return;
  event.preventDefault();
  event.stopPropagation();
  void send({ type: "panel:seek", seconds });
});

async function handleSummarizeControlChange(value: { mode: "page" | "video"; slides: boolean }) {
  const prevSlides = slidesEnabledValue;
  const prevMode = inputMode;
  if (value.slides && !slidesEnabledValue) {
    const tools = await fetchSlideTools(slidesOcrEnabledValue);
    if (!tools.ok) {
      const missing = tools.missing.join(", ");
      showSlideNotice(`Slide extraction requires ${missing}. Install and restart the daemon.`);
      refreshSummarizeControl();
      return;
    }
    hideSlideNotice();
  } else if (!value.slides) {
    hideSlideNotice();
    setSlidesBusy(false);
    stopSlidesStream();
  }
  inputMode = value.mode;
  inputModeOverride = value.mode;
  slidesEnabledValue = value.slides;
  await patchSettings({ slidesEnabled: slidesEnabledValue });
  if (slidesEnabledValue && (inputModeOverride ?? inputMode) === "video") {
    maybeApplyPendingSlidesSummary();
    maybeStartPendingSlidesForUrl(activeTabUrl ?? null);
  }
  if (autoValue && (value.mode !== prevMode || value.slides !== prevSlides)) {
    sendSummarize({ refresh: true });
  }
  refreshSummarizeControl();
}

function handleSlidesTextModeChange(next: SlideTextMode) {
  if (next === slidesTextMode) return;
  if (next === "ocr" && !slidesOcrEnabledValue) return;
  if (next === "ocr" && !slidesOcrAvailable) return;
  slidesTextMode = next;
  rebuildSlideDescriptions();
  if (panelState.summaryMarkdown) {
    renderInlineSlides(renderMarkdownHostEl, { fallback: true });
  } else {
    queueSlidesRender();
  }
  refreshSummarizeControl();
}

function retrySlidesStream() {
  if (!slidesEnabledValue) return;
  hideSlideNotice();
  const runId = resolveActiveSlidesRunId();
  const targetUrl = panelState.currentSource?.url ?? activeTabUrl ?? null;
  if (runId) {
    startSlidesStreamForRunId(runId);
    startSlidesSummaryStreamForRunId(runId, targetUrl);
    return;
  }
  sendSummarize({ refresh: true });
}

function applySlidesLayout() {
  renderMarkdownHostEl.classList.remove("hidden");
  renderSlidesHostEl.dataset.layout = resolveSlidesRenderLayout({
    preferredLayout: slidesLayoutValue,
    slidesEnabled: slidesEnabledValue,
    inputMode: inputModeOverride ?? inputMode,
  });
  renderMarkdownDisplay();
  slidesRenderer.applyLayout();
}

function setSlidesLayout(next: SlidesLayout) {
  if (next === slidesLayoutValue) return;
  slidesLayoutValue = next;
  slidesLayoutEl.value = next;
  applySlidesLayout();
}

const summarizeControl = mountSummarizeControl(summarizeControlRoot, {
  mode: inputMode,
  slidesEnabled: slidesEnabledValue,
  mediaAvailable: false,
  videoLabel: "Video",
  busy: false,
  slidesTextMode,
  slidesTextToggleVisible,
  onSlidesTextModeChange: handleSlidesTextModeChange,
  onChange: handleSummarizeControlChange,
  onSummarize: () => sendSummarize(),
});

function refreshSummarizeControl() {
  summarizeControl.update({
    mode: inputMode,
    slidesEnabled: slidesEnabledValue,
    mediaAvailable,
    busy: slidesBusy,
    videoLabel: summarizeVideoLabel,
    pageWords: summarizePageWords,
    videoDurationSeconds: summarizeVideoDurationSeconds,
    slidesTextMode,
    slidesTextToggleVisible,
    onSlidesTextModeChange: handleSlidesTextModeChange,
    onChange: handleSummarizeControlChange,
    onSummarize: () => sendSummarize(),
  });
}

function normalizeQueueText(input: string) {
  return input.replace(/\s+/g, " ").trim();
}

function renderChatQueue() {
  if (chatQueue.length === 0) {
    chatQueueEl.classList.add("isHidden");
    chatQueueEl.replaceChildren();
    return;
  }
  chatQueueEl.classList.remove("isHidden");
  chatQueueEl.replaceChildren();

  for (const item of chatQueue) {
    const row = document.createElement("div");
    row.className = "chatQueueItem";
    row.dataset.id = item.id;

    const text = document.createElement("div");
    text.className = "chatQueueText";
    text.textContent = item.text;
    text.title = item.text;

    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "chatQueueRemove";
    remove.textContent = "x";
    remove.setAttribute("aria-label", "Remove queued message");
    remove.addEventListener("click", () => removeQueuedMessage(item.id));

    row.append(text, remove);
    chatQueueEl.append(row);
  }
}

function enqueueChatMessage(input: string): boolean {
  const text = normalizeQueueText(input);
  if (!text) return false;
  if (chatQueue.length >= MAX_CHAT_QUEUE) {
    headerController.setStatus(`Queue full (${MAX_CHAT_QUEUE}). Remove one to add more.`);
    return false;
  }
  chatQueue.push({ id: crypto.randomUUID(), text, createdAt: Date.now() });
  renderChatQueue();
  return true;
}

function removeQueuedMessage(id: string) {
  chatQueue = chatQueue.filter((item) => item.id !== id);
  renderChatQueue();
}

function clearQueuedMessages() {
  if (chatQueue.length === 0) return;
  chatQueue = [];
  renderChatQueue();
}

const isStreaming = () => panelState.phase === "connecting" || panelState.phase === "streaming";

const optionsTabStorageKey = "summarize:options-tab";

const openOptionsTab = (tabId: string) => {
  try {
    localStorage.setItem(optionsTabStorageKey, tabId);
  } catch {
    // ignore
  }
  void send({ type: "panel:openOptions" });
};

const headerController = createHeaderController({
  headerEl,
  titleEl,
  subtitleEl,
  progressFillEl,
  getState: () => ({
    phase: panelState.phase,
    summaryFromCache: panelState.summaryFromCache,
  }),
});

headerController.updateHeaderOffset();
window.addEventListener("resize", headerController.updateHeaderOffset);

const errorController = createErrorController({
  panelEl: errorEl,
  panelMessageEl: errorMessageEl,
  panelRetryBtn: errorRetryBtn,
  panelLogsBtn: errorLogsBtn,
  inlineEl: inlineErrorEl,
  inlineMessageEl: inlineErrorMessageEl,
  inlineRetryBtn: inlineErrorRetryBtn,
  inlineLogsBtn: inlineErrorLogsBtn,
  inlineCloseBtn: inlineErrorCloseBtn,
  onRetry: () => retryLastAction(),
  onOpenLogs: () => openOptionsTab("logs"),
  onPanelVisibilityChange: () => headerController.updateHeaderOffset(),
});

slideNoticeRetryBtn.addEventListener("click", () => {
  retrySlidesStream();
});

const setPhase = (phase: PanelPhase, opts?: { error?: string | null }) => {
  panelState.phase = phase;
  panelState.error = phase === "error" ? (opts?.error ?? panelState.error) : null;
  if (phase === "error") {
    const message =
      panelState.error && panelState.error.trim().length > 0
        ? panelState.error
        : "Something went wrong.";
    errorController.showPanelError(message);
    setSlidesBusy(false);
  } else {
    errorController.clearPanelError();
    if (phase !== "streaming" && phase !== "connecting") {
      setSlidesBusy(false);
    }
  }
  if (phase === "connecting" || phase === "streaming") {
    headerController.armProgress();
  }
  if (phase !== "connecting" && phase !== "streaming") {
    headerController.stopProgress();
  }
  if (phase !== "connecting" && phase !== "streaming" && panelState.slides) {
    rebuildSlideDescriptions();
    queueSlidesRender();
  }
};

chrome.runtime.onMessage.addListener((raw, _sender, sendResponse) => {
  if (!raw || typeof raw !== "object") return;
  const type = (raw as { type?: string }).type;
  if (type === "automation:abort-agent") {
    requestAgentAbort("Agent aborted");
    sendResponse?.({ ok: true });
    return true;
  }
});

let autoScrollLocked = true;

const isNearBottom = () => {
  const distance = mainEl.scrollHeight - mainEl.scrollTop - mainEl.clientHeight;
  return distance < 32;
};

const updateAutoScrollLock = () => {
  autoScrollLocked = isNearBottom();
  chatJumpBtn.classList.toggle("isVisible", !autoScrollLocked);
};

const scrollToBottom = (force = false) => {
  if (force) autoScrollLocked = true;
  if (!force && !autoScrollLocked) return;
  mainEl.scrollTop = mainEl.scrollHeight;
  chatJumpBtn.classList.remove("isVisible");
};

mainEl.addEventListener("scroll", updateAutoScrollLock, { passive: true });
updateAutoScrollLock();

chatJumpBtn.addEventListener("click", () => {
  scrollToBottom(true);
  chatInputEl.focus();
});

const updateChatDockHeight = () => {
  const height = chatDockEl.getBoundingClientRect().height;
  document.documentElement.style.setProperty("--chat-dock-height", `${height}px`);
};

updateChatDockHeight();
const chatDockObserver = new ResizeObserver(() => updateChatDockHeight());
chatDockObserver.observe(chatDockEl);

function markAgentNavigationIntent(url: string | null | undefined) {
  const trimmed = typeof url === "string" ? url.trim() : "";
  if (!trimmed) return;
  lastAgentNavigation = { url: trimmed, tabId: null, at: Date.now() };
}

function markAgentNavigationResult(details: unknown) {
  if (!details || typeof details !== "object") return;
  const obj = details as { finalUrl?: unknown; tabId?: unknown };
  const finalUrl = typeof obj.finalUrl === "string" ? obj.finalUrl.trim() : "";
  const tabId = typeof obj.tabId === "number" ? obj.tabId : null;
  if (!finalUrl && tabId == null) return;
  lastAgentNavigation = {
    url: finalUrl || lastAgentNavigation?.url || "",
    tabId,
    at: Date.now(),
  };
}

function isRecentAgentNavigation(tabId: number | null, url: string | null) {
  if (!lastAgentNavigation) return false;
  if (Date.now() - lastAgentNavigation.at > AGENT_NAV_TTL_MS) {
    lastAgentNavigation = null;
    return false;
  }
  if (tabId != null && lastAgentNavigation.tabId != null && tabId === lastAgentNavigation.tabId) {
    return true;
  }
  if (url && lastAgentNavigation.url && panelUrlsMatch(url, lastAgentNavigation.url)) {
    return true;
  }
  return false;
}

function notePreserveChatForUrl(url: string | null) {
  if (!url) return;
  pendingPreserveChatForUrl = { url, at: Date.now() };
}

function shouldPreserveChatForRun(url: string) {
  const pending = pendingPreserveChatForUrl;
  if (pending && Date.now() - pending.at < AGENT_NAV_TTL_MS && panelUrlsMatch(url, pending.url)) {
    pendingPreserveChatForUrl = null;
    return true;
  }
  return isRecentAgentNavigation(null, url);
}

async function migrateChatHistory(fromTabId: number | null, toTabId: number | null) {
  if (!fromTabId || !toTabId || fromTabId === toTabId) return;
  const messages = chatController.getMessages();
  if (messages.length === 0) return;
  await chatHistoryStore.persist(toTabId, messages, true);
}

async function appendNavigationMessage(url: string, title: string | null) {
  if (!url || lastNavigationMessageUrl === url) return;
  lastNavigationMessageUrl = url;

  const skills = await listSkills(url);
  const skillsText =
    skills.length === 0
      ? "Skills: none"
      : `Skills:\n${skills.map((skill) => `- ${skill.name}: ${skill.shortDescription}`).join("\n")}`;

  const text = ["Navigation changed", `Title: ${title || url}`, `URL: ${url}`, skillsText].join(
    "\n",
  );

  const message: ToolResultMessage = {
    role: "toolResult",
    toolCallId: crypto.randomUUID(),
    toolName: "navigation",
    content: [{ type: "text", text }],
    isError: false,
    timestamp: Date.now(),
  };

  chatController.addMessage(wrapMessage(message));
  scrollToBottom(true);
  void persistChatHistory();
}

function canSyncTabUrl(url: string | null | undefined): url is string {
  if (!url) return false;
  if (url.startsWith("chrome://")) return false;
  if (url.startsWith("chrome-extension://")) return false;
  if (url.startsWith("moz-extension://")) return false; // Firefox extension pages
  if (url.startsWith("edge://")) return false;
  if (url.startsWith("about:")) return false;
  return true;
}

async function syncWithActiveTab() {
  if (!panelState.currentSource) return;
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.url || !canSyncTabUrl(tab.url)) return;
    if (!panelUrlsMatch(tab.url, panelState.currentSource.url)) {
      const preserveChat = isRecentAgentNavigation(tab.id ?? null, tab.url);
      if (preserveChat) {
        notePreserveChatForUrl(tab.url);
      }
      panelState.currentSource = null;
      currentRunTabId = null;
      setPhase("idle");
      resetSummaryView({ preserveChat });
      headerController.setBaseTitle(tab.title || tab.url || "Summarize");
      headerController.setBaseSubtitle("");
      return;
    }
    if (tab.title && tab.title !== panelState.currentSource.title) {
      panelState.currentSource = { ...panelState.currentSource, title: tab.title };
      headerController.setBaseTitle(tab.title);
    }
  } catch {
    // ignore
  }
}

function resetSummaryView({
  preserveChat = false,
  clearRunId = true,
  stopSlides = true,
}: {
  preserveChat?: boolean;
  clearRunId?: boolean;
  stopSlides?: boolean;
} = {}) {
  currentRunTabId = null;
  renderEl.replaceChildren(renderSlidesHostEl, renderMarkdownHostEl);
  renderMarkdownHostEl.innerHTML = "";
  slidesRenderer.clear();
  metricsController.clearForMode("summary");
  panelState.summaryMarkdown = null;
  panelState.summaryFromCache = null;
  panelState.slides = null;
  if (clearRunId) {
    panelState.runId = null;
    panelState.slidesRunId = null;
  }
  slidesExpanded = true;
  slidesContextPending = false;
  slidesContextUrl = null;
  setSlidesTranscriptTimedText(null);
  slidesOcrAvailable = false;
  slidesTextToggleVisible = false;
  slidesTextMode = "transcript";
  slideDescriptions = new Map();
  slideSummaryByIndex = new Map();
  slideTitleByIndex = new Map();
  slideSummarySource = null;
  slidesSeededSourceId = null;
  slidesAppliedRunId = null;
  if (stopSlides) {
    stopSlidesStream();
  }
  refreshSummarizeControl();
  if (!preserveChat) {
    resetChatState();
  }
}

async function clearCurrentView() {
  if (panelState.chatStreaming) {
    requestAgentAbort("Cleared");
  }
  streamController.abort();
  stopSlidesStream();
  resetSummaryView({ preserveChat: false });
  await clearChatHistoryForActiveTab();
  panelCacheController.scheduleSync();
  headerController.setStatus("");
  setPhase("idle");
}

function buildPanelCachePayload(): PanelCachePayload | null {
  const tabId = currentRunTabId ?? activeTabId;
  const url = panelState.currentSource?.url ?? activeTabUrl;
  if (!tabId || !url) return null;
  const hasSlidesSummaryState = Boolean(slidesSummaryRunId || slidesSummaryMarkdown.trim());
  return {
    tabId,
    url,
    title: panelState.currentSource?.title ?? null,
    runId: panelState.runId ?? null,
    slidesRunId: panelState.slidesRunId ?? null,
    summaryMarkdown: panelState.summaryMarkdown ?? null,
    summaryFromCache: panelState.summaryFromCache ?? null,
    slidesSummaryMarkdown: slidesSummaryMarkdown || null,
    slidesSummaryComplete: hasSlidesSummaryState ? slidesSummaryComplete : null,
    slidesSummaryModel: hasSlidesSummaryState ? slidesSummaryModel : null,
    lastMeta: panelState.lastMeta,
    slides: panelState.slides ?? null,
    transcriptTimedText: slidesTranscriptTimedText ?? null,
  };
}

function applyPanelCache(payload: PanelCachePayload, opts?: { preserveChat?: boolean }) {
  const preserveChat = opts?.preserveChat ?? false;
  resetSummaryView({ preserveChat });
  panelState.runId = payload.runId ?? null;
  panelState.slidesRunId =
    payload.slidesRunId ?? (slidesParallelValue ? null : (payload.runId ?? null));
  currentRunTabId = payload.tabId;
  panelState.currentSource = { url: payload.url, title: payload.title ?? null };
  panelState.lastMeta = payload.lastMeta ?? { inputSummary: null, model: null, modelLabel: null };
  panelState.summaryFromCache = payload.summaryFromCache ?? null;
  slidesSummaryMarkdown = payload.slidesSummaryMarkdown ?? "";
  slidesSummaryPending = null;
  slidesSummaryHadError = false;
  slidesSummaryComplete =
    payload.slidesSummaryComplete ?? Boolean((payload.slidesSummaryMarkdown ?? "").trim());
  slidesSummaryModel =
    payload.slidesSummaryModel ??
    panelState.lastMeta.model ??
    panelState.ui?.settings.model ??
    null;
  headerController.setBaseTitle(payload.title || payload.url || "Summarize");
  headerController.setBaseSubtitle(
    buildIdleSubtitle({
      inputSummary: panelState.lastMeta.inputSummary,
      modelLabel: panelState.lastMeta.modelLabel,
      model: panelState.lastMeta.model,
    }),
  );
  setSlidesTranscriptTimedText(payload.transcriptTimedText ?? null);
  if (payload.slides) {
    panelState.slides = {
      ...payload.slides,
      slides: payload.slides.slides.map((slide) => ({
        ...slide,
        imageUrl: normalizeSlideImageUrl(
          slide.imageUrl,
          payload.slides?.sourceId ?? "",
          slide.index,
        ),
      })),
    };
    slidesContextPending = false;
    slidesContextUrl = payload.url;
    updateSlidesTextState();
    if (!slidesTranscriptAvailable) {
      void requestSlidesContext();
    }
    slidesAppliedRunId = resolveActiveSlidesRunId();
  } else {
    panelState.slides = null;
    slidesContextPending = false;
    slidesContextUrl = null;
    updateSlidesTextState();
    slidesAppliedRunId = null;
  }
  slidesHydrator.syncFromCache({
    runId: panelState.slidesRunId ?? null,
    summaryFromCache: payload.summaryFromCache,
    hasSlides: Boolean(payload.slides && payload.slides.slides.length > 0),
  });
  if (slidesSummaryMarkdown.trim()) {
    updateSlideSummaryFromMarkdown(slidesSummaryMarkdown, {
      preserveIfEmpty: false,
      source: "slides",
    });
  }
  if (payload.summaryMarkdown) {
    renderMarkdown(payload.summaryMarkdown);
  } else {
    renderMarkdownDisplay();
  }
  queueSlidesRender();
  setPhase("idle");
}

const panelCacheController = createPanelCacheController({
  getSnapshot: buildPanelCachePayload,
  sendCache: (payload) => {
    void send({ type: "panel:cache", cache: payload });
  },
  sendRequest: (request) => {
    void send({ type: "panel:get-cache", ...request });
  },
});

window.addEventListener("error", (event) => {
  const message =
    event.error instanceof Error ? event.error.stack || event.error.message : event.message;
  headerController.setStatus(`Error: ${message}`);
  setPhase("error", { error: message });
});

window.addEventListener("unhandledrejection", (event) => {
  const reason = (event as PromiseRejectionEvent).reason;
  const message = reason instanceof Error ? reason.stack || reason.message : String(reason);
  headerController.setStatus(`Error: ${message}`);
  setPhase("error", { error: message });
});

function renderEmptySummaryState() {
  const state = buildSummaryEmptyState({
    tabTitle: panelState.currentSource?.title ?? panelState.ui?.tab.title ?? null,
    tabUrl: panelState.currentSource?.url ?? panelState.ui?.tab.url ?? activeTabUrl ?? null,
    autoSummarize: autoValue,
    phase: panelState.phase,
    hasSlides: Boolean(panelState.slides?.slides.length),
  });
  if (!state) {
    renderMarkdownHostEl.innerHTML = "";
    return;
  }
  const wrapper = document.createElement("section");
  wrapper.className = "renderEmpty";
  wrapper.dataset.emptyState = "true";
  const label = document.createElement("div");
  label.className = "renderEmpty__label";
  label.textContent = state.label;
  const message = document.createElement("p");
  message.className = "renderEmpty__message";
  message.textContent = state.message;
  wrapper.append(label, message);
  if (state.detail) {
    const detail = document.createElement("p");
    detail.className = "renderEmpty__detail";
    detail.textContent = state.detail;
    wrapper.append(detail);
  }
  renderMarkdownHostEl.replaceChildren(wrapper);
}

function renderMarkdownDisplay() {
  const markdown = panelState.summaryMarkdown ?? "";
  const displayMarkdown = selectMarkdownForLayout({
    markdown,
    slidesEnabled: slidesEnabledValue,
    inputMode: inputModeOverride ?? inputMode,
    hasSlides: Boolean(panelState.slides?.slides.length),
    slidesLayout: slidesLayoutValue,
  });
  if (!displayMarkdown.trim()) {
    renderEmptySummaryState();
    return;
  }
  try {
    renderMarkdownHostEl.innerHTML = md.render(linkifyTimestamps(displayMarkdown));
  } catch (err) {
    const message = err instanceof Error ? err.stack || err.message : String(err);
    headerController.setStatus(`Error: ${message}`);
    return;
  }
  for (const a of Array.from(renderMarkdownHostEl.querySelectorAll("a"))) {
    const href = a.getAttribute("href") ?? "";
    if (href.startsWith("timestamp:")) {
      a.classList.add("chatTimestamp");
      a.removeAttribute("target");
      a.removeAttribute("rel");
      continue;
    }
    a.setAttribute("target", "_blank");
    a.setAttribute("rel", "noopener noreferrer");
  }
  renderInlineSlides(renderMarkdownHostEl, { fallback: true });
}

function renderMarkdown(markdown: string) {
  panelState.summaryMarkdown = markdown;
  updateSlideSummaryFromMarkdown(markdown, {
    preserveIfEmpty: slideSummaryByIndex.size > 0,
    source: "summary",
  });
  renderMarkdownDisplay();
  panelCacheController.scheduleSync();
}

function updateSlideSummaryFromMarkdown(
  markdown: string,
  opts?: { preserveIfEmpty?: boolean; source?: "summary" | "slides" },
) {
  const source = opts?.source ?? "summary";
  if (source === "summary" && slideSummarySource === "slides") return;
  const derived = deriveSlideSummaries({
    markdown,
    slides: panelState.slides?.slides ?? [],
    transcriptTimedText: slidesTranscriptTimedText,
    lengthValue: pickerSettings.length,
  });
  if (!derived) {
    if (opts?.preserveIfEmpty) return;
    slideSummaryByIndex = new Map();
    slideTitleByIndex = new Map();
    if (source === "slides") {
      slideSummarySource = null;
    } else if (!slideSummarySource) {
      slideSummarySource = "summary";
    }
    rebuildSlideDescriptions();
    queueSlidesRender();
    return;
  }
  slideSummaryByIndex = derived.summaries;
  slideTitleByIndex = derived.titles;
  slideSummarySource = source;
  rebuildSlideDescriptions();
  queueSlidesRender();
}

function setSlidesBusy(next: boolean) {
  if (slidesBusy === next) return;
  slidesBusy = next;
  const toggle = document.querySelector<HTMLButtonElement>(".summarizeSlideToggle");
  if (toggle) {
    toggle.dataset.busy = next ? "true" : "false";
  }
  headerController.setProgressOverride(next);
  refreshSummarizeControl();
}

function seekToSlideTimestamp(seconds: number | null | undefined) {
  if (seconds == null || !Number.isFinite(seconds)) return;
  void send({ type: "panel:seek", seconds: Math.floor(seconds) });
}
function rebuildSlideDescriptions() {
  slideDescriptions = new Map();
  if (!panelState.slides) return;
  slideDescriptions = buildSlideDescriptions({
    slides: panelState.slides.slides,
    transcriptTimedText: slidesTranscriptTimedText,
    lengthValue: pickerSettings.length,
    slidesTextMode,
    slidesOcrEnabled: slidesOcrEnabledValue,
    slidesOcrAvailable,
    slidesTranscriptAvailable,
  });
}

function updateSlidesTextState() {
  const nextState = resolveSlidesTextState({
    slides: panelState.slides?.slides ?? [],
    slidesOcrEnabled: slidesOcrEnabledValue,
    slidesTranscriptAvailable,
    currentMode: slidesTextMode,
  });
  slidesOcrAvailable = nextState.slidesOcrAvailable;
  slidesTextToggleVisible = nextState.slidesTextToggleVisible;
  slidesTextMode = nextState.slidesTextMode;
  rebuildSlideDescriptions();
  refreshSummarizeControl();
  queueSlidesRender();
}

function updateSlideThumb(
  img: HTMLImageElement,
  thumb: HTMLElement,
  imageUrl: string | null | undefined,
) {
  if (imageUrl) {
    thumb.classList.add("isPlaceholder");
    slideImageLoader.observe(img, imageUrl);
    return;
  }
  thumb.classList.add("isPlaceholder");
  img.removeAttribute("src");
  img.dataset.loaded = "false";
  img.dataset.slideImageUrl = "";
}

function updateSlideMeta(
  el: HTMLElement,
  index: number,
  timestamp: number | null | undefined,
  title?: string | null,
  total?: number | null,
) {
  const formatted = formatSlideTimestamp(timestamp);
  const totalCount = typeof total === "number" && total > 0 ? total : null;
  const slideLabel = totalCount ? `Slide ${index}/${totalCount}` : `Slide ${index}`;
  if (title) {
    el.textContent = formatted ? `${title} · ${formatted}` : title;
    return;
  }
  if (formatted) {
    el.textContent = `${slideLabel} · ${formatted}`;
    return;
  }
  el.textContent = slideLabel;
}

const slidesRenderer = createSlidesRenderer({
  hostEl: renderSlidesHostEl,
  markdownHostEl: renderMarkdownHostEl,
  getState: () => ({
    slidesEnabled: slidesEnabledValue,
    inputMode: inputModeOverride ?? inputMode,
    preferredLayout: slidesLayoutValue,
    slidesExpanded,
    slides: panelState.slides,
    descriptions: slideDescriptions,
    titles: slideTitleByIndex,
  }),
  ensureDescriptions: rebuildSlideDescriptions,
  onSeek: seekToSlideTimestamp,
  setExpanded: (next) => {
    slidesExpanded = next;
  },
  updateThumb: updateSlideThumb,
  updateMeta: updateSlideMeta,
});

function applySlidesPayload(data: SseSlidesData) {
  const isSameSource = Boolean(panelState.slides && panelState.slides.sourceId === data.sourceId);
  const activeSlidesRunId = resolveActiveSlidesRunId();
  const normalized: SseSlidesData = {
    ...data,
    slides: data.slides.map((slide) => ({
      ...slide,
      imageUrl: normalizeSlideImageUrl(slide.imageUrl, data.sourceId, slide.index),
    })),
  };
  const shouldReplaceSeeded = slidesSeededSourceId === data.sourceId;
  const merged = resolveSlidesPayload(panelState.slides, normalized, {
    seededSourceId: slidesSeededSourceId,
    activeSlidesRunId,
    appliedSlidesRunId: slidesAppliedRunId,
  });
  if (shouldReplaceSeeded) {
    slidesSeededSourceId = null;
  }
  if (!slidesPayloadChanged(panelState.slides, merged)) {
    if (activeSlidesRunId) {
      slidesAppliedRunId = activeSlidesRunId;
    }
    return;
  }
  panelState.slides = merged;
  if (activeSlidesRunId) {
    slidesAppliedRunId = activeSlidesRunId;
  }
  if (!isSameSource) {
    slidesContextPending = false;
    slidesContextUrl = null;
    setSlidesTranscriptTimedText(null);
    void requestSlidesContext();
  }
  updateSlidesTextState();
  if (panelState.summaryMarkdown) {
    renderInlineSlides(renderMarkdownHostEl, { fallback: true });
  }
  hideSlideNotice();
  renderInlineSlides(chatMessagesEl);
  queueSlidesRender();
  panelCacheController.scheduleSync();
}

const slidesTestHooks = (
  globalThis as {
    __summarizeTestHooks?: {
      applySlidesPayload?: (payload: SseSlidesData) => void;
      getRunId?: () => string | null;
      getSummaryMarkdown?: () => string;
      getSlideDescriptions?: () => Array<[number, string]>;
      getPhase?: () => PanelPhase;
      getModel?: () => string | null;
      getSlidesTimeline?: () => Array<{ index: number; timestamp: number | null }>;
      getTranscriptTimedText?: () => string | null;
      getSlidesSummaryMarkdown?: () => string;
      getSlidesSummaryComplete?: () => boolean;
      getSlidesSummaryModel?: () => string | null;
      setTranscriptTimedText?: (value: string | null) => void;
      setSummarizeMode?: (payload: { mode: "page" | "video"; slides: boolean }) => Promise<void>;
      getSummarizeMode?: () => { mode: "page" | "video"; slides: boolean; mediaAvailable: boolean };
      getSlidesState?: () => { slidesCount: number; layout: SlidesLayout; hasSlides: boolean };
      renderSlidesNow?: () => void;
      applyUiState?: (state: UiState) => void;
      applyBgMessage?: (message: BgToPanel) => void;
      applySummarySnapshot?: (payload: { run: RunStart; markdown: string }) => void;
      applySummaryMarkdown?: (markdown: string) => void;
      forceRenderSlides?: () => void;
      showInlineError?: (message: string) => void;
      isInlineErrorVisible?: () => boolean;
      getInlineErrorMessage?: () => string;
    };
  }
).__summarizeTestHooks;
if (slidesTestHooks) {
  slidesTestHooks.applySlidesPayload = applySlidesPayload;
  slidesTestHooks.getRunId = () => panelState.runId;
  slidesTestHooks.getSummaryMarkdown = () => panelState.summaryMarkdown ?? "";
  slidesTestHooks.getSlideDescriptions = () => Array.from(slideDescriptions.entries());
  slidesTestHooks.getPhase = () => panelState.phase;
  slidesTestHooks.getModel = () => panelState.lastMeta.model ?? null;
  slidesTestHooks.getSlidesTimeline = () =>
    panelState.slides?.slides.map((slide) => ({
      index: slide.index,
      timestamp: Number.isFinite(slide.timestamp) ? slide.timestamp : null,
    })) ?? [];
  slidesTestHooks.getTranscriptTimedText = () => slidesTranscriptTimedText;
  slidesTestHooks.getSlidesSummaryMarkdown = () => slidesSummaryMarkdown;
  slidesTestHooks.getSlidesSummaryComplete = () => slidesSummaryComplete;
  slidesTestHooks.getSlidesSummaryModel = () => slidesSummaryModel;
  slidesTestHooks.setTranscriptTimedText = (value) => {
    setSlidesTranscriptTimedText(value);
    updateSlidesTextState();
  };
  slidesTestHooks.setSummarizeMode = async (payload) => {
    await handleSummarizeControlChange(payload);
  };
  slidesTestHooks.getSummarizeMode = () => ({
    mode: inputModeOverride ?? inputMode,
    slides: slidesEnabledValue,
    mediaAvailable,
  });
  slidesTestHooks.getSlidesState = () => ({
    slidesCount: panelState.slides?.slides.length ?? 0,
    layout: slidesLayoutValue,
    hasSlides: Boolean(panelState.slides),
  });
  slidesTestHooks.renderSlidesNow = () => {
    queueSlidesRender();
  };
  slidesTestHooks.applyUiState = (state) => {
    panelState.ui = state;
    updateControls(state);
  };
  slidesTestHooks.applyBgMessage = (message) => {
    handleBgMessage(message);
  };
  slidesTestHooks.applySummarySnapshot = (payload) => {
    resetSummaryView({ preserveChat: false, clearRunId: false, stopSlides: false });
    panelState.runId = payload.run.id;
    panelState.slidesRunId = slidesParallelValue ? null : payload.run.id;
    panelState.currentSource = { url: payload.run.url, title: payload.run.title };
    currentRunTabId = activeTabId;
    headerController.setBaseTitle(payload.run.title || payload.run.url || "Summarize");
    headerController.setBaseSubtitle("");
    renderMarkdown(payload.markdown);
    setPhase("idle");
  };
  slidesTestHooks.applySummaryMarkdown = (markdown) => {
    renderMarkdown(markdown);
    setPhase("idle");
  };
  slidesTestHooks.forceRenderSlides = () => {
    slidesEnabledValue = true;
    inputMode = "video";
    inputModeOverride = "video";
    return slidesRenderer.forceRender();
  };
  slidesTestHooks.showInlineError = (message) => {
    errorController.showInlineError(message);
  };
  slidesTestHooks.isInlineErrorVisible = () => !inlineErrorEl.classList.contains("hidden");
  slidesTestHooks.getInlineErrorMessage = () => inlineErrorMessageEl.textContent ?? "";
}

async function requestSlidesContext() {
  if (!panelState.slides || slidesContextPending) return;
  const sourceUrl = panelState.slides.sourceUrl || panelState.currentSource?.url || null;
  if (sourceUrl && slidesContextUrl === sourceUrl) return;
  slidesContextPending = true;
  slidesContextRequestId += 1;
  const requestId = `slides-${slidesContextRequestId}`;
  slidesContextUrl = sourceUrl;
  void send({ type: "panel:slides-context", requestId, url: sourceUrl ?? undefined });
}

function queueSlidesRender() {
  slidesRenderer.queueRender();
}

function renderInlineSlides(container: HTMLElement, opts?: { fallback?: boolean }) {
  slidesRenderer.renderInline(container, opts);
}

const LINE_HEIGHT_STEP = 0.1;

let pickerSettings = {
  scheme: defaultSettings.colorScheme,
  mode: defaultSettings.colorMode,
  fontFamily: defaultSettings.fontFamily,
  length: defaultSettings.length,
};

const pickerHandlers = {
  onSchemeChange: (value) => {
    void (async () => {
      const next = await patchSettings({ colorScheme: value });
      pickerSettings = { ...pickerSettings, scheme: next.colorScheme, mode: next.colorMode };
      applyTheme({ scheme: next.colorScheme, mode: next.colorMode });
    })();
  },
  onModeChange: (value) => {
    void (async () => {
      const next = await patchSettings({ colorMode: value });
      pickerSettings = { ...pickerSettings, scheme: next.colorScheme, mode: next.colorMode };
      applyTheme({ scheme: next.colorScheme, mode: next.colorMode });
    })();
  },
  onFontChange: (value) => {
    void (async () => {
      const next = await patchSettings({ fontFamily: value });
      pickerSettings = { ...pickerSettings, fontFamily: next.fontFamily };
      typographyController.apply(next.fontFamily, next.fontSize, next.lineHeight);
      typographyController.setCurrentFontSize(next.fontSize);
      typographyController.setCurrentLineHeight(next.lineHeight);
    })();
  },
  onLengthChange: (value) => {
    pickerSettings = { ...pickerSettings, length: value };
    void send({ type: "panel:setLength", value });
  },
};

const pickers = mountSidepanelPickers(pickersRoot, {
  scheme: pickerSettings.scheme,
  mode: pickerSettings.mode,
  fontFamily: pickerSettings.fontFamily,
  onSchemeChange: pickerHandlers.onSchemeChange,
  onModeChange: pickerHandlers.onModeChange,
  onFontChange: pickerHandlers.onFontChange,
});

const lengthPicker = mountSidepanelLengthPicker(lengthRoot, {
  length: pickerSettings.length,
  onLengthChange: pickerHandlers.onLengthChange,
});

const autoToggle = mountCheckbox(autoToggleRoot, {
  id: "sidepanel-auto",
  label: "Auto summarize",
  checked: autoValue,
  onCheckedChange: (checked) => {
    autoValue = checked;
    void send({ type: "panel:setAuto", value: checked });
  },
});

function applyChatEnabled() {
  chatContainerEl.toggleAttribute("hidden", !chatEnabledValue);
  chatDockEl.toggleAttribute("hidden", !chatEnabledValue);
  if (!chatEnabledValue) {
    chatJumpBtn.classList.remove("isVisible");
  }
  if (!chatEnabledValue) {
    metricsController.clearForMode("chat");
    resetChatState();
    clearQueuedMessages();
  } else {
    renderEl.classList.remove("hidden");
  }
}

async function clearChatHistoryForTab(tabId: number | null) {
  await chatHistoryStore.clear(tabId);
}

async function clearChatHistoryForActiveTab() {
  await clearChatHistoryForTab(activeTabId);
}

async function loadChatHistory(tabId: number): Promise<ChatMessage[] | null> {
  return chatHistoryStore.load(tabId);
}

async function persistChatHistory() {
  if (!chatEnabledValue) return;
  const tabId = activeTabId;
  if (!tabId) return;
  const messages = chatController.getMessages();
  const compacted = compactChatHistory(messages, chatLimits);
  if (compacted.length !== messages.length) {
    chatController.setMessages(compacted, { scroll: false });
  }
  await chatHistoryStore.persist(tabId, compacted, chatEnabledValue);
}

async function restoreChatHistory() {
  const tabId = activeTabId;
  if (!tabId) return;
  chatHistoryLoadId += 1;
  const loadId = chatHistoryLoadId;
  const history = await loadChatHistory(tabId);
  if (loadId !== chatHistoryLoadId) return;
  if (history?.length) {
    const compacted = compactChatHistory(history, chatLimits);
    chatController.setMessages(compacted, { scroll: false });
    return;
  }

  try {
    const response = await requestChatHistory(panelState.summaryMarkdown);
    if (loadId !== chatHistoryLoadId || !response.ok || !Array.isArray(response.messages)) {
      return;
    }
    const parsed = response.messages
      .filter((msg) => msg && typeof msg === "object")
      .map((msg) => normalizeStoredMessage(msg as Record<string, unknown>))
      .filter((msg): msg is ChatMessage => Boolean(msg));
    if (!parsed.length) return;
    const compacted = await chatHistoryStore.persist(tabId, parsed, true);
    chatController.setMessages(compacted, { scroll: false });
  } catch {
    // ignore
  }
}

type PlatformKind = "mac" | "windows" | "linux" | "other";

function resolvePlatformKind(): PlatformKind {
  const nav = navigator as Navigator & { userAgentData?: { platform?: string } };
  const raw = (nav.userAgentData?.platform ?? navigator.platform ?? navigator.userAgent ?? "")
    .toLowerCase()
    .trim();

  if (raw.includes("mac")) return "mac";
  if (raw.includes("win")) return "windows";
  if (raw.includes("linux") || raw.includes("cros") || raw.includes("chrome os")) return "linux";
  return "other";
}

const platformKind = resolvePlatformKind();

function friendlyFetchError(err: unknown, context: string): string {
  const message = err instanceof Error ? err.message : String(err);
  if (message.toLowerCase() === "failed to fetch") {
    return `${context}: Failed to fetch (daemon unreachable or blocked by Chrome; try \`summarize daemon status\`, maybe \`summarize daemon restart\`, and check ~/.summarize/logs/daemon.err.log)`;
  }
  return `${context}: ${message}`;
}

const modelPresetsController = createModelPresetsController({
  modelPresetEl,
  modelCustomEl,
  modelRefreshBtn,
  modelStatusEl,
  modelRowEl,
  defaultModel: defaultSettings.model,
  loadSettings,
  friendlyFetchError,
});
const setModelStatus = modelPresetsController.setStatus;
const setDefaultModelPresets = modelPresetsController.setDefaultPresets;
const setModelPlaceholderFromDiscovery = modelPresetsController.setPlaceholderFromDiscovery;
const readCurrentModelValue = modelPresetsController.readCurrentValue;
const updateModelRowUI = modelPresetsController.updateRowUI;
const setModelValue = modelPresetsController.setValue;
const refreshModelPresets = modelPresetsController.refreshPresets;
const refreshModelsIfStale = modelPresetsController.refreshIfStale;
const runRefreshFree = modelPresetsController.runRefreshFree;
const isRefreshFreeRunning = modelPresetsController.isRefreshFreeRunning;

function handleSlidesStatus(text: string) {
  const trimmed = text.trim();
  if (!trimmed) return;
  if (!/^slides?/i.test(trimmed)) return;
  setSlidesBusy(true);
  if (panelState.phase === "connecting" || panelState.phase === "streaming") return;
  headerController.setStatus(trimmed);
}

function startSlidesStreamForRunId(runId: string) {
  const effectiveInputMode = inputModeOverride ?? inputMode;
  const slidesAllowed = slidesEnabledValue || panelState.ui?.settings.slidesEnabled;
  if (!slidesAllowed) {
    stopSlidesStream();
    return;
  }
  if (effectiveInputMode !== "video") {
    inputMode = "video";
    inputModeOverride = "video";
    refreshSummarizeControl();
  }
  hideSlideNotice();
  setSlidesBusy(true);
  panelState.slidesRunId = runId;
  panelCacheController.scheduleSync();
  void slidesHydrator.start(runId);
}

function startSlidesStream(run: RunStart) {
  startSlidesStreamForRunId(run.id);
}

function applySlidesSummaryMarkdown(markdown: string) {
  if (!markdown.trim()) return;
  const currentUrl = panelState.currentSource?.url ?? activeTabUrl ?? null;
  if (slidesSummaryUrl && currentUrl && !panelUrlsMatch(slidesSummaryUrl, currentUrl)) return;
  if (!slidesEnabledValue) {
    slidesSummaryPending = markdown;
    return;
  }
  const effectiveInputMode = inputModeOverride ?? inputMode;
  if (effectiveInputMode !== "video") {
    slidesSummaryPending = markdown;
    return;
  }
  let output = markdown;
  if (panelState.slides?.slides.length) {
    const lengthArg = resolveSlidesLengthArg(pickerSettings.length);
    const timeline: SlideTimelineEntry[] = panelState.slides.slides.map((slide) => ({
      index: slide.index,
      timestamp: Number.isFinite(slide.timestamp) ? slide.timestamp : Number.NaN,
    }));
    output = coerceSummaryWithSlides({
      markdown,
      slides: timeline,
      transcriptTimedText: slidesTranscriptTimedText,
      lengthArg,
    });
  }
  updateSlideSummaryFromMarkdown(output, { preserveIfEmpty: false, source: "slides" });
  if (!panelState.summaryMarkdown?.trim()) {
    renderMarkdown(output);
  }
}

function maybeApplyPendingSlidesSummary() {
  if (!slidesSummaryPending) return;
  if (panelState.phase === "connecting" || panelState.phase === "streaming") return;
  const markdown = slidesSummaryPending;
  slidesSummaryPending = null;
  applySlidesSummaryMarkdown(markdown);
}

function startSlidesSummaryStreamForRunId(runId: string, targetUrl?: string | null) {
  const effectiveInputMode = inputModeOverride ?? inputMode;
  const slidesAllowed = slidesEnabledValue || panelState.ui?.settings.slidesEnabled;
  if (!slidesAllowed) {
    stopSlidesSummaryStream();
    return;
  }
  if (effectiveInputMode !== "video") {
    inputMode = "video";
    inputModeOverride = "video";
    refreshSummarizeControl();
  }
  if (slidesSummaryRunId === runId) return;
  stopSlidesSummaryStream();
  slidesSummaryRunId = runId;
  slidesSummaryUrl = targetUrl ?? null;
  slidesSummaryMarkdown = "";
  slidesSummaryHadError = false;
  slidesSummaryComplete = false;
  slidesSummaryModel = panelState.lastMeta.model ?? panelState.ui?.settings.model ?? "auto";
  const url = targetUrl ?? panelState.currentSource?.url ?? activeTabUrl ?? "";
  void slidesSummaryController.start({
    id: runId,
    url,
    title: panelState.currentSource?.title ?? null,
    model: panelState.lastMeta.model ?? "auto",
    reason: "slides-summary",
  });
}

const slidesHydrator = createSlidesHydrator({
  getToken: async () => (await loadSettings()).token,
  onSlides: (data) => {
    applySlidesPayload(data);
  },
  onStatus: (text) => {
    handleSlidesStatus(text);
  },
  onError: (err) => {
    const message = friendlyFetchError(err, "Slides stream failed");
    showSlideNotice(message, { allowRetry: true });
    setSlidesBusy(false);
    if (!isStreaming()) {
      headerController.setStatus("");
    }
    void slidesHydrator.hydrateSnapshot("timeout");
    return message;
  },
  onSnapshotError: (err) => {
    const message = err instanceof Error ? err.message : String(err);
    console.debug("[summarize] slides snapshot failed", message);
  },
  onDone: () => {
    setSlidesBusy(false);
    if (panelState.phase === "idle") {
      headerController.setStatus("");
    }
  },
});

const slidesSummaryController = createStreamController({
  getToken: async () => (await loadSettings()).token,
  onStatus: () => {},
  onPhaseChange: () => {},
  onMeta: (meta) => {
    if (typeof meta.model === "string") {
      slidesSummaryModel = meta.model;
    }
  },
  idleTimeoutMs: 600_000,
  idleTimeoutMessage: "Slides summary stalled. The daemon may have stopped.",
  onRender: (markdown) => {
    slidesSummaryMarkdown = markdown;
    const effectiveInputMode = inputModeOverride ?? inputMode;
    if (slidesEnabledValue && effectiveInputMode === "video" && panelState.slides) {
      updateSlideSummaryFromMarkdown(markdown, { preserveIfEmpty: true, source: "slides" });
      if (panelState.summaryMarkdown) {
        renderInlineSlides(renderMarkdownHostEl, { fallback: true });
      }
    }
  },
  onReset: () => {
    slidesSummaryMarkdown = "";
    slidesSummaryPending = null;
    slidesSummaryHadError = false;
    slidesSummaryComplete = false;
    slidesSummaryModel = panelState.lastMeta.model ?? panelState.ui?.settings.model ?? "auto";
  },
  onError: (err) => {
    slidesSummaryHadError = true;
    return friendlyFetchError(err, "Slides summary failed");
  },
  onDone: () => {
    if (slidesSummaryHadError) {
      slidesSummaryComplete = false;
      return;
    }
    slidesSummaryComplete = true;
    const markdown = slidesSummaryMarkdown;
    if (!markdown.trim()) return;
    if (panelState.phase === "connecting" || panelState.phase === "streaming") {
      slidesSummaryPending = markdown;
      return;
    }
    applySlidesSummaryMarkdown(markdown);
  },
});

const streamController = createStreamController({
  getToken: async () => (await loadSettings()).token,
  onReset: () => {
    const preserveChat = preserveChatOnNextReset;
    preserveChatOnNextReset = false;
    resetSummaryView({ preserveChat, clearRunId: false, stopSlides: false });
    {
      const fallbackModel = panelState.ui?.settings.model ?? null;
      panelState.lastMeta = {
        inputSummary: null,
        model: fallbackModel,
        modelLabel: fallbackModel,
      };
    }
    lastStreamError = null;
    if (pendingRunForPlannedSlides) {
      seedPlannedSlidesForRun(pendingRunForPlannedSlides);
      pendingRunForPlannedSlides = null;
    }
  },
  onStatus: (text) => {
    headerController.setStatus(text);
    const trimmed = text.trim();
    const isSlideStatus = /^slides?/i.test(trimmed);
    if (isSlideStatus) setSlidesBusy(true);
  },
  onBaseTitle: (text) => headerController.setBaseTitle(text),
  onBaseSubtitle: (text) => headerController.setBaseSubtitle(text),
  onPhaseChange: (phase) => {
    if (phase === "error") {
      setPhase("error", { error: lastStreamError ?? panelState.error });
    } else {
      setPhase(phase);
    }
    if (phase === "idle") {
      maybeApplyPendingSlidesSummary();
      if (panelState.slides && slideSummaryByIndex.size === 0) {
        rebuildSlideDescriptions();
        queueSlidesRender();
      }
    }
  },
  onRememberUrl: (url) => void send({ type: "panel:rememberUrl", url }),
  onMeta: (data) => {
    panelState.lastMeta = {
      model: typeof data.model === "string" ? data.model : panelState.lastMeta.model,
      modelLabel:
        typeof data.modelLabel === "string" ? data.modelLabel : panelState.lastMeta.modelLabel,
      inputSummary:
        typeof data.inputSummary === "string"
          ? data.inputSummary
          : panelState.lastMeta.inputSummary,
    };
    headerController.setBaseSubtitle(
      buildIdleSubtitle({
        inputSummary: panelState.lastMeta.inputSummary,
        modelLabel: panelState.lastMeta.modelLabel,
        model: panelState.lastMeta.model,
      }),
    );
    panelCacheController.scheduleSync();
  },
  onSlides: (data) => {
    slidesHydrator.handlePayload(data);
  },
  onSummaryFromCache: (value) => {
    panelState.summaryFromCache = value;
    slidesHydrator.handleSummaryFromCache(value);
    panelCacheController.scheduleSync();
    if (value === true) {
      headerController.stopProgress();
    } else if (value === false && isStreaming()) {
      headerController.armProgress();
    }
  },
  onMetrics: (summary) => {
    metricsController.setForMode(
      "summary",
      summary,
      panelState.lastMeta.inputSummary,
      panelState.currentSource?.url ?? null,
    );
    metricsController.setActiveMode("summary");
  },
  onRender: renderMarkdown,
  onSyncWithActiveTab: syncWithActiveTab,
  onError: (err) => {
    const message = friendlyFetchError(err, "Stream failed");
    lastStreamError = message;
    return message;
  },
});

async function ensureToken(): Promise<string> {
  const settings = await loadSettings();
  if (settings.token.trim()) return settings.token.trim();
  const token = generateToken();
  await patchSettings({ token });
  return token;
}

function renderSetup(token: string) {
  setupEl.classList.remove("hidden");
  setupEl.innerHTML = installStepsHtml({
    token,
    headline: "Setup",
    message: "Install summarize, then register the daemon so the side panel can stream summaries.",
    platformKind,
  });
  wireSetupButtons({
    setupEl,
    token,
    platformKind,
    headerSetStatus: (text) => headerController.setStatus(text),
    getStatusResetText: () => panelState.ui?.status ?? "",
    patchSettings,
    generateToken,
    renderSetup,
  });
}

function maybeShowSetup(state: UiState): boolean {
  if (!state.settings.tokenPresent) {
    void (async () => {
      const token = await ensureToken();
      renderSetup(token);
    })();
    return true;
  }
  if (!state.daemon.ok || !state.daemon.authed) {
    setupEl.classList.remove("hidden");
    const token = (async () => (await loadSettings()).token.trim())();
    void token.then((t) => {
      setupEl.innerHTML = `
        ${installStepsHtml({
          token: t,
          headline: "Daemon not reachable",
          message: state.daemon.error ?? "Check that the LaunchAgent is installed.",
          platformKind,
          showTroubleshooting: true,
        })}
      `;
      wireSetupButtons({
        setupEl,
        token: t,
        platformKind,
        headerSetStatus: (text) => headerController.setStatus(text),
        getStatusResetText: () => panelState.ui?.status ?? "",
        patchSettings,
        generateToken,
        renderSetup,
      });
    });
    return true;
  }
  setupEl.classList.add("hidden");
  return false;
}

function updateControls(state: UiState) {
  if (state.panelOpen && !lastPanelOpen) {
    errorController.clearInlineError();
  }
  lastPanelOpen = state.panelOpen;
  const nextTabId = state.tab.id ?? null;
  const nextTabUrl = state.tab.url ?? null;
  const preferUrlMode = nextTabUrl ? shouldPreferUrlMode(nextTabUrl) : false;
  const hasActiveChat =
    panelState.chatStreaming || chatQueue.length > 0 || chatController.getMessages().length > 0;
  const hasMediaInfo = state.media != null;
  const mediaFromState = Boolean(state.media && (state.media.hasVideo || state.media.hasAudio));
  const preserveChatForTab =
    (activeTabId === null && nextTabId !== null && hasActiveChat) ||
    isRecentAgentNavigation(nextTabId, nextTabUrl);
  const preserveChatForUrl =
    (activeTabUrl === null && nextTabUrl !== null && hasActiveChat) ||
    isRecentAgentNavigation(activeTabId, nextTabUrl);
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
      notePreserveChatForUrl(nextTabUrl ?? lastAgentNavigation?.url ?? null);
    }
    const previousTabId = activeTabId;
    activeTabId = nextTabId;
    activeTabUrl = nextTabUrl;
    if (panelState.chatStreaming && navigation.shouldAbortChatStream) {
      requestAgentAbort("Tab changed");
    }
    if (navigation.shouldClearChat) {
      void clearChatHistoryForActiveTab();
      resetChatState();
    } else if (navigation.shouldMigrateChat) {
      void migrateChatHistory(previousTabId, nextTabId);
    }
    if (navigation.nextInputMode) {
      inputMode = navigation.nextInputMode;
    }
    if (navigation.resetInputModeOverride) {
      inputModeOverride = null;
    }
    if (nextTabId && nextTabUrl) {
      if (!maybeStartPendingSummaryRunForUrl(nextTabUrl)) {
        const cached = panelCacheController.resolve(nextTabId, nextTabUrl);
        if (cached) {
          applyPanelCache(cached, { preserveChat: navigation.preserveChat });
        } else {
          panelState.currentSource = null;
          currentRunTabId = null;
          resetSummaryView({ preserveChat: navigation.preserveChat });
          panelCacheController.request(nextTabId, nextTabUrl, navigation.preserveChat);
        }
      }
    } else {
      panelState.currentSource = null;
      currentRunTabId = null;
      resetSummaryView({ preserveChat: navigation.preserveChat });
    }
  } else if (navigation.kind === "url") {
    activeTabUrl = nextTabUrl;
    if (navigation.preserveChat) {
      notePreserveChatForUrl(nextTabUrl);
    } else if (navigation.shouldClearChat) {
      void clearChatHistoryForActiveTab();
      resetChatState();
    }
    if (activeTabId && nextTabUrl) {
      if (!maybeStartPendingSummaryRunForUrl(nextTabUrl)) {
        const cached = panelCacheController.resolve(activeTabId, nextTabUrl);
        if (cached) {
          applyPanelCache(cached, { preserveChat: navigation.preserveChat });
        } else {
          panelState.currentSource = null;
          currentRunTabId = null;
          resetSummaryView({ preserveChat: navigation.preserveChat });
          panelCacheController.request(activeTabId, nextTabUrl, navigation.preserveChat);
        }
      }
    } else {
      panelState.currentSource = null;
      currentRunTabId = null;
      resetSummaryView({ preserveChat: navigation.preserveChat });
    }
    if (navigation.nextInputMode) {
      inputMode = navigation.nextInputMode;
    }
    if (navigation.shouldAppendNavigationMessage && nextTabUrl) {
      void appendNavigationMessage(nextTabUrl, state.tab.title ?? null);
    }
  }

  autoValue = state.settings.autoSummarize;
  autoToggle.update({
    id: "sidepanel-auto",
    label: "Auto summarize",
    checked: autoValue,
    onCheckedChange: (checked) => {
      autoValue = checked;
      void send({ type: "panel:setAuto", value: checked });
    },
  });
  chatEnabledValue = state.settings.chatEnabled;
  automationEnabledValue = state.settings.automationEnabled;
  slidesEnabledValue = state.settings.slidesEnabled;
  slidesParallelValue = state.settings.slidesParallel;
  const nextSlidesOcrEnabled = Boolean(state.settings.slidesOcrEnabled);
  if (nextSlidesOcrEnabled !== slidesOcrEnabledValue) {
    slidesOcrEnabledValue = nextSlidesOcrEnabled;
    updateSlidesTextState();
  }
  const fallbackModel = typeof state.settings.model === "string" ? state.settings.model.trim() : "";
  if (fallbackModel && (!panelState.lastMeta.model || !panelState.lastMeta.model.trim())) {
    panelState.lastMeta = {
      ...panelState.lastMeta,
      model: fallbackModel,
      modelLabel: fallbackModel,
    };
  }
  if (slidesEnabledValue && nextMediaAvailable) {
    inputMode = "video";
    inputModeOverride = "video";
  }
  if (state.settings.slidesLayout && state.settings.slidesLayout !== slidesLayoutValue) {
    setSlidesLayout(state.settings.slidesLayout);
  }
  if (automationEnabledValue) hideAutomationNotice();
  if (!slidesEnabledValue) hideSlideNotice();
  if (slidesEnabledValue && (inputModeOverride ?? inputMode) === "video") {
    maybeApplyPendingSlidesSummary();
    maybeStartPendingSummaryRunForUrl(nextTabUrl ?? null);
    maybeStartPendingSlidesForUrl(nextTabUrl ?? null);
  }
  applyChatEnabled();
  if (chatEnabledValue && activeTabId && chatController.getMessages().length === 0) {
    void restoreChatHistory();
  }
  if (pickerSettings.length !== state.settings.length) {
    pickerSettings = { ...pickerSettings, length: state.settings.length };
    lengthPicker.update({
      length: pickerSettings.length,
      onLengthChange: pickerHandlers.onLengthChange,
    });
    rebuildSlideDescriptions();
    if (panelState.summaryMarkdown) {
      renderInlineSlides(renderMarkdownHostEl, { fallback: true });
    }
  }
  if (
    state.settings.fontSize !== typographyController.getCurrentFontSize() ||
    state.settings.lineHeight !== typographyController.getCurrentLineHeight()
  ) {
    typographyController.apply(
      pickerSettings.fontFamily,
      state.settings.fontSize,
      state.settings.lineHeight,
    );
    typographyController.setCurrentFontSize(state.settings.fontSize);
    typographyController.setCurrentLineHeight(state.settings.lineHeight);
  }
  if (readCurrentModelValue() !== state.settings.model) {
    setModelValue(state.settings.model);
  }
  updateModelRowUI();
  modelRefreshBtn.disabled = !state.settings.tokenPresent || isRefreshFreeRunning();
  if (panelState.currentSource) {
    if (
      shouldInvalidateCurrentSource({
        stateTabUrl: state.tab.url,
        currentSourceUrl: panelState.currentSource.url,
      })
    ) {
      const preserveChat = isRecentAgentNavigation(activeTabId, state.tab.url);
      if (preserveChat) {
        notePreserveChatForUrl(state.tab.url);
      }
      panelState.currentSource = null;
      currentRunTabId = null;
      streamController.abort();
      resetSummaryView({ preserveChat });
    } else if (state.tab.title && state.tab.title !== panelState.currentSource.title) {
      panelState.currentSource = { ...panelState.currentSource, title: state.tab.title };
      headerController.setBaseTitle(state.tab.title);
    }
  }
  if (!panelState.currentSource) {
    panelState.lastMeta = { inputSummary: null, model: null, modelLabel: null };
    headerController.setBaseTitle(state.tab.title || state.tab.url || "Summarize");
    headerController.setBaseSubtitle("");
  }
  if (!isStreaming()) {
    headerController.setStatus(state.status);
  }
  if (!nextMediaAvailable && hasMediaInfo) {
    inputMode = "page";
    inputModeOverride = null;
  }
  mediaAvailable = nextMediaAvailable;
  summarizeVideoLabel = nextVideoLabel;
  summarizePageWords = state.stats.pageWords;
  summarizeVideoDurationSeconds = state.stats.videoDurationSeconds;
  refreshSummarizeControl();
  const showingSetup = maybeShowSetup(state);
  if (showingSetup && panelState.phase !== "setup") {
    setPhase("setup");
  } else if (!showingSetup && panelState.phase === "setup") {
    setPhase("idle");
  }
  if (!panelState.summaryMarkdown?.trim()) {
    renderMarkdownDisplay();
  }
}

function handleBgMessage(msg: BgToPanel) {
  switch (msg.type) {
    case "ui:state":
      panelState.ui = msg.state;
      updateControls(msg.state);
      return;
    case "ui:status":
      if (!isStreaming()) headerController.setStatus(msg.status);
      return;
    case "run:error":
      headerController.setStatus(
        `Error: ${msg.message && msg.message.trim().length > 0 ? msg.message : "Something went wrong."}`,
      );
      setPhase("error", {
        error: msg.message && msg.message.trim().length > 0 ? msg.message : "Something went wrong.",
      });
      if (panelState.chatStreaming) {
        finishStreamingMessage();
      }
      return;
    case "slides:run": {
      if (!msg.ok) {
        setSlidesBusy(false);
        if (msg.error) {
          showSlideNotice(msg.error, { allowRetry: true });
        }
        return;
      }
      if (!msg.runId) return;
      const targetUrl = msg.url ?? null;
      if (
        !shouldAcceptSlidesForCurrentPage({
          targetUrl,
          activeTabUrl,
          currentSourceUrl: panelState.currentSource?.url ?? null,
        })
      ) {
        pendingSlidesRunsByUrl.set(normalizePanelUrl(targetUrl), {
          runId: msg.runId,
          url: targetUrl,
        });
        return;
      }
      startSlidesStreamForRunId(msg.runId);
      startSlidesSummaryStreamForRunId(msg.runId, targetUrl ?? null);
      return;
    }
    case "slides:context": {
      if (!panelState.slides) return;
      const expectedId = `slides-${slidesContextRequestId}`;
      if (msg.requestId !== expectedId) return;
      slidesContextPending = false;
      setSlidesTranscriptTimedText(msg.ok ? (msg.transcriptTimedText ?? null) : null);
      updateSlidesTextState();
      const summarySource =
        slidesSummaryComplete && slidesSummaryMarkdown.trim()
          ? slidesSummaryMarkdown
          : (panelState.summaryMarkdown ?? "");
      if (summarySource) {
        updateSlideSummaryFromMarkdown(summarySource, {
          preserveIfEmpty: false,
          source:
            slidesSummaryComplete && slidesSummaryMarkdown.trim().length > 0 ? "slides" : "summary",
        });
        renderInlineSlides(renderMarkdownHostEl, { fallback: true });
      }
      if (!msg.ok) return;
      panelCacheController.scheduleSync();
      return;
    }
    case "ui:cache": {
      const result = panelCacheController.consumeResponse(msg);
      if (!result) return;
      if (activeTabId !== result.tabId || activeTabUrl !== result.url) return;
      if (!result.cache) return;
      applyPanelCache(result.cache, { preserveChat: result.preserveChat });
      return;
    }
    case "run:start": {
      if (
        !shouldAcceptRunForCurrentPage({
          runUrl: msg.run.url,
          activeTabUrl,
          currentSourceUrl: panelState.currentSource?.url ?? null,
        })
      ) {
        pendingSummaryRunsByUrl.set(normalizePanelUrl(msg.run.url), msg.run);
        return;
      }
      attachSummaryRun(msg.run);
      return;
    }
    case "chat:history":
      handleChatHistoryResponse(msg);
      return;
    case "agent:chunk":
      handleAgentChunk(msg);
      return;
    case "agent:response":
      handleAgentResponse(msg);
      return;
  }
}

function scheduleAutoKick() {
  if (!autoValue) return;
  window.clearTimeout(autoKickTimer);
  autoKickTimer = window.setTimeout(() => {
    if (!autoValue) return;
    if (panelState.phase !== "idle") return;
    if (panelState.summaryMarkdown) return;
    sendSummarize();
  }, 350);
}

async function send(message: PanelToBg) {
  if (message.type === "panel:summarize") {
    lastAction = "summarize";
  } else if (message.type === "panel:agent") {
    lastAction = "chat";
  }
  const port = await ensurePanelPort();
  if (!port) return;
  try {
    port.postMessage(message);
  } catch {
    // ignore (panel/background race while reloading)
  }
}

function sendSummarize(opts?: { refresh?: boolean }) {
  errorController.clearInlineError();
  void send({
    type: "panel:summarize",
    refresh: Boolean(opts?.refresh),
    inputMode: inputModeOverride ?? undefined,
  });
}

function seedPlannedSlidesForRun(run: RunStart) {
  if (!slidesEnabledValue) return;
  const effectiveInputMode = inputModeOverride ?? inputMode;
  if (effectiveInputMode !== "video") return;
  const durationSeconds = summarizeVideoDurationSeconds;
  if (!durationSeconds || !Number.isFinite(durationSeconds) || durationSeconds <= 0) return;

  const normalized = pickerSettings.length.trim().toLowerCase();
  const chunkSeconds =
    normalized === "short"
      ? 600
      : normalized === "medium"
        ? 450
        : normalized === "long"
          ? 300
          : normalized === "xl"
            ? 180
            : normalized === "xxl"
              ? 120
              : 300;

  const target = Math.max(3, Math.round(durationSeconds / chunkSeconds));
  const count = Math.max(3, Math.min(80, target));

  const youtubeId = extractYouTubeVideoId(run.url);
  const sourceId = youtubeId ? `youtube-${youtubeId}` : `planned-${run.id}`;
  const sourceKind = youtubeId ? "youtube" : "direct";

  if (
    panelState.slides &&
    panelState.slides.sourceId === sourceId &&
    panelState.slides.slides.length > 0
  ) {
    return;
  }

  const slides = Array.from({ length: count }, (_, i) => {
    const ratio = count <= 1 ? 0 : i / Math.max(1, count - 1);
    const timestamp = Math.max(0, Math.min(durationSeconds - 0.1, ratio * durationSeconds));
    const index = i + 1;
    return { index, timestamp, imageUrl: "" };
  });

  panelState.slides = {
    sourceUrl: run.url,
    sourceId,
    sourceKind,
    ocrAvailable: false,
    slides,
  };
  slidesSeededSourceId = sourceId;
  updateSlidesTextState();
  void requestSlidesContext();
  queueSlidesRender();
}

function toggleDrawer(force?: boolean, opts?: { animate?: boolean }) {
  const reducedMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches ?? false;
  const animate = opts?.animate !== false && !reducedMotion;

  const isOpen = !drawerEl.classList.contains("hidden");
  const next = typeof force === "boolean" ? force : !isOpen;

  drawerToggleBtn.classList.toggle("isActive", next);
  drawerToggleBtn.setAttribute("aria-expanded", next ? "true" : "false");
  drawerEl.setAttribute("aria-hidden", next ? "false" : "true");

  if (next === isOpen) return;

  const cleanup = () => {
    drawerEl.style.removeProperty("height");
    drawerEl.style.removeProperty("opacity");
    drawerEl.style.removeProperty("transform");
    drawerEl.style.removeProperty("overflow");
  };

  drawerAnimation?.cancel();
  drawerAnimation = null;
  cleanup();

  if (!animate) {
    drawerEl.classList.toggle("hidden", !next);
    return;
  }

  if (next) {
    drawerEl.classList.remove("hidden");
    const targetHeight = drawerEl.scrollHeight;
    drawerEl.style.height = "0px";
    drawerEl.style.opacity = "0";
    drawerEl.style.transform = "translateY(-6px)";
    drawerEl.style.overflow = "hidden";

    drawerAnimation = drawerEl.animate(
      [
        { height: "0px", opacity: 0, transform: "translateY(-6px)" },
        { height: `${targetHeight}px`, opacity: 1, transform: "translateY(0px)" },
      ],
      { duration: 200, easing: "cubic-bezier(0.2, 0, 0, 1)" },
    );
    drawerAnimation.onfinish = () => {
      drawerAnimation = null;
      cleanup();
    };
    drawerAnimation.oncancel = () => {
      drawerAnimation = null;
    };
    return;
  }

  const currentHeight = drawerEl.getBoundingClientRect().height;
  drawerEl.style.height = `${currentHeight}px`;
  drawerEl.style.opacity = "1";
  drawerEl.style.transform = "translateY(0px)";
  drawerEl.style.overflow = "hidden";

  drawerAnimation = drawerEl.animate(
    [
      { height: `${currentHeight}px`, opacity: 1, transform: "translateY(0px)" },
      { height: "0px", opacity: 0, transform: "translateY(-6px)" },
    ],
    { duration: 180, easing: "cubic-bezier(0.4, 0, 0.2, 1)" },
  );
  drawerAnimation.onfinish = () => {
    drawerAnimation = null;
    drawerEl.classList.add("hidden");
    cleanup();
  };
  drawerAnimation.oncancel = () => {
    drawerAnimation = null;
  };
}

function toggleAdvancedSettings(force?: boolean, opts?: { animate?: boolean }) {
  const reducedMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches ?? false;
  const animate = opts?.animate !== false && !reducedMotion;
  const isOpen = advancedSettingsEl.open;
  const next = typeof force === "boolean" ? force : !isOpen;

  if (next === isOpen) {
    if (next) refreshModelsIfStale();
    return;
  }

  const cleanup = () => {
    advancedSettingsBodyEl.style.removeProperty("height");
    advancedSettingsBodyEl.style.removeProperty("opacity");
    advancedSettingsBodyEl.style.removeProperty("transform");
    advancedSettingsBodyEl.style.removeProperty("overflow");
  };

  advancedSettingsAnimation?.cancel();
  advancedSettingsAnimation = null;
  cleanup();

  if (!animate) {
    advancedSettingsEl.open = next;
    if (next) refreshModelsIfStale();
    return;
  }

  if (next) {
    advancedSettingsBodyEl.style.height = "0px";
    advancedSettingsBodyEl.style.opacity = "0";
    advancedSettingsBodyEl.style.transform = "translateY(-6px)";
    advancedSettingsBodyEl.style.overflow = "hidden";
    advancedSettingsEl.open = true;

    const targetHeight = advancedSettingsBodyEl.scrollHeight;
    advancedSettingsAnimation = advancedSettingsBodyEl.animate(
      [
        { height: "0px", opacity: 0, transform: "translateY(-6px)" },
        { height: `${targetHeight}px`, opacity: 1, transform: "translateY(0px)" },
      ],
      { duration: 200, easing: "cubic-bezier(0.2, 0, 0, 1)", fill: "both" },
    );
    advancedSettingsAnimation.onfinish = () => {
      advancedSettingsAnimation = null;
      cleanup();
      refreshModelsIfStale();
    };
    advancedSettingsAnimation.oncancel = () => {
      advancedSettingsAnimation = null;
    };
    return;
  }

  const currentHeight = advancedSettingsBodyEl.getBoundingClientRect().height;
  advancedSettingsBodyEl.style.height = `${currentHeight}px`;
  advancedSettingsBodyEl.style.opacity = "1";
  advancedSettingsBodyEl.style.transform = "translateY(0px)";
  advancedSettingsBodyEl.style.overflow = "hidden";

  advancedSettingsAnimation = advancedSettingsBodyEl.animate(
    [
      { height: `${currentHeight}px`, opacity: 1, transform: "translateY(0px)" },
      { height: "0px", opacity: 0, transform: "translateY(-6px)" },
    ],
    { duration: 180, easing: "cubic-bezier(0.4, 0, 0.2, 1)", fill: "both" },
  );
  advancedSettingsAnimation.onfinish = () => {
    advancedSettingsAnimation = null;
    advancedSettingsEl.open = false;
    cleanup();
  };
  advancedSettingsAnimation.oncancel = () => {
    advancedSettingsAnimation = null;
  };
}

function resetChatState() {
  panelState.chatStreaming = false;
  chatController.reset();
  clearQueuedMessages();
  chatJumpBtn.classList.remove("isVisible");
  pendingAgentRequests.clear();
  abortAgentRequested = false;
  lastNavigationMessageUrl = null;
}

function finishStreamingMessage() {
  panelState.chatStreaming = false;
  chatInputEl.focus();
  void persistChatHistory();
  maybeSendQueuedChat();
}

async function runAgentLoop() {
  let tools = automationEnabledValue ? getAutomationToolNames() : [];
  if (tools.includes("debugger")) {
    const hasDebugger = await chrome.permissions.contains({ permissions: ["debugger"] });
    if (!hasDebugger) {
      tools = tools.filter((tool) => tool !== "debugger");
    }
  }

  while (true) {
    if (abortAgentRequested) return;
    const messages = chatController.buildRequestMessages() as Message[];
    const streamingMessage = buildStreamingAssistantMessage();
    let streamedContent = "";
    chatController.addMessage(streamingMessage);
    scrollToBottom(true);
    let response: AgentResponse;
    try {
      response = await requestAgent(messages, tools, panelState.summaryMarkdown, {
        onChunk: (text) => {
          streamedContent += text;
          chatController.updateStreamingMessage(streamedContent);
        },
      });
    } catch (error) {
      chatController.removeMessage(streamingMessage.id);
      if (abortAgentRequested) return;
      throw error;
    }
    if (!response.ok || !response.assistant) {
      chatController.removeMessage(streamingMessage.id);
      throw new Error(response.error || "Agent failed");
    }

    const assistant = { ...response.assistant, id: streamingMessage.id };
    if (abortAgentRequested) {
      chatController.removeMessage(streamingMessage.id);
      return;
    }
    chatController.replaceMessage(assistant);
    chatController.finishStreamingMessage();
    scrollToBottom(true);

    const toolCalls = assistant.content.filter((part) => part.type === "toolCall") as ToolCall[];
    if (toolCalls.length === 0) break;

    for (const call of toolCalls) {
      if (abortAgentRequested) return;
      if (call.name === "navigate") {
        const args = call.arguments as { url?: string };
        markAgentNavigationIntent(args?.url);
      }
      const result = (await executeToolCall(call)) as ToolResultMessage;
      if (call.name === "navigate" && !result.isError) {
        markAgentNavigationResult(result.details);
      }
      chatController.addMessage(wrapMessage(result));
      scrollToBottom(true);
    }
  }
}

function startChatMessage(text: string) {
  const input = text.trim();
  if (!input || !chatEnabledValue) return;

  errorController.clearAll();
  abortAgentRequested = false;

  chatController.addMessage(wrapMessage({ role: "user", content: input, timestamp: Date.now() }));

  panelState.chatStreaming = true;
  metricsController.setActiveMode("chat");
  scrollToBottom(true);
  lastAction = "chat";

  void (async () => {
    try {
      await runAgentLoop();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      headerController.setStatus(`Error: ${message}`);
      errorController.showInlineError(message);
    } finally {
      finishStreamingMessage();
    }
  })();
}

function maybeSendQueuedChat() {
  if (panelState.chatStreaming || !chatEnabledValue) return;
  if (chatQueue.length === 0) {
    renderChatQueue();
    return;
  }
  const next = chatQueue.shift();
  renderChatQueue();
  if (next) startChatMessage(next.text);
}

function retryChat() {
  if (!chatEnabledValue || panelState.chatStreaming) return;
  if (!chatController.hasUserMessages()) return;

  errorController.clearAll();
  abortAgentRequested = false;
  panelState.chatStreaming = true;
  metricsController.setActiveMode("chat");
  lastAction = "chat";
  scrollToBottom(true);

  void (async () => {
    try {
      await runAgentLoop();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      headerController.setStatus(`Error: ${message}`);
      errorController.showInlineError(message);
    } finally {
      finishStreamingMessage();
    }
  })();
}

function retryLastAction() {
  if (lastAction === "chat") {
    retryChat();
    return;
  }
  sendSummarize({ refresh: true });
}

function sendChatMessage() {
  if (!chatEnabledValue) return;
  const rawInput = chatInputEl.value;
  const input = rawInput.trim();
  if (!input) return;

  chatInputEl.value = "";
  chatInputEl.style.height = "auto";

  const chatBusy = panelState.chatStreaming;
  if (chatBusy || chatQueue.length > 0) {
    const queued = enqueueChatMessage(input);
    if (!queued) {
      chatInputEl.value = rawInput;
      chatInputEl.style.height = `${Math.min(chatInputEl.scrollHeight, 120)}px`;
    } else if (!chatBusy) {
      maybeSendQueuedChat();
    }
    return;
  }

  startChatMessage(input);
}

refreshBtn.addEventListener("click", () => sendSummarize({ refresh: true }));
clearBtn.addEventListener("click", () => {
  void clearCurrentView();
});
drawerToggleBtn.addEventListener("click", () => toggleDrawer());
advancedBtn.addEventListener("click", () => {
  void send({ type: "panel:openOptions" });
});
advancedSettingsSummaryEl.addEventListener("click", (event) => {
  event.preventDefault();
  toggleAdvancedSettings();
});

chatSendBtn.addEventListener("click", sendChatMessage);
chatInputEl.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    sendChatMessage();
  }
});
chatInputEl.addEventListener("input", () => {
  chatInputEl.style.height = "auto";
  chatInputEl.style.height = `${Math.min(chatInputEl.scrollHeight, 120)}px`;
});

const bumpFontSize = (delta: number) => {
  void (async () => {
    const nextSize = typographyController.clampFontSize(
      typographyController.getCurrentFontSize() + delta,
    );
    const next = await patchSettings({ fontSize: nextSize });
    typographyController.apply(next.fontFamily, next.fontSize, next.lineHeight);
    typographyController.setCurrentFontSize(next.fontSize);
    typographyController.setCurrentLineHeight(next.lineHeight);
  })();
};

sizeSmBtn.addEventListener("click", () => bumpFontSize(-1));
sizeLgBtn.addEventListener("click", () => bumpFontSize(1));

const bumpLineHeight = (delta: number) => {
  void (async () => {
    const nextHeight = typographyController.clampLineHeight(
      typographyController.getCurrentLineHeight() + delta,
    );
    const next = await patchSettings({ lineHeight: nextHeight });
    typographyController.apply(next.fontFamily, next.fontSize, next.lineHeight);
    typographyController.setCurrentLineHeight(next.lineHeight);
  })();
};

lineTightBtn.addEventListener("click", () => bumpLineHeight(-LINE_HEIGHT_STEP));
lineLooseBtn.addEventListener("click", () => bumpLineHeight(LINE_HEIGHT_STEP));

modelPresetEl.addEventListener("change", () => {
  updateModelRowUI();
  if (!modelCustomEl.hidden) modelCustomEl.focus();
  void (async () => {
    await patchSettings({ model: readCurrentModelValue() });
  })();
});

modelCustomEl.addEventListener("change", () => {
  void (async () => {
    await patchSettings({ model: readCurrentModelValue() });
  })();
});

modelCustomEl.addEventListener("keydown", (event) => {
  if (event.key !== "Enter") return;
  event.preventDefault();
  modelCustomEl.blur();
  void (async () => {
    await patchSettings({ model: readCurrentModelValue() });
  })();
});

slidesLayoutEl.addEventListener("change", () => {
  const next = slidesLayoutEl.value === "gallery" ? "gallery" : "strip";
  setSlidesLayout(next);
  void (async () => {
    await patchSettings({ slidesLayout: next });
  })();
});

modelPresetEl.addEventListener("focus", refreshModelsIfStale);
modelPresetEl.addEventListener("pointerdown", refreshModelsIfStale);
modelCustomEl.addEventListener("focus", refreshModelsIfStale);
modelCustomEl.addEventListener("pointerdown", refreshModelsIfStale);
advancedSettingsEl.addEventListener("toggle", () => {
  if (advancedSettingsAnimation) return;
  if (advancedSettingsEl.open) refreshModelsIfStale();
});
modelRefreshBtn.addEventListener("click", () => {
  void runRefreshFree();
});

void (async () => {
  await ensurePanelPort();
  const s = await loadSettings();
  typographyController.setCurrentFontSize(s.fontSize);
  typographyController.setCurrentLineHeight(s.lineHeight);
  autoValue = s.autoSummarize;
  chatEnabledValue = s.chatEnabled;
  automationEnabledValue = s.automationEnabled;
  slidesLayoutValue = s.slidesLayout;
  slidesLayoutEl.value = slidesLayoutValue;
  if (!automationEnabledValue) hideAutomationNotice();
  autoToggle.update({
    id: "sidepanel-auto",
    label: "Auto summarize",
    checked: autoValue,
    onCheckedChange: (checked) => {
      autoValue = checked;
      void send({ type: "panel:setAuto", value: checked });
    },
  });
  applyChatEnabled();
  applySlidesLayout();
  pickerSettings = {
    scheme: s.colorScheme,
    mode: s.colorMode,
    fontFamily: s.fontFamily,
    length: s.length,
  };
  pickers.update({
    scheme: pickerSettings.scheme,
    mode: pickerSettings.mode,
    fontFamily: pickerSettings.fontFamily,
    onSchemeChange: pickerHandlers.onSchemeChange,
    onModeChange: pickerHandlers.onModeChange,
    onFontChange: pickerHandlers.onFontChange,
  });
  lengthPicker.update({
    length: pickerSettings.length,
    onLengthChange: pickerHandlers.onLengthChange,
  });
  setDefaultModelPresets();
  setModelValue(s.model);
  setModelPlaceholderFromDiscovery({});
  updateModelRowUI();
  modelRefreshBtn.disabled = !s.token.trim();
  typographyController.apply(s.fontFamily, s.fontSize, s.lineHeight);
  applyTheme({ scheme: s.colorScheme, mode: s.colorMode });
  toggleDrawer(false, { animate: false });
  renderMarkdownDisplay();
  void send({ type: "panel:ready" });
  scheduleAutoKick();
})();

setInterval(() => {
  void send({ type: "panel:ping" });
}, 25_000);

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== "local") return;
  const nextSettings = changes.settings?.newValue;
  if (!nextSettings || typeof nextSettings !== "object") return;
  const nextChatEnabled = (nextSettings as { chatEnabled?: unknown }).chatEnabled;
  if (typeof nextChatEnabled === "boolean" && nextChatEnabled !== chatEnabledValue) {
    chatEnabledValue = nextChatEnabled;
    applyChatEnabled();
  }
  const nextAutomationEnabled = (nextSettings as { automationEnabled?: unknown }).automationEnabled;
  if (typeof nextAutomationEnabled === "boolean") {
    automationEnabledValue = nextAutomationEnabled;
    if (!automationEnabledValue) hideAutomationNotice();
  }
});

let lastVisibility = document.visibilityState;
let panelMarkedOpen = document.visibilityState === "visible";

function markPanelOpen() {
  if (panelMarkedOpen) return;
  panelMarkedOpen = true;
  errorController.clearInlineError();
  void send({ type: "panel:ready" });
  scheduleAutoKick();
  void syncWithActiveTab();
}

function markPanelClosed() {
  if (!panelMarkedOpen) return;
  panelMarkedOpen = false;
  window.clearTimeout(autoKickTimer);
  void send({ type: "panel:closed" });
}

document.addEventListener("visibilitychange", () => {
  const visible = document.visibilityState === "visible";
  const wasVisible = lastVisibility === "visible";
  if (visible && !wasVisible) {
    markPanelOpen();
  } else if (!visible && wasVisible) {
    markPanelClosed();
  }
  lastVisibility = document.visibilityState;
});

window.addEventListener("focus", () => {
  if (document.visibilityState !== "visible") return;
  markPanelOpen();
});

window.addEventListener("keydown", (event) => {
  if (event.key !== "Enter" || !event.shiftKey) return;
  const target = event.target as HTMLElement | null;
  if (
    target &&
    (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)
  ) {
    return;
  }
  event.preventDefault();
  sendSummarize({ refresh: true });
});

window.addEventListener("beforeunload", () => {
  void send({ type: "panel:closed" });
});
