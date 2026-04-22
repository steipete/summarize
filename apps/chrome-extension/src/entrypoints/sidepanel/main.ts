import type { Message, ToolCall } from "@mariozechner/pi-ai";
import { extractYouTubeVideoId } from "@steipete/summarize-core/content/url";
import MarkdownIt from "markdown-it";
import { executeToolCall, getAutomationToolNames } from "../../automation/tools";
import type { BgToPanel, PanelToBg } from "../../lib/panel-contracts";
import type { SseSlidesData } from "../../lib/runtime-contracts";
import {
  defaultSettings,
  loadSettings,
  patchSettings,
  type SlidesLayout,
} from "../../lib/settings";
import { splitSummaryFromSlides } from "../../lib/slides-text";
import { generateToken } from "../../lib/token";
import { createAppearanceControls } from "./appearance-controls";
import { createSidepanelBgMessageRuntime } from "./bg-message-runtime";
import { bindSidepanelUiEvents } from "./bindings";
import { bootstrapSidepanel } from "./bootstrap-runtime";
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
import { createChatUiRuntime } from "./chat-ui-runtime";
import { createSidepanelDom } from "./dom";
import { createErrorController } from "./error-controller";
import { createHeaderController } from "./header-controller";
import { createSidepanelInteractionRuntime } from "./interaction-runtime";
import { createMetricsController } from "./metrics-controller";
import { createNavigationRuntime } from "./navigation-runtime";
import { createPanelCacheController, type PanelCachePayload } from "./panel-cache";
import { createPanelPortRuntime } from "./panel-port";
import {
  normalizePanelUrl,
  panelUrlsMatch,
  shouldAcceptRunForCurrentPage,
  shouldAcceptSlidesForCurrentPage,
} from "./session-policy";
import { createSetupControlsRuntime } from "./setup-controls-runtime";
import { friendlyFetchError } from "./setup-runtime";
import { hasResolvedSlidesPayload } from "./slides-pending";
import { createSidepanelSlidesRuntime } from "./slides-runtime";
import { shouldSeedPlannedSlidesForRun } from "./slides-seed-policy";
import { createSlidesSessionStore } from "./slides-session-store";
import { selectMarkdownForLayout, type SlideTextMode } from "./slides-state";
import { createSlidesTextController } from "./slides-text-controller";
import { createSlidesViewRuntime } from "./slides-view-runtime";
import { createSummarizeControlRuntime } from "./summarize-control-runtime";
import { createSummaryStreamRuntime } from "./summary-stream-runtime";
import { createSummaryViewRuntime } from "./summary-view-runtime";
import { registerSidepanelTestHooks } from "./test-hooks";
import { parseTimestampHref } from "./timestamp-links";
import type { ChatMessage, PanelPhase, PanelState, RunStart, UiState } from "./types";
import { createTypographyController } from "./typography-controller";
import { createUiStateRuntime } from "./ui-state-runtime";

let currentRunTabId: number | null = null;
const {
  advancedBtn,
  advancedSettingsBodyEl,
  advancedSettingsEl,
  advancedSettingsSummaryEl,
  autoToggleRoot,
  automationNoticeActionBtn,
  automationNoticeEl,
  automationNoticeMessageEl,
  automationNoticeTitleEl,
  chatContainerEl,
  chatContextStatusEl,
  chatDockEl,
  chatInputEl,
  chatJumpBtn,
  chatMessagesEl,
  chatMetricsSlotEl,
  chatQueueEl,
  chatSendBtn,
  clearBtn,
  drawerEl,
  drawerToggleBtn,
  errorEl,
  errorLogsBtn,
  errorMessageEl,
  errorRetryBtn,
  headerEl,
  inlineErrorCloseBtn,
  inlineErrorEl,
  inlineErrorLogsBtn,
  inlineErrorMessageEl,
  inlineErrorRetryBtn,
  lengthRoot,
  lineLooseBtn,
  lineTightBtn,
  mainEl,
  metricsEl,
  metricsHomeEl,
  modelCustomEl,
  modelPresetEl,
  modelRefreshBtn,
  modelRowEl,
  modelStatusEl,
  pickersRoot,
  progressFillEl,
  refreshBtn,
  renderEl,
  renderMarkdownHostEl,
  renderSlidesHostEl,
  setupEl,
  sizeLgBtn,
  sizeSmBtn,
  slideNoticeEl,
  slideNoticeMessageEl,
  slideNoticeRetryBtn,
  slidesLayoutEl,
  subtitleEl,
  summarizeControlRoot,
  titleEl,
} = createSidepanelDom();

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

async function send(message: PanelToBg) {
  if (message.type === "panel:summarize") {
    lastAction = "summarize";
  } else if (message.type === "panel:agent") {
    lastAction = "chat";
  }
  await panelPortRuntime.send(message);
}

let autoValue = false;
let chatEnabledValue = defaultSettings.chatEnabled;
let automationEnabledValue = defaultSettings.automationEnabled;
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
let lastAction: "summarize" | "chat" | null = null;
let automationNoticeSticky = false;
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
const slidesSession = createSlidesSessionStore({
  slidesEnabled: defaultSettings.slidesEnabled,
  slidesParallel: defaultSettings.slidesParallel,
  slidesOcrEnabled: defaultSettings.slidesOcrEnabled,
  slidesLayout: defaultSettings.slidesLayout,
});
const slidesState = slidesSession.state;
const pendingSummaryRunsByUrl = new Map<string, RunStart>();
const pendingSlidesRunsByUrl = new Map<string, { runId: string; url: string }>();
const slidesTextController = createSlidesTextController({
  getSlides: () => panelState.slides?.slides ?? null,
  getLengthValue: () => appearanceControls.getLengthValue(),
  getSlidesOcrEnabled: () => slidesState.slidesOcrEnabled,
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
  getActiveUrl: () => activeTabUrl,
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
  slidesSummaryController.stop();
}

function resolveActiveSlidesRunId(): string | null {
  if (panelState.slidesRunId) return panelState.slidesRunId;
  if (!slidesState.slidesParallel && panelState.runId) return panelState.runId;
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
  if (!slidesState.slidesEnabled) return;
  const effectiveInputMode = slidesSession.resolveInputMode();
  if (effectiveInputMode !== "video") return;
  if (slidesHydrator.isStreaming()) return;
  pendingSlidesRunsByUrl.delete(key);
  if (hasResolvedSlidesPayload(panelState.slides, slidesState.slidesSeededSourceId)) return;
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
    summaryStreamRuntime.setPreserveChatOnNextReset(true);
  }
  metricsController.setActiveMode("summary");
  panelState.runId = run.id;
  panelState.slidesRunId = slidesState.slidesParallel ? null : run.id;
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
  slidesState.pendingRunForPlannedSlides = run;
  if (!panelState.summaryMarkdown?.trim()) {
    renderMarkdownDisplay();
  }
  if (!slidesState.slidesParallel) {
    startSlidesStream(run);
  }
  void streamController.start(run);
}

function maybeSeedPlannedSlidesForPendingRun() {
  if (!slidesState.pendingRunForPlannedSlides) return false;
  if (seedPlannedSlidesForRun(slidesState.pendingRunForPlannedSlides)) {
    slidesState.pendingRunForPlannedSlides = null;
    return true;
  }
  return false;
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

let summarizeControlRuntime: ReturnType<typeof createSummarizeControlRuntime> | null = null;

async function handleSummarizeControlChange(value: { mode: "page" | "video"; slides: boolean }) {
  await summarizeControlRuntime?.handleSummarizeControlChange(value);
}

function retrySlidesStream() {
  summarizeControlRuntime?.retrySlidesStream();
}

function applySlidesLayout() {
  summarizeControlRuntime?.applySlidesLayout();
}

function setSlidesLayout(next: SlidesLayout) {
  summarizeControlRuntime?.setSlidesLayout(next);
}

function refreshSummarizeControl() {
  summarizeControlRuntime?.refreshSummarizeControl();
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

async function migrateChatHistory(
  fromTabId: number | null,
  toTabId: number | null,
  toUrl: string | null,
) {
  if (!fromTabId || !toTabId || fromTabId === toTabId) return;
  const messages = chatController.getMessages();
  if (messages.length === 0) return;
  await chatHistoryStore.persist(toTabId, messages, true, toUrl);
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
  getSlidesParallelValue: () => slidesState.slidesParallel,
  getCurrentRunTabId: () => currentRunTabId,
  getActiveTabId: () => activeTabId,
  getActiveTabUrl: () => activeTabUrl,
  setCurrentRunTabId: (value) => {
    currentRunTabId = value;
  },
  setSlidesContextPending: (value) => {
    slidesState.slidesContextPending = value;
  },
  setSlidesContextUrl: (value) => {
    slidesState.slidesContextUrl = value;
  },
  setSlidesSeededSourceId: (value) => {
    slidesState.slidesSeededSourceId = value;
  },
  setSlidesAppliedRunId: (value) => {
    slidesState.slidesAppliedRunId = value;
  },
  setSlidesExpanded: (value) => {
    slidesState.slidesExpanded = value;
  },
  resolveActiveSlidesRunId,
  getSlidesSummaryState: () => ({
    runId: slidesSummaryController.getRunId(),
    markdown: slidesSummaryController.getMarkdown(),
    complete: slidesSummaryController.getComplete(),
    model: slidesSummaryController.getModel(),
  }),
  setSlidesSummaryState: (payload) => {
    slidesSummaryController.setSnapshot(payload);
  },
  clearSlidesSummaryPending: () => {
    slidesSummaryController.clearPending();
  },
  clearSlidesSummaryError: () => {
    slidesSummaryController.clearError();
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

let slidesViewRuntime: ReturnType<typeof createSlidesViewRuntime> | null = null;
let chatUiRuntime: ReturnType<typeof createChatUiRuntime> | null = null;

function renderEmptySummaryState() {
  slidesViewRuntime?.renderEmptySummaryState();
}

function renderMarkdownDisplay() {
  slidesViewRuntime?.renderMarkdownDisplay();
}

function renderMarkdown(markdown: string) {
  slidesViewRuntime?.renderMarkdown(markdown);
}

function setSlidesBusy(next: boolean) {
  slidesViewRuntime?.setSlidesBusy(next);
}

function updateSlideSummaryFromMarkdown(
  markdown: string,
  opts?: { preserveIfEmpty?: boolean; source?: "summary" | "slides" },
) {
  slidesViewRuntime?.updateSlideSummaryFromMarkdown(markdown, opts);
}

function seekToSlideTimestamp(seconds: number | null | undefined) {
  if (seconds == null || !Number.isFinite(seconds)) return;
  void send({ type: "panel:seek", seconds: Math.floor(seconds) });
}
function updateSlidesTextState() {
  slidesViewRuntime?.updateSlidesTextState();
}

function rebuildSlideDescriptions() {
  slidesViewRuntime?.rebuildSlideDescriptions();
}

slidesViewRuntime = createSlidesViewRuntime({
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
    inputMode: slidesSession.resolveInputMode(),
    panelState,
    slidesEnabled: slidesState.slidesEnabled,
    slidesLayout: slidesState.slidesLayout,
    slidesExpanded: slidesState.slidesExpanded,
    mediaAvailable: slidesState.mediaAvailable,
  }),
  setSlidesBusyValue: (value) => {
    slidesState.slidesBusy = value;
  },
  getSlidesBusy: () => slidesState.slidesBusy,
  setSlidesContextPending: (value) => {
    slidesState.slidesContextPending = value;
  },
  getSlidesContextPending: () => slidesState.slidesContextPending,
  setSlidesContextUrl: (value) => {
    slidesState.slidesContextUrl = value;
  },
  getSlidesContextUrl: () => slidesState.slidesContextUrl,
  setSlidesSeededSourceId: (value) => {
    slidesState.slidesSeededSourceId = value;
  },
  getSlidesSeededSourceId: () => slidesState.slidesSeededSourceId,
  setSlidesAppliedRunId: (value) => {
    slidesState.slidesAppliedRunId = value;
  },
  getSlidesAppliedRunId: () => slidesState.slidesAppliedRunId,
  resolveActiveSlidesRunId,
  nextSlidesContextRequestId: () => slidesSession.nextSlidesContextRequestId(),
  setSlidesExpanded: (value) => {
    slidesState.slidesExpanded = value;
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
  getSlideSummaryEntries: () => slidesTextController.getSummaryEntries(),
  getSlideTitleEntries: () => Array.from(slidesTextController.getTitles().entries()),
  getPhase: () => panelState.phase,
  getModel: () => panelState.lastMeta.model ?? null,
  getSlidesTimeline: () =>
    panelState.slides?.slides.map((slide) => ({
      index: slide.index,
      timestamp: Number.isFinite(slide.timestamp) ? slide.timestamp : null,
    })) ?? [],
  getTranscriptTimedText: () => slidesTextController.getTranscriptTimedText(),
  getSlidesSummaryMarkdown: () => slidesSummaryController.getMarkdown(),
  getSlidesSummaryComplete: () => slidesSummaryController.getComplete(),
  getSlidesSummaryModel: () => slidesSummaryController.getModel(),
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
    mode: slidesSession.resolveInputMode(),
    slides: slidesState.slidesEnabled,
    mediaAvailable: slidesState.mediaAvailable,
  }),
  getSlidesState: () => ({
    slidesCount: panelState.slides?.slides.length ?? 0,
    layout: slidesState.slidesLayout,
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
    panelState.slidesRunId = slidesState.slidesParallel ? null : payload.run.id;
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
    slidesState.slidesEnabled = true;
    slidesState.inputMode = "video";
    slidesState.inputModeOverride = "video";
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

function applyChatEnabled() {
  chatUiRuntime?.applyChatEnabled();
}

async function clearChatHistoryForActiveTab() {
  await chatUiRuntime?.clearChatHistoryForActiveTab();
}

async function persistChatHistory() {
  await chatUiRuntime?.persistChatHistory();
}

function resetChatState() {
  chatUiRuntime?.resetChatState();
}

async function restoreChatHistory() {
  await chatUiRuntime?.restoreChatHistory();
}

function scrollToBottom(force = false) {
  chatUiRuntime?.scrollToBottom(force);
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

chatUiRuntime = createChatUiRuntime({
  mainEl,
  chatJumpBtn,
  chatInputEl,
  chatDockEl,
  chatContainerEl,
  chatDockContainerEl: chatDockEl,
  renderEl,
  getChatEnabled: () => chatEnabledValue,
  getActiveTabId: () => activeTabId,
  getSummaryMarkdown: () => panelState.summaryMarkdown,
  clearMetrics: () => {
    metricsController.clearForMode("chat");
  },
  clearQueuedMessages: () => {
    chatQueueRuntime.clearQueuedMessages();
  },
  clearHistory: (tabId) => chatHistoryRuntime.clear(tabId),
  loadHistory: (tabId) => chatHistoryRuntime.load(tabId),
  persistHistory: (tabId, chatEnabled) => chatHistoryRuntime.persist(tabId, chatEnabled),
  restoreHistory: (tabId, summaryMarkdown) => chatHistoryRuntime.restore(tabId, summaryMarkdown),
  resetChatController: () => {
    panelState.chatStreaming = false;
    chatController.reset();
  },
  resetChatSession: () => {
    chatSession.reset();
  },
});

const setupControlsRuntime = createSetupControlsRuntime({
  advancedSettingsBodyEl,
  advancedSettingsEl,
  defaultModel: defaultSettings.model,
  drawerEl,
  drawerToggleBtn,
  friendlyFetchError,
  generateToken,
  getStatusResetText: () => panelState.ui?.status ?? "",
  headerSetStatus: (text) => {
    headerController.setStatus(text);
  },
  loadSettings,
  modelCustomEl,
  modelPresetEl,
  modelRefreshBtn,
  modelRowEl,
  modelStatusEl,
  patchSettings,
  setupEl,
});
const {
  drawerControls,
  isRefreshFreeRunning,
  maybeShowSetup,
  readCurrentModelValue,
  refreshModelsIfStale,
  runRefreshFree,
  setDefaultModelPresets,
  setModelPlaceholderFromDiscovery,
  setModelValue,
  updateModelRowUI,
} = setupControlsRuntime;

const slidesRuntime = createSidepanelSlidesRuntime({
  applySlidesPayload,
  clearSummarySource: () => {
    slidesTextController.clearSummarySource();
  },
  friendlyFetchError,
  getActiveTabUrl: () => activeTabUrl,
  getInputMode: () => slidesState.inputMode,
  getInputModeOverride: () => slidesState.inputModeOverride,
  getLengthValue: () => appearanceControls.getLengthValue(),
  getPanelPhase: () => panelState.phase,
  getPanelState: () => panelState,
  getSlidesEnabled: () => slidesState.slidesEnabled,
  getToken: async () => (await loadSettings()).token,
  getTranscriptTimedText: () => slidesTextController.getTranscriptTimedText(),
  getUiState: () => panelState.ui,
  headerSetStatus: (text) => {
    headerController.setStatus(text);
  },
  hideSlideNotice,
  isStreaming,
  panelUrlsMatch,
  refreshSummarizeControl,
  renderInlineSlidesFallback: () => {
    renderInlineSlides(renderMarkdownHostEl, { fallback: true });
  },
  renderMarkdown,
  schedulePanelCacheSync: () => {
    panelCacheController.scheduleSync();
  },
  setInputMode: (value) => {
    slidesState.inputMode = value;
  },
  setInputModeOverride: (value) => {
    slidesState.inputModeOverride = value;
  },
  setSlidesBusy,
  setSlidesRunId: (value) => {
    panelState.slidesRunId = value;
  },
  showSlideNotice,
  stopSlidesStream,
  stopSlidesSummaryStream,
  updateSlideSummaryFromMarkdown,
});
const {
  applySlidesSummaryMarkdown,
  handleSlidesStatus,
  maybeApplyPendingSlidesSummary,
  slidesHydrator: activeSlidesHydrator,
  slidesSummaryController,
  startSlidesStream,
  startSlidesStreamForRunId,
  startSlidesSummaryStreamForRunId,
} = slidesRuntime;
slidesHydrator = activeSlidesHydrator;

const summaryStreamRuntime = createSummaryStreamRuntime({
  friendlyFetchError,
  getFallbackModel: () => panelState.ui?.settings.model ?? null,
  getToken: async () => (await loadSettings()).token,
  handleSlides: (data) => {
    slidesHydrator.handlePayload(data);
  },
  handleSummaryFromCache: (value) => {
    slidesHydrator.handleSummaryFromCache(value);
  },
  headerArmProgress: () => {
    headerController.armProgress();
  },
  headerSetBaseSubtitle: (text) => {
    headerController.setBaseSubtitle(text);
  },
  headerSetBaseTitle: (text) => {
    headerController.setBaseTitle(text);
  },
  headerSetStatus: (text) => {
    headerController.setStatus(text);
  },
  headerStopProgress: () => {
    headerController.stopProgress();
  },
  isStreaming,
  maybeApplyPendingSlidesSummary,
  panelState,
  queueSlidesRender,
  rebuildSlideDescriptions,
  refreshSummaryMetrics: (summary) => {
    metricsController.setForMode(
      "summary",
      summary,
      panelState.lastMeta.inputSummary,
      panelState.currentSource?.url ?? null,
    );
    metricsController.setActiveMode("summary");
  },
  rememberUrl: (url) => {
    void send({ type: "panel:rememberUrl", url });
  },
  renderMarkdown,
  resetSummaryView,
  schedulePanelCacheSync: () => {
    panelCacheController.scheduleSync();
  },
  seedPlannedSlidesForPendingRun: () => {
    if (slidesState.pendingRunForPlannedSlides) {
      seedPlannedSlidesForRun(slidesState.pendingRunForPlannedSlides);
      slidesState.pendingRunForPlannedSlides = null;
    }
  },
  setSlidesBusy,
  setPhase,
  shouldRebuildSlideDescriptions: () => !slidesTextController.hasSummaryTitles(),
  syncWithActiveTab,
});
const { streamController } = summaryStreamRuntime;

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
  resolveActiveSlidesRunId,
  applyPanelCache,
  resetSummaryView,
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
  getSlidesEnabledValue: () => slidesState.slidesEnabled,
  setSlidesEnabledValue: (value) => {
    slidesState.slidesEnabled = value;
  },
  getSlidesParallelValue: () => slidesState.slidesParallel,
  setSlidesParallelValue: (value) => {
    slidesState.slidesParallel = value;
  },
  getSlidesOcrEnabledValue: () => slidesState.slidesOcrEnabled,
  setSlidesOcrEnabledValue: (value) => {
    slidesState.slidesOcrEnabled = value;
  },
  getInputMode: () => slidesState.inputMode,
  setInputMode: (value) => {
    slidesState.inputMode = value;
  },
  getInputModeOverride: () => slidesState.inputModeOverride,
  setInputModeOverride: (value) => {
    slidesState.inputModeOverride = value;
  },
  getMediaAvailable: () => slidesState.mediaAvailable,
  setMediaAvailable: (value) => {
    slidesState.mediaAvailable = value;
  },
  getSlidesLayoutValue: () => slidesState.slidesLayout,
  setSummarizeVideoLabel: (value) => {
    slidesState.summarizeVideoLabel = value;
  },
  setSummarizePageWords: (value) => {
    slidesState.summarizePageWords = value;
  },
  setSummarizeVideoDurationSeconds: (value) => {
    slidesState.summarizeVideoDurationSeconds = value;
  },
  isStreaming,
  getSlidesBusy: () => slidesState.slidesBusy,
  onSlidesOcrChanged: updateSlidesTextState,
});

function updateControls(state: UiState) {
  uiStateRuntime.apply(state);
}

const bgMessageRuntime = createSidepanelBgMessageRuntime({
  panelState,
  applyUiState: updateControls,
  setStatus: (text) => {
    headerController.setStatus(text);
  },
  isStreaming,
  setPhase,
  finishStreamingMessage: () => {
    chatStreamRuntime.finishStreamingMessage();
  },
  setSlidesBusy,
  showSlideNotice,
  getActiveTabUrl: () => activeTabUrl,
  rememberPendingSlidesRun: (value) => {
    pendingSlidesRunsByUrl.set(normalizePanelUrl(value.url), value);
  },
  startSlidesStreamForRunId,
  startSlidesSummaryStreamForRunId: (runId, url) => {
    startSlidesSummaryStreamForRunId(runId, url ?? null);
  },
  getSlidesContextRequestId: () => slidesState.slidesContextRequestId,
  setSlidesContextPending: (value) => {
    slidesState.slidesContextPending = value;
  },
  setSlidesTranscriptTimedText,
  updateSlidesTextState,
  getSlidesSummaryState: () => ({
    complete: slidesSummaryController.getComplete(),
    markdown: slidesSummaryController.getMarkdown(),
  }),
  updateSlideSummaryFromMarkdown,
  renderInlineSlidesFallback: () => {
    renderInlineSlides(renderMarkdownHostEl, { fallback: true });
  },
  schedulePanelCacheSync: () => {
    panelCacheController.scheduleSync();
  },
  consumeUiCache: (cacheMessage) => panelCacheController.consumeResponse(cacheMessage),
  getActiveTabId: () => activeTabId,
  applyPanelCache: (cache, opts) => {
    applyPanelCache(cache as PanelCachePayload, opts);
  },
  rememberPendingSummaryRun: (run) => {
    pendingSummaryRunsByUrl.set(normalizePanelUrl(run.url), run);
  },
  attachSummaryRun,
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

function handleBgMessage(msg: BgToPanel) {
  bgMessageRuntime.handle(msg);
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

const interactionRuntime = createSidepanelInteractionRuntime({
  sendRawMessage: (message) => panelPortRuntime.send(message as PanelToBg),
  setLastAction: (value) => {
    lastAction = value;
  },
  clearInlineError: () => {
    errorController.clearInlineError();
  },
  getInputModeOverride: () => slidesState.inputModeOverride,
  retryChat: () => {
    chatStreamRuntime.retryChat();
  },
  chatEnabled: () => chatEnabledValue,
  getRawChatInput: () => chatInputEl.value,
  clearChatInput: () => {
    chatInputEl.value = "";
    chatInputEl.style.height = "auto";
  },
  restoreChatInput: (value) => {
    chatInputEl.value = value;
  },
  getChatInputScrollHeight: () => chatInputEl.scrollHeight,
  setChatInputHeight: (value) => {
    chatInputEl.style.height = value;
  },
  isChatStreaming: () => panelState.chatStreaming,
  getQueuedChatCount: () => chatQueueRuntime.getQueueLength(),
  enqueueChatMessage: (value) => chatQueueRuntime.enqueueChatMessage(value),
  maybeSendQueuedChat: () => {
    chatStreamRuntime.maybeSendQueuedChat();
  },
  startChatMessage: (value) => {
    chatStreamRuntime.startChatMessage(value);
  },
  typographyController,
  patchSettings,
  updateModelRowUI,
  isCustomModelHidden: () => modelCustomEl.hidden,
  focusCustomModel: () => {
    modelCustomEl.focus();
  },
  blurCustomModel: () => {
    modelCustomEl.blur();
  },
  readCurrentModelValue,
});
const { sendSummarize, sendChatMessage, bumpFontSize, bumpLineHeight, persistCurrentModel } =
  interactionRuntime;

summarizeControlRuntime = createSummarizeControlRuntime({
  summarizeControlRoot,
  renderMarkdownHostEl,
  renderSlidesHostEl,
  slidesLayoutEl,
  slidesTextController,
  getState: () => ({
    inputMode: slidesState.inputMode,
    inputModeOverride: slidesState.inputModeOverride,
    hasSummaryMarkdown: Boolean(panelState.summaryMarkdown),
    slidesEnabled: slidesState.slidesEnabled,
    slidesOcrEnabled: slidesState.slidesOcrEnabled,
    autoSummarize: autoValue,
    slidesBusy: slidesState.slidesBusy,
    mediaAvailable: slidesState.mediaAvailable,
    slidesLayout: slidesState.slidesLayout,
    summarizeVideoLabel: slidesState.summarizeVideoLabel,
    summarizePageWords: slidesState.summarizePageWords,
    summarizeVideoDurationSeconds: slidesState.summarizeVideoDurationSeconds,
    activeTabUrl,
    currentSourceUrl: panelState.currentSource?.url ?? null,
  }),
  setInputMode: (value) => {
    slidesState.inputMode = value;
  },
  setInputModeOverride: (value) => {
    slidesState.inputModeOverride = value;
  },
  setSlidesEnabled: (value) => {
    slidesState.slidesEnabled = value;
  },
  setSlidesLayoutValue: (value) => {
    slidesState.slidesLayout = value;
  },
  patchSettings,
  loadSettings,
  showSlideNotice: (message) => {
    showSlideNotice(message);
  },
  hideSlideNotice,
  setSlidesBusy,
  stopSlidesStream,
  maybeApplyPendingSlidesSummary,
  maybeStartPendingSlidesForUrl,
  sendSummarize: (opts) => {
    sendSummarize(opts);
  },
  resolveActiveSlidesRunId,
  startSlidesStreamForRunId,
  startSlidesSummaryStreamForRunId: (runId, url) => {
    startSlidesSummaryStreamForRunId(runId, url ?? null);
  },
  renderMarkdownDisplay,
  renderInlineSlidesFallback: () => {
    renderInlineSlides(renderMarkdownHostEl, { fallback: true });
  },
  queueSlidesRender,
  applySlidesRendererLayout: () => {
    slidesRenderer?.applyLayout();
  },
});

function seedPlannedSlidesForRun(run: RunStart) {
  const durationSeconds =
    slidesState.summarizeVideoDurationSeconds ?? panelState.ui?.stats.videoDurationSeconds ?? null;
  if (
    !shouldSeedPlannedSlidesForRun({
      durationSeconds,
      inputMode: slidesSession.resolveInputMode(),
      media: panelState.ui?.media,
      mediaAvailable: slidesState.mediaAvailable,
      runUrl: run.url,
      slidesEnabled: slidesState.slidesEnabled,
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
  slidesState.slidesSeededSourceId = sourceId;
  updateSlidesTextState();
  void requestSlidesContext();
  queueSlidesRender();
  panelCacheController.scheduleSync(0);
  return true;
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
  interactionRuntime.retryLastAction(lastAction);
}

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

bootstrapSidepanel({
  ensurePanelPort: () => panelPortRuntime.ensure(),
  loadSettings,
  getPendingSettingsSnapshot: () => pendingSettingsSnapshot,
  clearPendingSettingsSnapshot: () => {
    pendingSettingsSnapshot = null;
  },
  setSettingsHydrated: (value) => {
    settingsHydrated = value;
  },
  typographyController,
  setAutoValue: (value) => {
    autoValue = value;
  },
  setChatEnabledValue: (value) => {
    chatEnabledValue = value;
  },
  setAutomationEnabledValue: (value) => {
    automationEnabledValue = value;
  },
  setSlidesLayoutValue: (value) => {
    slidesState.slidesLayout = value as SlidesLayout;
  },
  setSlidesLayoutInputValue: (value) => {
    slidesLayoutEl.value = value;
  },
  hideAutomationNotice: () => {
    hideAutomationNotice();
  },
  appearanceControls,
  applyChatEnabled,
  applySlidesLayout,
  setDefaultModelPresets,
  setModelValue,
  setModelPlaceholderFromDiscovery,
  updateModelRowUI,
  setModelRefreshDisabled: (value) => {
    modelRefreshBtn.disabled = value;
  },
  toggleDrawerClosed: () => {
    drawerControls.toggleDrawer(false, { animate: false });
  },
  renderMarkdownDisplay,
  sendReady: () => {
    void send({ type: "panel:ready" });
  },
  scheduleAutoKick,
  sendPing: () => {
    void send({ type: "panel:ping" });
  },
  bindSettingsStorage: {
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
  },
  bindSidepanelLifecycle: {
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
  },
});
