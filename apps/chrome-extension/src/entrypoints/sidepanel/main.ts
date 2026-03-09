import type { Message, ToolCall, ToolResultMessage } from "@mariozechner/pi-ai";
import { extractYouTubeVideoId } from "@steipete/summarize-core/content/url";
import MarkdownIt from "markdown-it";
import { splitSummaryFromSlides } from "../../../../../src/run/flows/url/slides-text.js";
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
import { generateToken } from "../../lib/token";
import { createAppearanceControls } from "./appearance-controls";
import { handleSidepanelBgMessage } from "./bg-message-runtime";
import { bindSettingsStorage, bindSidepanelLifecycle, bindSidepanelUiEvents } from "./bindings";
import { runChatAgentLoop } from "./chat-agent-loop";
import { ChatController } from "./chat-controller";
import { createChatHistoryRuntime } from "./chat-history-runtime";
import {
  buildEmptyUsage,
  createChatHistoryStore,
  normalizeStoredMessage,
} from "./chat-history-store";
import { createChatQueueRuntime } from "./chat-queue-runtime";
import { createChatSession } from "./chat-session";
import { type ChatHistoryLimits } from "./chat-state";
import { createChatStreamRuntime } from "./chat-stream-runtime";
import { createDrawerControls } from "./drawer-controls";
import { createErrorController } from "./error-controller";
import { createHeaderController } from "./header-controller";
import { createMetricsController } from "./metrics-controller";
import { createModelPresetsController } from "./model-presets";
import { createNavigationRuntime } from "./navigation-runtime";
import { createPanelCacheController, type PanelCachePayload } from "./panel-cache";
import { createPanelPortRuntime } from "./panel-port";
import { mountSummarizeControl } from "./pickers";
import {
  normalizePanelUrl,
  panelUrlsMatch,
  shouldAcceptRunForCurrentPage,
  shouldAcceptSlidesForCurrentPage,
} from "./session-policy";
import { createSetupRuntime, friendlyFetchError } from "./setup-runtime";
import { createSlidesHydrator } from "./slides-hydrator";
import { hasResolvedSlidesPayload } from "./slides-pending";
import { createSlidesRunRuntime } from "./slides-run-runtime";
import { shouldSeedPlannedSlidesForRun } from "./slides-seed-policy";
import {
  resolveSlidesLengthArg,
  selectMarkdownForLayout,
  splitSlidesMarkdown,
  type SlideTextMode,
} from "./slides-state";
import { createSlidesTextController } from "./slides-text-controller";
import { resolveSlidesRenderLayout } from "./slides-view-policy";
import { createSlidesViewRuntime } from "./slides-view-runtime";
import { createStreamController } from "./stream-controller";
import { createSummaryViewRuntime } from "./summary-view-runtime";
import { registerSidepanelTestHooks } from "./test-hooks";
import { parseTimestampHref } from "./timestamp-links";
import type { ChatMessage, PanelPhase, PanelState, RunStart, UiState } from "./types";
import { createTypographyController } from "./typography-controller";
import { createUiStateRuntime } from "./ui-state-runtime";

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

let currentRunTabId: number | null = null;

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

const panelPortRuntime = createPanelPortRuntime<BgToPanel>({
  onMessage: (msg) => {
    handleBgMessage(msg);
  },
});
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
let activeTabId: number | null = null;
let activeTabUrl: string | null = null;
let lastPanelOpen = false;
let lastStreamError: string | null = null;
let lastAction: "summarize" | "chat" | null = null;
let lastNavigationMessageUrl: string | null = null;
let inputMode: "page" | "video" = "page";
let inputModeOverride: "page" | "video" | null = null;
let mediaAvailable = false;
let preserveChatOnNextReset = false;
let automationNoticeSticky = false;
let summarizeVideoLabel = "Video";
let summarizePageWords: number | null = null;
let summarizeVideoDurationSeconds: number | null = null;

let slidesBusy = false;
let slidesExpanded = true;
let slidesLayoutValue: SlidesLayout = defaultSettings.slidesLayout;
let slidesRenderer: {
  applyLayout: () => void;
  clear: () => void;
  forceRender: () => void;
} | null = null;
let slidesHydrator: {
  handlePayload: (data: SseSlidesData) => void;
  handleSummaryFromCache: (value: boolean | null) => void;
  hydrateSnapshot: (reason: "timeout" | "resume") => Promise<void>;
  isStreaming: () => boolean;
  start: (runId: string) => Promise<void>;
  stop: () => void;
  syncFromCache: (payload: {
    runId: string | null;
    summaryFromCache: boolean | null;
    hasSlides: boolean;
  }) => void;
} | null = null;
let settingsHydrated = false;
let pendingSettingsSnapshot: Partial<typeof defaultSettings> | null = null;
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
const slidesTextController = createSlidesTextController({
  getSlides: () => panelState.slides?.slides ?? null,
  getLengthValue: () => appearanceControls.getLengthValue(),
  getSlidesOcrEnabled: () => slidesOcrEnabledValue,
});

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
const chatHistoryRuntime = createChatHistoryRuntime({
  chatController,
  chatHistoryStore,
  chatLimits,
  normalizeStoredMessage,
  requestChatHistory: (summary) => chatSession.requestChatHistory(summary),
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
  slidesTextController.setTranscriptTimedText(value);
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
  slidesTextController.clearSummarySource();
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
    chatStreamRuntime.finishStreamingMessage();
  }
  const preserveChat = navigationRuntime.shouldPreserveChatForRun(run.url);
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
  maybeSeedPlannedSlidesForPendingRun();
  if (!panelState.summaryMarkdown?.trim()) {
    renderMarkdownDisplay();
  }
  if (!slidesParallelValue) {
    startSlidesStream(run);
  }
  void streamController.start(run);
}

function maybeSeedPlannedSlidesForPendingRun() {
  if (!pendingRunForPlannedSlides) return false;
  if (seedPlannedSlidesForRun(pendingRunForPlannedSlides)) {
    pendingRunForPlannedSlides = null;
    return true;
  }
  return false;
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
  chatSession.requestAbort(reason);
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

const chatSession = createChatSession({
  hideReplOverlay: hideReplOverlayForActiveTab,
  send: async (message) => send(message),
  setStatus: (text) => headerController.setStatus(text),
});

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
  if (next === "ocr" && !slidesOcrEnabledValue) return;
  if (!slidesTextController.setTextMode(next)) return;
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
  slidesRenderer?.applyLayout();
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
  slidesTextMode: slidesTextController.getTextMode(),
  slidesTextToggleVisible: slidesTextController.getTextToggleVisible(),
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
    slidesTextMode: slidesTextController.getTextMode(),
    slidesTextToggleVisible: slidesTextController.getTextToggleVisible(),
    onSlidesTextModeChange: handleSlidesTextModeChange,
    onChange: handleSummarizeControlChange,
    onSummarize: () => sendSummarize(),
  });
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
const chatQueueRuntime = createChatQueueRuntime({
  chatQueueEl,
  maxQueue: MAX_CHAT_QUEUE,
  setStatus: (value) => {
    headerController.setStatus(value);
  },
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

const navigationRuntime = createNavigationRuntime({
  getCurrentSource: () => panelState.currentSource,
  setCurrentSource: (source) => {
    panelState.currentSource = source;
  },
  resetForNavigation: (preserveChat) => {
    currentRunTabId = null;
    setPhase("idle");
    resetSummaryView({ preserveChat });
    headerController.setBaseSubtitle("");
  },
  setBaseTitle: (title) => {
    headerController.setBaseTitle(title);
  },
});

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

const syncWithActiveTab = () => navigationRuntime.syncWithActiveTab();

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

const summaryViewRuntime = createSummaryViewRuntime({
  panelState,
  renderEl,
  renderSlidesHostEl,
  renderMarkdownHostEl,
  getSlidesRenderer: () =>
    slidesRenderer ?? {
      applyLayout: () => {},
      clear: () => {},
      forceRender: () => {},
    },
  metricsController,
  headerController,
  slidesTextController,
  getSlidesHydrator: () =>
    slidesHydrator ?? {
      handlePayload: () => {},
      handleSummaryFromCache: () => {},
      hydrateSnapshot: async () => {},
      isStreaming: () => false,
      start: async () => {},
      stop: () => {},
      syncFromCache: () => {},
    },
  stopSlidesStream,
  refreshSummarizeControl,
  resetChatState,
  setSlidesTranscriptTimedText,
  getSlidesParallelValue: () => slidesParallelValue,
  getCurrentRunTabId: () => currentRunTabId,
  getActiveTabId: () => activeTabId,
  getActiveTabUrl: () => activeTabUrl,
  setCurrentRunTabId: (value) => {
    currentRunTabId = value;
  },
  setSlidesContextPending: (value) => {
    slidesContextPending = value;
  },
  setSlidesContextUrl: (value) => {
    slidesContextUrl = value;
  },
  setSlidesSeededSourceId: (value) => {
    slidesSeededSourceId = value;
  },
  setSlidesAppliedRunId: (value) => {
    slidesAppliedRunId = value;
  },
  setSlidesExpanded: (value) => {
    slidesExpanded = value;
  },
  resolveActiveSlidesRunId,
  getSlidesSummaryState: () => ({
    runId: slidesSummaryRunId,
    markdown: slidesSummaryMarkdown,
    complete: slidesSummaryComplete,
    model: slidesSummaryModel,
  }),
  setSlidesSummaryState: (payload) => {
    slidesSummaryMarkdown = payload.markdown;
    slidesSummaryComplete = payload.complete;
    slidesSummaryModel = payload.model;
  },
  clearSlidesSummaryPending: () => {
    slidesSummaryPending = null;
  },
  clearSlidesSummaryError: () => {
    slidesSummaryHadError = false;
  },
  updateSlidesTextState,
  requestSlidesContext,
  updateSlideSummaryFromMarkdown,
  renderMarkdown,
  renderMarkdownDisplay,
  queueSlidesRender,
  setPhase,
});
const { applyPanelCache, buildPanelCachePayload, resetSummaryView } = summaryViewRuntime;

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
  slidesViewRuntime.renderEmptySummaryState();
}

function renderMarkdownDisplay() {
  slidesViewRuntime.renderMarkdownDisplay();
}

function renderMarkdown(markdown: string) {
  slidesViewRuntime.renderMarkdown(markdown);
}

function setSlidesBusy(next: boolean) {
  slidesViewRuntime.setSlidesBusy(next);
}

function updateSlideSummaryFromMarkdown(
  markdown: string,
  opts?: { preserveIfEmpty?: boolean; source?: "summary" | "slides" },
) {
  slidesViewRuntime.updateSlideSummaryFromMarkdown(markdown, opts);
}

function seekToSlideTimestamp(seconds: number | null | undefined) {
  if (seconds == null || !Number.isFinite(seconds)) return;
  void send({ type: "panel:seek", seconds: Math.floor(seconds) });
}
function updateSlidesTextState() {
  slidesViewRuntime.updateSlidesTextState();
}

function rebuildSlideDescriptions() {
  slidesViewRuntime.rebuildSlideDescriptions();
}

const slidesViewRuntime = createSlidesViewRuntime({
  renderMarkdownHostEl,
  renderSlidesHostEl,
  chatMessagesEl,
  md,
  headerSetStatus: (text) => headerController.setStatus(text),
  headerSetProgressOverride: (busy) => headerController.setProgressOverride(busy),
  slidesTextController,
  panelCacheController,
  send,
  refreshSummarizeControl,
  hideSlideNotice,
  getState: () => ({
    activeTabUrl,
    autoSummarize: autoValue,
    currentSourceTitle: panelState.currentSource?.title ?? null,
    currentSourceUrl: panelState.currentSource?.url ?? null,
    inputMode: inputModeOverride ?? inputMode,
    panelState,
    slidesEnabled: slidesEnabledValue,
    slidesLayout: slidesLayoutValue,
    slidesExpanded,
    mediaAvailable,
  }),
  setSlidesBusyValue: (value) => {
    slidesBusy = value;
  },
  getSlidesBusy: () => slidesBusy,
  setSlidesContextPending: (value) => {
    slidesContextPending = value;
  },
  getSlidesContextPending: () => slidesContextPending,
  setSlidesContextUrl: (value) => {
    slidesContextUrl = value;
  },
  getSlidesContextUrl: () => slidesContextUrl,
  setSlidesSeededSourceId: (value) => {
    slidesSeededSourceId = value;
  },
  getSlidesSeededSourceId: () => slidesSeededSourceId,
  setSlidesAppliedRunId: (value) => {
    slidesAppliedRunId = value;
  },
  getSlidesAppliedRunId: () => slidesAppliedRunId,
  resolveActiveSlidesRunId,
  nextSlidesContextRequestId: () => {
    slidesContextRequestId += 1;
    return slidesContextRequestId;
  },
  setSlidesExpanded: (value) => {
    slidesExpanded = value;
  },
});

slidesRenderer = slidesViewRuntime.slidesRenderer;

function applySlidesPayload(data: SseSlidesData) {
  slidesViewRuntime.applySlidesPayload(data, setSlidesTranscriptTimedText);
}

registerSidepanelTestHooks({
  applySlidesPayload,
  getRunId: () => panelState.runId,
  getSummaryMarkdown: () => panelState.summaryMarkdown ?? "",
  getSlideDescriptions: () => slidesTextController.getDescriptionEntries(),
  getPhase: () => panelState.phase,
  getModel: () => panelState.lastMeta.model ?? null,
  getSlidesTimeline: () =>
    panelState.slides?.slides.map((slide) => ({
      index: slide.index,
      timestamp: Number.isFinite(slide.timestamp) ? slide.timestamp : null,
    })) ?? [],
  getTranscriptTimedText: () => slidesTextController.getTranscriptTimedText(),
  getSlidesSummaryMarkdown: () => slidesSummaryMarkdown,
  getSlidesSummaryComplete: () => slidesSummaryComplete,
  getSlidesSummaryModel: () => slidesSummaryModel,
  getChatEnabled: () => chatEnabledValue,
  getSettingsHydrated: () => settingsHydrated,
  setTranscriptTimedText: (value) => {
    setSlidesTranscriptTimedText(value);
    updateSlidesTextState();
  },
  setSummarizeMode: async (payload) => {
    await handleSummarizeControlChange(payload);
  },
  getSummarizeMode: () => ({
    mode: inputModeOverride ?? inputMode,
    slides: slidesEnabledValue,
    mediaAvailable,
  }),
  getSlidesState: () => ({
    slidesCount: panelState.slides?.slides.length ?? 0,
    layout: slidesLayoutValue,
    hasSlides: Boolean(panelState.slides),
  }),
  renderSlidesNow: () => {
    queueSlidesRender();
  },
  applyUiState: (state) => {
    panelState.ui = state;
    updateControls(state);
  },
  applyBgMessage: (message) => {
    handleBgMessage(message);
  },
  applySummarySnapshot: (payload) => {
    resetSummaryView({ preserveChat: false, clearRunId: false, stopSlides: false });
    panelState.runId = payload.run.id;
    panelState.slidesRunId = slidesParallelValue ? null : payload.run.id;
    panelState.currentSource = { url: payload.run.url, title: payload.run.title };
    currentRunTabId = activeTabId;
    headerController.setBaseTitle(payload.run.title || payload.run.url || "Summarize");
    headerController.setBaseSubtitle("");
    renderMarkdown(payload.markdown);
    setPhase("idle");
  },
  applySummaryMarkdown: (markdown) => {
    renderMarkdown(markdown);
    setPhase("idle");
  },
  forceRenderSlides: () => {
    slidesEnabledValue = true;
    inputMode = "video";
    inputModeOverride = "video";
    return slidesRenderer?.forceRender();
  },
  showInlineError: (message) => {
    errorController.showInlineError(message);
  },
  isInlineErrorVisible: () => !inlineErrorEl.classList.contains("hidden"),
  getInlineErrorMessage: () => inlineErrorMessageEl.textContent ?? "",
});

async function requestSlidesContext() {
  await slidesViewRuntime.requestSlidesContext();
}

function queueSlidesRender() {
  slidesViewRuntime.queueSlidesRender();
}

function renderInlineSlides(container: HTMLElement, opts?: { fallback?: boolean }) {
  slidesViewRuntime.renderInlineSlides(container, opts);
}

const LINE_HEIGHT_STEP = 0.1;

const appearanceControls = createAppearanceControls({
  autoToggleRoot,
  pickersRoot,
  lengthRoot,
  patchSettings,
  sendSetAuto: (checked) => {
    autoValue = checked;
    void send({ type: "panel:setAuto", value: checked });
  },
  sendSetLength: (value) => {
    void send({ type: "panel:setLength", value });
  },
  applyTypography: (fontFamily, fontSize, lineHeight) => {
    typographyController.apply(fontFamily, fontSize, lineHeight);
    typographyController.setCurrentFontSize(fontSize);
    typographyController.setCurrentLineHeight(lineHeight);
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
    chatQueueRuntime.clearQueuedMessages();
  } else {
    renderEl.classList.remove("hidden");
  }
}

async function clearChatHistoryForTab(tabId: number | null) {
  await chatHistoryRuntime.clear(tabId);
}

async function clearChatHistoryForActiveTab() {
  await clearChatHistoryForTab(activeTabId);
}

async function loadChatHistory(tabId: number): Promise<ChatMessage[] | null> {
  return chatHistoryRuntime.load(tabId);
}

async function persistChatHistory() {
  await chatHistoryRuntime.persist(activeTabId, chatEnabledValue);
}

async function restoreChatHistory() {
  await chatHistoryRuntime.restore(activeTabId, panelState.summaryMarkdown);
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
const drawerControls = createDrawerControls({
  drawerEl,
  drawerToggleBtn,
  advancedSettingsEl,
  advancedSettingsBodyEl,
  refreshModelsIfStale,
});

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
    const lengthArg = resolveSlidesLengthArg(appearanceControls.getLengthValue());
    const timeline: SlideTimelineEntry[] = panelState.slides.slides.map((slide) => ({
      index: slide.index,
      timestamp: Number.isFinite(slide.timestamp) ? slide.timestamp : Number.NaN,
    }));
    output = coerceSummaryWithSlides({
      markdown,
      slides: timeline,
      transcriptTimedText: slidesTextController.getTranscriptTimedText(),
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

slidesHydrator = createSlidesHydrator({
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

const slidesRunRuntime = createSlidesRunRuntime({
  getPanelPhase: () => panelState.phase,
  getPanelState: () => panelState,
  getUiState: () => panelState.ui,
  getActiveTabUrl: () => activeTabUrl,
  getInputMode: () => inputMode,
  setInputMode: (value) => {
    inputMode = value;
  },
  getInputModeOverride: () => inputModeOverride,
  setInputModeOverride: (value) => {
    inputModeOverride = value;
  },
  getSlidesEnabled: () => slidesEnabledValue,
  refreshSummarizeControl,
  stopSlidesStream,
  stopSlidesSummaryStream,
  hideSlideNotice,
  setSlidesBusy,
  schedulePanelCacheSync: () => {
    panelCacheController.scheduleSync();
  },
  startSlidesHydrator: (runId) => {
    void slidesHydrator.start(runId);
  },
  startSlidesSummaryController: (payload) => {
    void slidesSummaryController.start(payload);
  },
  getSlidesSummaryRunId: () => slidesSummaryRunId,
  setSlidesSummaryRunId: (value) => {
    slidesSummaryRunId = value;
  },
  setSlidesSummaryUrl: (value) => {
    slidesSummaryUrl = value;
  },
  resetSlidesSummaryState: () => {
    slidesSummaryMarkdown = "";
    slidesSummaryHadError = false;
    slidesSummaryComplete = false;
  },
  setSlidesSummaryModel: (value) => {
    slidesSummaryModel = value;
  },
  setSlidesRunId: (value) => {
    panelState.slidesRunId = value;
  },
  headerSetStatus: (text) => {
    headerController.setStatus(text);
  },
});
const {
  handleSlidesStatus,
  startSlidesStreamForRunId,
  startSlidesStream,
  startSlidesSummaryStreamForRunId,
} = slidesRunRuntime;

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
      if (panelState.slides && !slidesTextController.hasSummaryTitles()) {
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
const setupRuntime = createSetupRuntime({
  setupEl,
  loadToken: async () => (await loadSettings()).token.trim(),
  ensureToken,
  patchSettings,
  generateToken,
  headerSetStatus: (text) => headerController.setStatus(text),
  getStatusResetText: () => panelState.ui?.status ?? "",
});
const { maybeShowSetup } = setupRuntime;
const uiStateRuntime = createUiStateRuntime({
  panelState,
  chatController,
  appearanceControls,
  typographyController,
  navigationRuntime,
  panelCacheController,
  headerController,
  clearInlineError: () => {
    errorController.clearInlineError();
  },
  requestAgentAbort,
  clearChatHistoryForActiveTab,
  resetChatState,
  migrateChatHistory,
  maybeStartPendingSummaryRunForUrl,
  maybeStartPendingSlidesForUrl,
  applyPanelCache,
  resetSummaryView,
  appendNavigationMessage,
  hideAutomationNotice,
  hideSlideNotice,
  maybeApplyPendingSlidesSummary,
  applyChatEnabled,
  restoreChatHistory,
  rebuildSlideDescriptions,
  renderInlineSlides,
  setSlidesLayout: (value) => {
    setSlidesLayout(value as SlidesLayout);
  },
  maybeSeedPlannedSlidesForPendingRun,
  refreshSummarizeControl,
  maybeShowSetup,
  setPhase,
  renderMarkdownDisplay,
  readCurrentModelValue,
  setModelValue,
  updateModelRowUI,
  isRefreshFreeRunning,
  setModelRefreshDisabled: (value) => {
    modelRefreshBtn.disabled = value;
  },
  renderMarkdownHostEl,
  getActiveTabId: () => activeTabId,
  setActiveTabId: (value) => {
    activeTabId = value;
  },
  getActiveTabUrl: () => activeTabUrl,
  setActiveTabUrl: (value) => {
    activeTabUrl = value;
  },
  getCurrentRunTabId: () => currentRunTabId,
  setCurrentRunTabId: (value) => {
    currentRunTabId = value;
  },
  getLastPanelOpen: () => lastPanelOpen,
  setLastPanelOpen: (value) => {
    lastPanelOpen = value;
  },
  getAutoValue: () => autoValue,
  setAutoValue: (value) => {
    autoValue = value;
  },
  getChatEnabledValue: () => chatEnabledValue,
  setChatEnabledValue: (value) => {
    chatEnabledValue = value;
  },
  getAutomationEnabledValue: () => automationEnabledValue,
  setAutomationEnabledValue: (value) => {
    automationEnabledValue = value;
  },
  getSlidesEnabledValue: () => slidesEnabledValue,
  setSlidesEnabledValue: (value) => {
    slidesEnabledValue = value;
  },
  getSlidesParallelValue: () => slidesParallelValue,
  setSlidesParallelValue: (value) => {
    slidesParallelValue = value;
  },
  getSlidesOcrEnabledValue: () => slidesOcrEnabledValue,
  setSlidesOcrEnabledValue: (value) => {
    slidesOcrEnabledValue = value;
  },
  getInputMode: () => inputMode,
  setInputMode: (value) => {
    inputMode = value;
  },
  getInputModeOverride: () => inputModeOverride,
  setInputModeOverride: (value) => {
    inputModeOverride = value;
  },
  getMediaAvailable: () => mediaAvailable,
  setMediaAvailable: (value) => {
    mediaAvailable = value;
  },
  getSlidesLayoutValue: () => slidesLayoutValue,
  setSummarizeVideoLabel: (value) => {
    summarizeVideoLabel = value;
  },
  setSummarizePageWords: (value) => {
    summarizePageWords = value;
  },
  setSummarizeVideoDurationSeconds: (value) => {
    summarizeVideoDurationSeconds = value;
  },
  isStreaming,
  onSlidesOcrChanged: updateSlidesTextState,
});

function updateControls(state: UiState) {
  uiStateRuntime.apply(state);
}

function handleBgMessage(msg: BgToPanel) {
  handleSidepanelBgMessage({
    msg,
    applyUiState: (state) => {
      panelState.ui = state;
      updateControls(state);
    },
    setStatus: (text) => {
      headerController.setStatus(text);
    },
    isStreaming,
    handleRunError: (message) => {
      const detail = message && message.trim().length > 0 ? message : "Something went wrong.";
      headerController.setStatus(`Error: ${detail}`);
      setPhase("error", { error: detail });
      if (panelState.chatStreaming) {
        chatStreamRuntime.finishStreamingMessage();
      }
    },
    handleSlidesRun: (slidesRun) => {
      if (!slidesRun.ok) {
        setSlidesBusy(false);
        if (slidesRun.error) {
          showSlideNotice(slidesRun.error, { allowRetry: true });
        }
        return;
      }
      if (!slidesRun.runId) return;
      const targetUrl = slidesRun.url ?? null;
      if (
        !shouldAcceptSlidesForCurrentPage({
          targetUrl,
          activeTabUrl,
          currentSourceUrl: panelState.currentSource?.url ?? null,
        })
      ) {
        pendingSlidesRunsByUrl.set(normalizePanelUrl(targetUrl), {
          runId: slidesRun.runId,
          url: targetUrl,
        });
        return;
      }
      startSlidesStreamForRunId(slidesRun.runId);
      startSlidesSummaryStreamForRunId(slidesRun.runId, targetUrl ?? null);
    },
    handleSlidesContext: (slidesContext) => {
      if (!panelState.slides) return;
      const expectedId = `slides-${slidesContextRequestId}`;
      if (slidesContext.requestId !== expectedId) return;
      slidesContextPending = false;
      setSlidesTranscriptTimedText(
        slidesContext.ok ? (slidesContext.transcriptTimedText ?? null) : null,
      );
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
      if (!slidesContext.ok) return;
      panelCacheController.scheduleSync();
    },
    handleUiCache: (cacheMessage) => {
      const result = panelCacheController.consumeResponse(cacheMessage);
      if (!result) return;
      if (activeTabId !== result.tabId || activeTabUrl !== result.url) return;
      if (!result.cache) return;
      applyPanelCache(result.cache, { preserveChat: result.preserveChat });
    },
    handleRunStart: (run) => {
      if (
        !shouldAcceptRunForCurrentPage({
          runUrl: run.url,
          activeTabUrl,
          currentSourceUrl: panelState.currentSource?.url ?? null,
        })
      ) {
        pendingSummaryRunsByUrl.set(normalizePanelUrl(run.url), run);
        return;
      }
      attachSummaryRun(run);
    },
    handleChatHistory: (chatHistory) => {
      chatSession.handleChatHistoryResponse(chatHistory as never);
    },
    handleAgentChunk: (chunk) => {
      chatSession.handleAgentChunk(chunk as never);
    },
    handleAgentResponse: (response) => {
      chatSession.handleAgentResponse(response as never);
    },
  });
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
  await panelPortRuntime.send(message);
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
  const durationSeconds = summarizeVideoDurationSeconds;
  if (
    !shouldSeedPlannedSlidesForRun({
      durationSeconds,
      inputMode: inputModeOverride ?? inputMode,
      media: panelState.ui?.media,
      mediaAvailable,
      runUrl: run.url,
      slidesEnabled: slidesEnabledValue,
    })
  ) {
    return false;
  }

  const normalized = appearanceControls.getLengthValue().trim().toLowerCase();
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
    return true;
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
  return true;
}

function resetChatState() {
  panelState.chatStreaming = false;
  chatController.reset();
  chatQueueRuntime.clearQueuedMessages();
  chatJumpBtn.classList.remove("isVisible");
  chatSession.reset();
  lastNavigationMessageUrl = null;
}

async function runAgentLoop() {
  await runChatAgentLoop({
    automationEnabled: automationEnabledValue,
    chatController,
    chatSession,
    createStreamingAssistantMessage: buildStreamingAssistantMessage,
    executeToolCall: async (call) => (await executeToolCall(call)) as ToolResultMessage,
    getAutomationToolNames,
    hasDebuggerPermission: () => chrome.permissions.contains({ permissions: ["debugger"] }),
    markAgentNavigationIntent: navigationRuntime.markAgentNavigationIntent,
    markAgentNavigationResult: navigationRuntime.markAgentNavigationResult,
    scrollToBottom,
    summaryMarkdown: panelState.summaryMarkdown,
    wrapMessage,
  });
}

const chatStreamRuntime = createChatStreamRuntime({
  chatEnabled: () => chatEnabledValue,
  isChatStreaming: () => panelState.chatStreaming,
  setChatStreaming: (value) => {
    panelState.chatStreaming = value;
  },
  hasUserMessages: () => chatController.hasUserMessages(),
  addUserMessage: (text) => {
    chatController.addMessage(wrapMessage({ role: "user", content: text, timestamp: Date.now() }));
  },
  dequeueQueuedMessage: chatQueueRuntime.dequeueQueuedMessage,
  getQueuedChatCount: chatQueueRuntime.getQueueLength,
  renderChatQueue: chatQueueRuntime.renderChatQueue,
  focusInput: () => {
    chatInputEl.focus();
  },
  clearErrors: () => {
    errorController.clearAll();
  },
  resetAbort: () => {
    chatSession.resetAbort();
  },
  metricsSetChatMode: () => {
    metricsController.setActiveMode("chat");
  },
  setLastActionChat: () => {
    lastAction = "chat";
  },
  scrollToBottom,
  persistChatHistory,
  setStatus: (value) => {
    headerController.setStatus(value);
  },
  showInlineError: (message) => {
    errorController.showInlineError(message);
  },
  executeAgentLoop: runAgentLoop,
});

function retryLastAction() {
  if (lastAction === "chat") {
    chatStreamRuntime.retryChat();
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
  if (chatBusy || chatQueueRuntime.getQueueLength() > 0) {
    const queued = chatQueueRuntime.enqueueChatMessage(input);
    if (!queued) {
      chatInputEl.value = rawInput;
      chatInputEl.style.height = `${Math.min(chatInputEl.scrollHeight, 120)}px`;
    } else if (!chatBusy) {
      chatStreamRuntime.maybeSendQueuedChat();
    }
    return;
  }

  chatStreamRuntime.startChatMessage(input);
}

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

const persistCurrentModel = (opts?: { focusCustom?: boolean; blurCustom?: boolean }) => {
  updateModelRowUI();
  if (opts?.focusCustom && !modelCustomEl.hidden) modelCustomEl.focus();
  if (opts?.blurCustom) modelCustomEl.blur();
  void (async () => {
    await patchSettings({ model: readCurrentModelValue() });
  })();
};

bindSidepanelUiEvents({
  refreshBtn,
  clearBtn,
  drawerToggleBtn,
  advancedBtn,
  advancedSettingsSummaryEl,
  chatSendBtn,
  chatInputEl,
  sizeSmBtn,
  sizeLgBtn,
  lineTightBtn,
  lineLooseBtn,
  modelPresetEl,
  modelCustomEl,
  slidesLayoutEl,
  modelRefreshBtn,
  advancedSettingsEl,
  lineHeightStep: LINE_HEIGHT_STEP,
  sendSummarize,
  clearCurrentView,
  toggleDrawer: () => drawerControls.toggleDrawer(),
  openOptions: () => send({ type: "panel:openOptions" }),
  toggleAdvancedSettings: drawerControls.toggleAdvancedSettings,
  sendChatMessage,
  bumpFontSize,
  bumpLineHeight,
  persistCurrentModel,
  setSlidesLayout: (next) => {
    setSlidesLayout(next);
    void (async () => {
      await patchSettings({ slidesLayout: next });
    })();
  },
  refreshModelsIfStale: () => {
    if (drawerControls.hasAdvancedSettingsAnimation() && advancedSettingsEl.open) return;
    refreshModelsIfStale();
  },
  runRefreshFree,
});

void (async () => {
  await panelPortRuntime.ensure();
  const loadedSettings = await loadSettings();
  const s = pendingSettingsSnapshot
    ? { ...loadedSettings, ...pendingSettingsSnapshot }
    : loadedSettings;
  pendingSettingsSnapshot = null;
  settingsHydrated = true;
  typographyController.setCurrentFontSize(s.fontSize);
  typographyController.setCurrentLineHeight(s.lineHeight);
  autoValue = s.autoSummarize;
  chatEnabledValue = s.chatEnabled;
  automationEnabledValue = s.automationEnabled;
  slidesLayoutValue = s.slidesLayout;
  slidesLayoutEl.value = slidesLayoutValue;
  if (!automationEnabledValue) hideAutomationNotice();
  appearanceControls.setAutoValue(autoValue);
  applyChatEnabled();
  applySlidesLayout();
  appearanceControls.initializeFromSettings(s);
  setDefaultModelPresets();
  setModelValue(s.model);
  setModelPlaceholderFromDiscovery({});
  updateModelRowUI();
  modelRefreshBtn.disabled = !s.token.trim();
  drawerControls.toggleDrawer(false, { animate: false });
  renderMarkdownDisplay();
  void send({ type: "panel:ready" });
  scheduleAutoKick();
})();

setInterval(() => {
  void send({ type: "panel:ping" });
}, 25_000);

bindSettingsStorage({
  applyChatEnabled,
  hideAutomationNotice,
  getSettingsHydrated: () => settingsHydrated,
  setPendingSettingsSnapshot: (value) => {
    pendingSettingsSnapshot = value;
  },
  getPendingSettingsSnapshot: () => pendingSettingsSnapshot,
  setChatEnabledValue: (value) => {
    chatEnabledValue = value;
  },
  setAutomationEnabledValue: (value) => {
    automationEnabledValue = value;
  },
});

bindSidepanelLifecycle({
  sendReady: () => {
    void send({ type: "panel:ready" });
  },
  sendClosed: () => {
    window.clearTimeout(autoKickTimer);
    void send({ type: "panel:closed" });
  },
  scheduleAutoKick,
  syncWithActiveTab,
  clearInlineError: () => {
    errorController.clearInlineError();
  },
  sendSummarize,
});
