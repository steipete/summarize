import MarkdownIt from "markdown-it";
import type { BgToPanel } from "../../lib/panel-contracts";
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
import { createAutoSummarizeRuntime } from "./auto-summarize-runtime";
import { createSidepanelBgMessageRuntime } from "./bg-message-runtime";
import { bindSidepanelUiEvents } from "./bindings";
import { bootstrapSidepanel } from "./bootstrap-runtime";
import { createSidepanelChatRuntime } from "./chat-runtime";
import { createSidepanelDom } from "./dom";
import { createSidepanelFeedbackRuntime } from "./feedback-runtime";
import { createSidepanelInteractionRuntime } from "./interaction-runtime";
import { createMetricsController } from "./metrics-controller";
import { createNavigationRuntime } from "./navigation-runtime";
import {
  buildPanelCachePayload,
  createPanelCacheController,
  type PanelCachePayload,
} from "./panel-cache";
import { createPanelMessagingRuntime } from "./panel-messaging";
import { createPanelStateStore } from "./panel-state-store";
import { createPanelPhaseRuntime } from "./phase-runtime";
import { createPlannedSlidesRuntime } from "./planned-slides-runtime";
import {
  retainRenderedSlideSummary,
  selectRetainedSlideSummaryMarkdown,
} from "./retained-slide-summary";
import { panelUrlsMatch } from "./session-policy";
import { createSetupControlsRuntime } from "./setup-controls-runtime";
import { friendlyFetchError } from "./setup-runtime";
import { createSidepanelSlidesRuntime } from "./slides-runtime";
import { resolveSlidesInputMode } from "./slides-session-state";
import { selectMarkdownForLayout, type SlideTextMode } from "./slides-state";
import { createSlidesTextController, type SlideSummarySource } from "./slides-text-controller";
import { createSlidesViewRuntime } from "./slides-view-runtime";
import { createSummarizeCommand } from "./summarize-command";
import { createSummarizeControlRuntime } from "./summarize-control-runtime";
import { createSummarizeControlView } from "./summarize-control-view";
import { createSummaryRunRuntime } from "./summary-run-runtime";
import { createSummaryStreamRuntime } from "./summary-stream-runtime";
import { createSummaryViewRuntime } from "./summary-view-runtime";
import { registerSidepanelTestHooks } from "./test-hooks";
import { parseTimestampHref } from "./timestamp-links";
import type { UiState } from "./types";
import { createTypographyController } from "./typography-controller";
import { createUiStateRuntime } from "./ui-state-runtime";

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
  summaryCopyBtn,
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

const panelStateStore = createPanelStateStore();
const panelState = panelStateStore.state;
const getActiveTabId = () => panelState.navigation.activeTabId;
const getActiveTabUrl = () => panelState.navigation.activeTabUrl;
const getSlidesState = () => panelState.slidesSession;
const updateSlidesState = (value: Partial<typeof panelState.slidesSession>) => {
  panelStateStore.dispatch({ type: "slides-session-update", value });
};
const getPanelSession = () => panelState.panelSession;
const updatePanelSession = (value: Partial<typeof panelState.panelSession>) => {
  panelStateStore.dispatch({ type: "panel-session-update", value });
};

const panelMessagingRuntime = createPanelMessagingRuntime({
  panelState,
  dispatchPanelState: panelStateStore.dispatch,
  onMessage: (msg) => {
    handleBgMessage(msg);
  },
});
const { handleLocalSlidesResponse, resolveLocalSlides, send } = panelMessagingRuntime;

const LINE_HEIGHT_STEP = 0.1;

const appearanceControls = createAppearanceControls({
  autoToggleRoot,
  pickersRoot,
  lengthRoot,
  patchSettings,
  sendSetAuto: (checked) => {
    updatePanelSession({ autoSummarize: checked });
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

const slidesTextController = createSlidesTextController({
  getSlides: () => panelState.slides?.slides ?? null,
  getLengthValue: () => appearanceControls.getLengthValue(),
  getSlidesOcrEnabled: () => getSlidesState().slidesOcrEnabled,
});

function stopSlidesStream() {
  slidesRuntime.stopSlidesStream();
}

function setSlidesTranscriptTimedText(value: string | null) {
  slidesTextController.setTranscriptTimedText(value);
}

renderEl.addEventListener("click", (event) => {
  const target = event.target as HTMLElement | null;
  if (!target) return;
  const link = target.closest("a.chatTimestamp") as HTMLAnchorElement | null;
  if (!link) return;
  const href = link.getAttribute("href") ?? "";
  if (!href.startsWith("timestamp:")) return;
  event.preventDefault();
  event.stopPropagation();
  const seconds = parseTimestampHref(href);
  if (seconds == null) return;
  void send({ type: "panel:seek", seconds });
});

async function handleSummarizeControlChange(value: { mode: "page" | "video"; slides: boolean }) {
  await summarizeControlRuntime.handleSummarizeControlChange(value);
  refreshSummarizeControl();
}

function handleSlidesTextModeChange(value: SlideTextMode) {
  summarizeControlRuntime.handleSlidesTextModeChange(value);
  refreshSummarizeControl();
}

function retrySlidesStream() {
  summarizeControlRuntime.retrySlidesStream();
}

function applySlidesLayout() {
  summarizeControlRuntime.applySlidesLayout();
}

function setSlidesLayout(next: SlidesLayout) {
  summarizeControlRuntime.setSlidesLayout(next);
}

function refreshSummarizeControl() {
  summarizeControlView.refresh();
}

const isStreaming = () => panelState.phase === "connecting" || panelState.phase === "streaming";

const feedbackRuntime = createSidepanelFeedbackRuntime({
  panelState,
  headerEl,
  titleEl,
  subtitleEl,
  progressFillEl,
  panelErrorEl: errorEl,
  panelErrorMessageEl: errorMessageEl,
  panelErrorRetryBtn: errorRetryBtn,
  panelErrorLogsBtn: errorLogsBtn,
  inlineErrorEl,
  inlineErrorMessageEl,
  inlineErrorRetryBtn,
  inlineErrorLogsBtn,
  inlineErrorCloseBtn,
  slideNoticeEl,
  slideNoticeMessageEl,
  slideNoticeRetryBtn,
  retryLastAction,
  retrySlidesStream,
  sendOpenOptions: () => {
    void send({ type: "panel:openOptions" });
  },
});
const { errorController, headerController, hideSlideNotice, showSlideNotice } = feedbackRuntime;

const sendSummarize = createSummarizeCommand({
  send,
  setLastAction: (value) => {
    updatePanelSession({ lastAction: value });
  },
  clearInlineError: () => {
    errorController.clearInlineError();
  },
  getInputModeOverride: () => getSlidesState().inputModeOverride,
});

const summarizeControlView = createSummarizeControlView({
  root: summarizeControlRoot,
  panelState,
  slidesTextController,
  onSlidesTextModeChange: handleSlidesTextModeChange,
  onChange: handleSummarizeControlChange,
  onSummarize: sendSummarize,
});

const panelCacheController = createPanelCacheController({
  getSnapshot: () =>
    buildPanelCachePayload(panelState, slidesTextController.getTranscriptTimedText()),
  sendCache: (payload) => {
    void send({ type: "panel:cache", cache: payload });
  },
  sendRequest: (request) => {
    void send({ type: "panel:get-cache", ...request });
  },
});

const slidesViewRuntime = createSlidesViewRuntime({
  renderMarkdownHostEl,
  renderSlidesHostEl,
  summaryCopyBtn,
  chatMessagesEl,
  md,
  headerSetStatus: (text) => headerController.setStatus(text),
  headerSetProgressOverride: (busy) => headerController.setProgressOverride(busy),
  slidesTextController,
  panelCacheController,
  send,
  refreshSummarizeControl,
  hideSlideNotice,
  panelState,
  dispatchPanelState: panelStateStore.dispatch,
  getFallbackSummaryMarkdown: () => selectRetainedSlideSummaryMarkdown(panelState),
});

const slidesRuntime = createSidepanelSlidesRuntime({
  applySlidesPayload,
  clearSummarySource: () => {
    slidesTextController.clearSummarySource();
  },
  panelState,
  dispatchPanelState: panelStateStore.dispatch,
  friendlyFetchError,
  getLengthValue: () => appearanceControls.getLengthValue(),
  getToken: async () => (await loadSettings()).token,
  resolveLocalSlides,
  getTranscriptTimedText: () => slidesTextController.getTranscriptTimedText(),
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
  setSlidesBusy,
  showSlideNotice,
  updateSlideSummaryFromMarkdown,
});
const {
  applySlidesSummaryMarkdown,
  handleSlidesStatus,
  isActiveSlidesRunLocal,
  maybeApplyPendingSlidesSummary,
  maybeStartPendingSlidesForUrl,
  rememberPendingSlidesRun,
  resolveActiveSlidesRunId,
  slidesHydrator: activeSlidesHydrator,
  startSlidesStream,
  startSlidesStreamForRunId,
  startSlidesSummaryStreamForRunId,
} = slidesRuntime;

const summarizeControlRuntime = createSummarizeControlRuntime({
  renderMarkdownHostEl,
  renderSlidesHostEl,
  slidesLayoutEl,
  slidesTextController,
  panelState,
  dispatchPanelState: panelStateStore.dispatch,
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
  sendSummarize,
  resolveActiveSlidesRunId,
  isActiveSlidesRunLocal,
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
    slidesViewRuntime.slidesRenderer.applyLayout();
  },
});

const phaseRuntime = createPanelPhaseRuntime({
  panelState,
  dispatchPanelState: panelStateStore.dispatch,
  errorController,
  headerController,
  setSlidesBusy,
  rebuildSlideDescriptions,
  queueSlidesRender,
});
const { setPhase } = phaseRuntime;

const navigationRuntime = createNavigationRuntime({
  getCurrentSource: () => panelState.currentSource,
  setCurrentSource: (source) => {
    panelStateStore.dispatch({ type: "source", source });
  },
  resetForNavigation: (preserveChat) => {
    setPhase("idle");
    resetSummaryView({ preserveChat });
    headerController.setBaseSubtitle("");
  },
  setBaseTitle: (title) => {
    headerController.setBaseTitle(title);
  },
});

const chatRuntime = createSidepanelChatRuntime({
  panelState,
  dispatchPanelState: panelStateStore.dispatch,
  markdown: md,
  mainEl,
  renderEl,
  chatContainerEl,
  chatContextStatusEl,
  chatDockEl,
  chatInputEl,
  chatJumpBtn,
  chatMessagesEl,
  chatQueueEl,
  chatSendBtn,
  automationNoticeActionBtn,
  automationNoticeEl,
  automationNoticeMessageEl,
  automationNoticeTitleEl,
  getActiveTabId,
  getActiveTabUrl,
  getNavigationRuntime: () => navigationRuntime,
  send,
  setStatus: (value) => {
    headerController.setStatus(value);
  },
  clearErrors: () => {
    errorController.clearAll();
  },
  showInlineError: (message) => {
    errorController.showInlineError(message);
  },
  clearChatMetrics: () => {
    metricsController.clearForMode("chat");
  },
  setChatMetricsMode: () => {
    metricsController.setActiveMode("chat");
  },
  setLastActionChat: () => {
    updatePanelSession({ lastAction: "chat" });
  },
  renderInlineSlides: () => {
    renderInlineSlides(chatMessagesEl);
  },
  seekToTimestamp: (seconds) => {
    void send({ type: "panel:seek", seconds });
  },
});

const syncWithActiveTab = () => navigationRuntime.syncWithActiveTab();

async function clearCurrentView() {
  panelStateStore.dispatch({ type: "retained-slide-summary", value: null });
  if (panelState.chat.streaming) {
    chatRuntime.requestAbort("Cleared");
  }
  streamController.abort();
  stopSlidesStream();
  resetSummaryView({ preserveChat: false });
  await chatRuntime.clearHistoryForActiveTab();
  panelCacheController.scheduleSync();
  headerController.setStatus("");
  setPhase("idle");
}

const summaryViewRuntime = createSummaryViewRuntime({
  panelState,
  dispatchPanelState: panelStateStore.dispatch,
  renderEl,
  renderSlidesHostEl,
  renderMarkdownHostEl,
  summaryCopyBtn,
  slidesRenderer: slidesViewRuntime.slidesRenderer,
  metricsController,
  headerController,
  slidesTextController,
  slidesHydrator: activeSlidesHydrator,
  stopSlidesStream,
  refreshSummarizeControl,
  resetChatState: chatRuntime.reset,
  setSlidesTranscriptTimedText,
  updateSlidesTextState,
  requestSlidesContext,
  requestSlidesCapture: () => {
    void send({ type: "panel:slides-capture" });
  },
  updateSlideSummaryFromMarkdown,
  renderMarkdown,
  renderMarkdownDisplay,
  queueSlidesRender,
  setPhase,
});
const { applyPanelCache, resetSummaryView } = summaryViewRuntime;

function renderEmptySummaryState() {
  slidesViewRuntime.renderEmptySummaryState();
}

function renderMarkdownDisplay() {
  slidesViewRuntime.renderMarkdownDisplay();
}

function renderMarkdown(markdown: string) {
  retainRenderedSlideSummary(panelState, panelStateStore.dispatch, markdown);
  slidesViewRuntime.renderMarkdown(markdown);
}

function setSlidesBusy(next: boolean) {
  slidesViewRuntime.setSlidesBusy(next);
}

function updateSlideSummaryFromMarkdown(
  markdown: string,
  opts?: {
    preserveIfEmpty?: boolean;
    source?: Exclude<SlideSummarySource, null>;
  },
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

function applySlidesPayload(data: SseSlidesData) {
  slidesViewRuntime.applySlidesPayload(data, setSlidesTranscriptTimedText);
}

registerSidepanelTestHooks({
  applySlidesPayload,
  getRunId: () => panelState.runId,
  getSummaryMarkdown: () => panelState.summaryMarkdown ?? "",
  getRetainedSlideSummaryMarkdown: () => selectRetainedSlideSummaryMarkdown(panelState) ?? "",
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
  getSlidesSummaryMarkdown: () => panelState.slidesSummary.markdown,
  getSlidesSummaryComplete: () => panelState.slidesSummary.complete,
  getSlidesSummaryModel: () => panelState.slidesSummary.model,
  getChatEnabled: () => getPanelSession().chatEnabled,
  getSettingsHydrated: () => getPanelSession().settingsHydrated,
  setTranscriptTimedText: (value) => {
    setSlidesTranscriptTimedText(value);
    updateSlidesTextState();
  },
  setSummarizeMode: async (payload) => {
    await handleSummarizeControlChange(payload);
  },
  getSummarizeMode: () => ({
    mode: resolveSlidesInputMode(getSlidesState()),
    slides: getSlidesState().slidesEnabled,
    mediaAvailable: getSlidesState().mediaAvailable,
  }),
  getSlidesState: () => ({
    slidesCount: panelState.slides?.slides.length ?? 0,
    layout: getSlidesState().slidesLayout,
    hasSlides: Boolean(panelState.slides),
  }),
  renderSlidesNow: () => {
    queueSlidesRender();
  },
  applyUiState: (state) => {
    panelStateStore.dispatch({ type: "ui", ui: state });
    updateControls(state);
  },
  applyBgMessage: (message) => {
    handleBgMessage(message);
  },
  applySummarySnapshot: (payload) => {
    summaryRunRuntime.applySnapshot(payload);
  },
  applySummaryMarkdown: (markdown) => {
    renderMarkdown(markdown);
    setPhase("idle");
  },
  applySlidesSummaryMarkdown: (markdown) => {
    updateSlideSummaryFromMarkdown(markdown, {
      preserveIfEmpty: true,
      source: "slides-partial",
    });
    setPhase("idle");
  },
  forceRenderSlides: () => {
    updateSlidesState({
      slidesEnabled: true,
      inputMode: "video",
      inputModeOverride: "video",
    });
    return slidesViewRuntime.slidesRenderer.forceRender();
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

const plannedSlidesRuntime = createPlannedSlidesRuntime({
  panelState,
  dispatchPanelState: panelStateStore.dispatch,
  getActiveTabUrl,
  getLengthValue: () => appearanceControls.getLengthValue(),
  updateSlidesTextState,
  queueSlidesRender,
  schedulePanelCacheSync: (delayMs) => panelCacheController.scheduleSync(delayMs),
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

const summaryStreamRuntime = createSummaryStreamRuntime({
  friendlyFetchError,
  getFallbackModel: () => panelState.ui?.settings.model ?? null,
  getToken: async () => (await loadSettings()).token,
  handleSlides: activeSlidesHydrator.handlePayload,
  handleSummaryFromCache: activeSlidesHydrator.handleSummaryFromCache,
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
  dispatchPanelState: panelStateStore.dispatch,
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
    plannedSlidesRuntime.seedPendingRunAndConsumeWhenReady();
  },
  setSlidesBusy,
  setPhase,
  shouldRebuildSlideDescriptions: () => !slidesTextController.hasSummaryTitles(),
  syncWithActiveTab,
});
const { streamController } = summaryStreamRuntime;

const autoSummarizeRuntime = createAutoSummarizeRuntime({
  getEnabled: () => getPanelSession().autoSummarize,
  getPhase: () => panelState.phase,
  hasSummary: () => Boolean(panelState.summaryMarkdown),
  summarize: () => {
    sendSummarize();
  },
});

const summaryRunRuntime = createSummaryRunRuntime({
  panelState,
  dispatchPanelState: panelStateStore.dispatch,
  getActiveTabId,
  cancelAutoSummarize: autoSummarizeRuntime.cancel,
  summaryStream: {
    isStreaming: streamController.isStreaming,
    setPreserveChatOnNextReset: summaryStreamRuntime.setPreserveChatOnNextReset,
    start: streamController.start,
  },
  slides: {
    getHydratedRunId: activeSlidesHydrator.getActiveRunId,
    queueRender: queueSlidesRender,
    seedPlannedRun: plannedSlidesRuntime.seedForRun,
    setTranscriptTimedText: setSlidesTranscriptTimedText,
    start: startSlidesStream,
    stop: stopSlidesStream,
    updateTextState: updateSlidesTextState,
  },
  chat: {
    clearHistory: chatRuntime.clearHistoryForActiveTab,
    finishStreamingMessage: chatRuntime.finishStreamingMessage,
    reset: chatRuntime.reset,
    shouldPreserveForRun: navigationRuntime.shouldPreserveChatForRun,
  },
  view: {
    queueEmptyRender: renderMarkdownDisplay,
    renderMarkdown,
    reset: resetSummaryView,
    setHeaderSubtitle: (value) => headerController.setBaseSubtitle(value),
    setHeaderTitle: (value) => headerController.setBaseTitle(value),
    setMetricsMode: (mode) => metricsController.setActiveMode(mode),
    setPhase,
  },
});

const uiStateRuntime = createUiStateRuntime({
  panelState,
  dispatchPanelState: panelStateStore.dispatch,
  appearanceControls,
  typographyController,
  navigationRuntime,
  panelCacheController,
  headerController,
  clearInlineError: () => {
    errorController.clearInlineError();
  },
  requestAgentAbort: chatRuntime.requestAbort,
  clearChatHistoryForActiveTab: chatRuntime.clearHistoryForActiveTab,
  resetChatState: chatRuntime.reset,
  migrateChatHistory: chatRuntime.migrateHistory,
  maybeStartPendingSummaryRunForUrl: summaryRunRuntime.maybeStartPendingForUrl,
  maybeStartPendingSlidesForUrl,
  requestSlidesCapture: () => {
    void send({ type: "panel:slides-capture" });
  },
  resolveActiveSlidesRunId,
  applyPanelCache,
  resetSummaryView,
  abortSummaryStream: () => {
    streamController.abort();
  },
  hideAutomationNotice: chatRuntime.hideAutomationNotice,
  hideSlideNotice,
  maybeApplyPendingSlidesSummary,
  applyChatEnabled: chatRuntime.applyEnabled,
  restoreChatHistory: chatRuntime.restoreHistory,
  rebuildSlideDescriptions,
  renderInlineSlides,
  setSlidesLayout: (value) => {
    setSlidesLayout(value as SlidesLayout);
  },
  maybeSeedPlannedSlidesForPendingRun: plannedSlidesRuntime.maybeSeedPendingRun,
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
  isStreaming,
  onSlidesOcrChanged: updateSlidesTextState,
});

function updateControls(state: UiState) {
  uiStateRuntime.apply(state);
}

const bgMessageRuntime = createSidepanelBgMessageRuntime({
  panelState,
  dispatchPanelState: panelStateStore.dispatch,
  applyUiState: updateControls,
  setStatus: (text) => {
    headerController.setStatus(text);
  },
  isStreaming,
  setPhase,
  finishStreamingMessage: chatRuntime.finishStreamingMessage,
  setSlidesBusy,
  showSlideNotice,
  getActiveTabUrl,
  rememberPendingSlidesRun: (value) => {
    rememberPendingSlidesRun(value);
  },
  startSlidesStreamForRunId,
  startSlidesSummaryStreamForRunId: (runId, url) => {
    startSlidesSummaryStreamForRunId(runId, url ?? null);
  },
  handleSlidesLocal: handleLocalSlidesResponse,
  getSlidesContextRequestId: () => getSlidesState().slidesContextRequestId,
  setSlidesContextPending: (value) => {
    updateSlidesState({ slidesContextPending: value });
  },
  setSlidesTranscriptTimedText,
  updateSlidesTextState,
  updateSlideSummaryFromMarkdown,
  renderInlineSlidesFallback: () => {
    renderInlineSlides(renderMarkdownHostEl, { fallback: true });
  },
  schedulePanelCacheSync: () => {
    panelCacheController.scheduleSync();
  },
  consumeUiCache: (cacheMessage) => panelCacheController.consumeResponse(cacheMessage),
  clearPanelCache: () => {
    panelCacheController.clear();
  },
  getActiveTabId,
  applyPanelCache: (cache, opts) => {
    applyPanelCache(cache as PanelCachePayload, opts);
  },
  rememberPendingSummaryRun: (run) => {
    summaryRunRuntime.rememberPendingRun(run);
  },
  rememberPendingSummarySnapshot: (payload) => {
    summaryRunRuntime.rememberPendingSnapshot(payload);
  },
  attachSummaryRun: summaryRunRuntime.attachRun,
  applySummarySnapshot: (payload) => {
    summaryRunRuntime.applySnapshot(payload);
  },
  handleChatHistory: chatRuntime.handleHistory,
  handleAgentChunk: chatRuntime.handleAgentChunk,
  handleAgentResponse: chatRuntime.handleAgentResponse,
});

function handleBgMessage(msg: BgToPanel) {
  bgMessageRuntime.handle(msg);
}

const interactionRuntime = createSidepanelInteractionRuntime({
  chatEnabled: () => getPanelSession().chatEnabled,
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
  isChatStreaming: () => panelState.chat.streaming,
  getQueuedChatCount: chatRuntime.getQueueLength,
  enqueueChatMessage: chatRuntime.enqueueMessage,
  maybeSendQueuedChat: chatRuntime.maybeSendQueuedMessage,
  startChatMessage: chatRuntime.startMessage,
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
const { sendChatMessage, bumpFontSize, bumpLineHeight, persistCurrentModel } = interactionRuntime;

function retryLastAction() {
  if (getPanelSession().lastAction === "chat") {
    chatRuntime.retry();
    return;
  }
  sendSummarize({ refresh: true });
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
  ensurePanelPort: () => panelMessagingRuntime.ensure(),
  loadSettings,
  panelState,
  dispatchPanelState: panelStateStore.dispatch,
  typographyController,
  setSlidesLayoutInputValue: (value) => {
    slidesLayoutEl.value = value;
  },
  hideAutomationNotice: chatRuntime.hideAutomationNotice,
  appearanceControls,
  applyChatEnabled: chatRuntime.applyEnabled,
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
  scheduleAutoSummarize: autoSummarizeRuntime.schedule,
  sendPing: () => {
    void send({ type: "panel:ping" });
  },
  bindSidepanelLifecycle: {
    sendReady: () => {
      void send({ type: "panel:ready" });
    },
    sendClosed: () => {
      autoSummarizeRuntime.cancel();
      void send({ type: "panel:closed" });
    },
    scheduleAutoSummarize: autoSummarizeRuntime.schedule,
    syncWithActiveTab,
    clearInlineError: () => {
      errorController.clearInlineError();
    },
    sendSummarize,
  },
});
