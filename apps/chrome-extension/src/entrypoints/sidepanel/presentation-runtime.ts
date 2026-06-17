import MarkdownIt from "markdown-it";
import { isGeminiNanoModel } from "../../lib/model-routing";
import type { PanelToBg } from "../../lib/panel-contracts";
import { loadSettings, patchSettings } from "../../lib/settings";
import type { createAppearanceControls } from "./appearance-controls";
import { createBrowserAiSummaryRuntime } from "./browser-ai-summary-runtime";
import type { SidepanelDom } from "./dom";
import { createSidepanelFeedbackRuntime } from "./feedback-runtime";
import type { createMetricsController } from "./metrics-controller";
import { buildPanelCachePayload, createPanelCacheController } from "./panel-cache";
import type { PanelStateAction } from "./panel-state-store";
import { createPanelPhaseRuntime } from "./phase-runtime";
import {
  retainRenderedSlideSummary,
  selectRetainedSlideSummaryMarkdown,
} from "./retained-slide-summary";
import { panelUrlsMatch } from "./session-policy";
import { friendlyFetchError } from "./setup-runtime";
import { createSidepanelSlidesRuntime } from "./slides-runtime";
import { createSlidesTextController } from "./slides-text-controller";
import { createSlidesViewRuntime } from "./slides-view-runtime";
import { createSummarizeCommand } from "./summarize-command";
import { createSummarizeControlRuntime } from "./summarize-control-runtime";
import { createSummarizeControlView } from "./summarize-control-view";
import { createSummaryViewRuntime } from "./summary-view-runtime";
import { parseTimestampHref } from "./timestamp-links";
import type { PanelState } from "./types";

type AppearanceControls = Pick<ReturnType<typeof createAppearanceControls>, "getLengthValue">;

type MetricsController = ReturnType<typeof createMetricsController>;

type ResolveLocalSlides = NonNullable<
  Parameters<typeof createSidepanelSlidesRuntime>[0]["resolveLocalSlides"]
>;

function createMarkdownRenderer() {
  const markdown = new MarkdownIt({
    html: false,
    linkify: true,
    breaks: false,
  });
  const slideTagPattern = /^\[slide:(\d+)\]/i;

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

  return markdown;
}

export function createSidepanelPresentationRuntime({
  dom,
  panelState,
  dispatchPanelState,
  appearanceControls,
  metricsController,
  resolveLocalSlides,
  send,
}: {
  dom: SidepanelDom;
  panelState: PanelState;
  dispatchPanelState: (action: PanelStateAction) => void;
  appearanceControls: AppearanceControls;
  metricsController: MetricsController;
  resolveLocalSlides: ResolveLocalSlides;
  send: (message: PanelToBg) => Promise<void>;
}) {
  const markdown = createMarkdownRenderer();
  const slidesTextController = createSlidesTextController({
    panelState,
    dispatchPanelState,
    getSlides: () => panelState.slides?.slides ?? null,
    getLengthValue: appearanceControls.getLengthValue,
    getSlidesOcrEnabled: () => panelState.slidesSession.slidesOcrEnabled,
  });
  const setSlidesTranscriptTimedText = (value: string | null) => {
    slidesTextController.setTranscriptTimedText(value);
  };
  const isStreaming = () => panelState.phase === "connecting" || panelState.phase === "streaming";

  dom.renderEl.addEventListener("click", (event) => {
    const target = event.target as HTMLElement | null;
    const link = target?.closest("a.chatTimestamp") as HTMLAnchorElement | null;
    const href = link?.getAttribute("href") ?? "";
    if (!href.startsWith("timestamp:")) return;
    event.preventDefault();
    event.stopPropagation();
    const seconds = parseTimestampHref(href);
    if (seconds == null) return;
    void send({ type: "panel:seek", seconds });
  });

  const feedbackRuntime = createSidepanelFeedbackRuntime({
    panelState,
    headerEl: dom.headerEl,
    titleEl: dom.titleEl,
    subtitleEl: dom.subtitleEl,
    progressFillEl: dom.progressFillEl,
    panelErrorEl: dom.errorEl,
    panelErrorMessageEl: dom.errorMessageEl,
    panelErrorRetryBtn: dom.errorRetryBtn,
    panelErrorLogsBtn: dom.errorLogsBtn,
    inlineErrorEl: dom.inlineErrorEl,
    inlineErrorMessageEl: dom.inlineErrorMessageEl,
    inlineErrorRetryBtn: dom.inlineErrorRetryBtn,
    inlineErrorLogsBtn: dom.inlineErrorLogsBtn,
    inlineErrorCloseBtn: dom.inlineErrorCloseBtn,
    slideNoticeEl: dom.slideNoticeEl,
    slideNoticeMessageEl: dom.slideNoticeMessageEl,
    slideNoticeRetryBtn: dom.slideNoticeRetryBtn,
    sendOpenOptions: () => {
      void send({ type: "panel:openOptions" });
    },
  });
  const { errorController, headerController, hideSlideNotice, showSlideNotice } = feedbackRuntime;
  const browserAiRuntime = createBrowserAiSummaryRuntime({
    setStatus: headerController.setStatus,
  });

  const sendSummarize = createSummarizeCommand({
    send,
    setLastAction: (value) => {
      dispatchPanelState({ type: "panel-session-update", value: { lastAction: value } });
    },
    clearInlineError: errorController.clearInlineError,
    getInputModeOverride: () => panelState.slidesSession.inputModeOverride,
    prepareBrowserAi: () => {
      const settings = panelState.ui?.settings;
      if (!settings) return;
      const useBrowserAi =
        isGeminiNanoModel(settings.model) ||
        (settings.summaryRuntime === "direct" &&
          settings.model.trim().toLowerCase() === "auto" &&
          !settings.providerConfigured);
      if (!useBrowserAi) return;
      const length = appearanceControls.getLengthValue();
      browserAiRuntime.prepare(length === "short" || length === "medium" ? length : "long");
      browserAiRuntime.prepare("short", "slides");
      browserAiRuntime.preparePrompt("slides", { imageInput: true });
    },
  });

  const summarizeControlView = createSummarizeControlView({
    root: dom.summarizeControlRoot,
    panelState,
    slidesTextController,
  });
  const refreshSummarizeControl = summarizeControlView.refresh;

  const panelCacheController = createPanelCacheController({
    getSnapshot: () => buildPanelCachePayload(panelState),
    sendCache: (payload) => {
      void send({ type: "panel:cache", cache: payload });
    },
    sendRequest: (request) => {
      void send({ type: "panel:get-cache", ...request });
    },
  });

  const slidesViewRuntime = createSlidesViewRuntime({
    renderMarkdownHostEl: dom.renderMarkdownHostEl,
    renderSlidesHostEl: dom.renderSlidesHostEl,
    summaryCopyBtn: dom.summaryCopyBtn,
    chatMessagesEl: dom.chatMessagesEl,
    md: markdown,
    headerSetStatus: headerController.setStatus,
    headerSetProgressOverride: headerController.setProgressOverride,
    slidesTextController,
    panelCacheController,
    send,
    refreshSummarizeControl,
    hideSlideNotice,
    panelState,
    dispatchPanelState,
    getFallbackSummaryMarkdown: () => selectRetainedSlideSummaryMarkdown(panelState),
  });

  const renderMarkdown = (value: string) => {
    retainRenderedSlideSummary(panelState, dispatchPanelState, value);
    slidesViewRuntime.renderMarkdown(value);
  };
  let refreshBrowserAiSlides = () => {};
  const applySlidesPayload = (data: Parameters<typeof slidesViewRuntime.applySlidesPayload>[0]) => {
    slidesViewRuntime.applySlidesPayload(data, setSlidesTranscriptTimedText);
    refreshBrowserAiSlides();
  };
  const renderInlineSlidesFallback = () => {
    slidesViewRuntime.renderInlineSlides(dom.renderMarkdownHostEl, { fallback: true });
  };

  const slidesRuntime = createSidepanelSlidesRuntime({
    applySlidesPayload,
    browserAi: browserAiRuntime,
    clearSummarySource: slidesTextController.clearSummarySource,
    panelState,
    dispatchPanelState,
    friendlyFetchError,
    getLengthValue: appearanceControls.getLengthValue,
    getToken: async () => (await loadSettings()).token,
    resolveLocalSlides,
    getTranscriptTimedText: slidesTextController.getTranscriptTimedText,
    headerSetStatus: headerController.setStatus,
    hideSlideNotice,
    isStreaming,
    panelUrlsMatch,
    refreshSummarizeControl,
    renderInlineSlidesFallback,
    renderMarkdown,
    schedulePanelCacheSync: () => {
      panelCacheController.scheduleSync();
    },
    setSlidesBusy: slidesViewRuntime.setSlidesBusy,
    showSlideNotice,
    updateSlideSummaryFromMarkdown: slidesViewRuntime.updateSlideSummaryFromMarkdown,
  });
  refreshBrowserAiSlides = () => {
    void slidesRuntime.refreshBrowserAiSlides();
  };

  const summarizeControlRuntime = createSummarizeControlRuntime({
    renderMarkdownHostEl: dom.renderMarkdownHostEl,
    renderSlidesHostEl: dom.renderSlidesHostEl,
    slidesLayoutEl: dom.slidesLayoutEl,
    slidesTextController,
    panelState,
    dispatchPanelState,
    patchSettings,
    loadSettings,
    showSlideNotice,
    hideSlideNotice,
    setSlidesBusy: slidesViewRuntime.setSlidesBusy,
    stopSlidesStream: slidesRuntime.stopSlidesStream,
    maybeApplyPendingSlidesSummary: slidesRuntime.maybeApplyPendingSlidesSummary,
    maybeStartPendingSlidesForUrl: slidesRuntime.maybeStartPendingSlidesForUrl,
    sendSummarize,
    resolveActiveSlidesRunId: slidesRuntime.resolveActiveSlidesRunId,
    isActiveSlidesRunLocal: slidesRuntime.isActiveSlidesRunLocal,
    startSlidesStreamForRunId: slidesRuntime.startSlidesStreamForRunId,
    startSlidesSummaryStreamForRunId: (runId, url) => {
      slidesRuntime.startSlidesSummaryStreamForRunId(runId, url ?? null);
    },
    renderMarkdownDisplay: slidesViewRuntime.renderMarkdownDisplay,
    renderInlineSlidesFallback,
    queueSlidesRender: slidesViewRuntime.queueSlidesRender,
    applySlidesRendererLayout: slidesViewRuntime.slidesRenderer.applyLayout,
  });
  summarizeControlView.bindActions({
    onSlidesTextModeChange: (value) => {
      summarizeControlRuntime.handleSlidesTextModeChange(value);
      refreshSummarizeControl();
    },
    onChange: async (value) => {
      await summarizeControlRuntime.handleSummarizeControlChange(value);
      refreshSummarizeControl();
    },
    onSummarize: sendSummarize,
  });

  const phaseRuntime = createPanelPhaseRuntime({
    panelState,
    dispatchPanelState,
    errorController,
    headerController,
    setSlidesBusy: slidesViewRuntime.setSlidesBusy,
    rebuildSlideDescriptions: slidesViewRuntime.rebuildSlideDescriptions,
    queueSlidesRender: slidesViewRuntime.queueSlidesRender,
  });

  const summaryViewRuntime = createSummaryViewRuntime({
    panelState,
    dispatchPanelState,
    renderEl: dom.renderEl,
    renderSlidesHostEl: dom.renderSlidesHostEl,
    renderMarkdownHostEl: dom.renderMarkdownHostEl,
    summaryCopyBtn: dom.summaryCopyBtn,
    slidesRenderer: slidesViewRuntime.slidesRenderer,
    metricsController,
    headerController,
    slidesTextController,
    slidesHydrator: slidesRuntime.slidesHydrator,
    stopSlidesStream: slidesRuntime.stopSlidesStream,
    refreshSummarizeControl,
    setSlidesTranscriptTimedText,
    updateSlidesTextState: slidesViewRuntime.updateSlidesTextState,
    requestSlidesContext: slidesViewRuntime.requestSlidesContext,
    requestSlidesCapture: () => {
      void send({ type: "panel:slides-capture" });
    },
    refreshBrowserAiSlides: slidesRuntime.refreshBrowserAiSlides,
    updateSlideSummaryFromMarkdown: slidesViewRuntime.updateSlideSummaryFromMarkdown,
    renderMarkdown,
    renderMarkdownDisplay: slidesViewRuntime.renderMarkdownDisplay,
    queueSlidesRender: slidesViewRuntime.queueSlidesRender,
    setPhase: phaseRuntime.setPhase,
  });

  return {
    markdown,
    isStreaming,
    panelCacheController,
    feedback: {
      bindActions(retryLastAction: () => void) {
        feedbackRuntime.bindActions({
          retryLastAction,
          retrySlidesStream: summarizeControlRuntime.retrySlidesStream,
        });
      },
      errorController,
      headerController,
      hideSlideNotice,
      showSlideNotice,
    },
    phase: phaseRuntime,
    summary: {
      browserAiRuntime,
      renderMarkdown,
      sendSummarize,
      viewRuntime: summaryViewRuntime,
    },
    slides: {
      applySlidesPayload,
      controlRuntime: summarizeControlRuntime,
      refreshSummarizeControl,
      renderInlineSlides: slidesViewRuntime.renderInlineSlides,
      runtime: slidesRuntime,
      setSlidesTranscriptTimedText,
      textController: slidesTextController,
      updateSlideSummaryFromMarkdown: slidesViewRuntime.updateSlideSummaryFromMarkdown,
      viewRuntime: slidesViewRuntime,
    },
  };
}
