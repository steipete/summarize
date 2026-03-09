import { buildIdleSubtitle } from "../../lib/header";
import type { PanelCachePayload } from "./panel-cache";
import { normalizeSlideImageUrl } from "./slide-images";
import type { PanelPhase, PanelState } from "./types";

type SlidesTextControllerLike = {
  reset: () => void;
  getTranscriptTimedText: () => string | null;
  getTranscriptAvailable: () => boolean;
};

type SlidesHydratorLike = {
  syncFromCache: (payload: {
    runId: string | null;
    summaryFromCache: boolean | null;
    hasSlides: boolean;
  }) => void;
};

type MetricsControllerLike = {
  clearForMode: (mode: "summary" | "chat") => void;
};

type HeaderControllerLike = {
  setBaseTitle: (value: string) => void;
  setBaseSubtitle: (value: string) => void;
};

type SummaryViewRuntimeOpts = {
  panelState: PanelState;
  renderEl: HTMLElement;
  renderSlidesHostEl: HTMLElement;
  renderMarkdownHostEl: HTMLElement;
  getSlidesRenderer: () => { clear: () => void };
  metricsController: MetricsControllerLike;
  headerController: HeaderControllerLike;
  slidesTextController: SlidesTextControllerLike;
  getSlidesHydrator: () => SlidesHydratorLike;
  stopSlidesStream: () => void;
  refreshSummarizeControl: () => void;
  resetChatState: () => void;
  setSlidesTranscriptTimedText: (value: string | null) => void;
  getSlidesParallelValue: () => boolean;
  getCurrentRunTabId: () => number | null;
  getActiveTabId: () => number | null;
  getActiveTabUrl: () => string | null;
  setCurrentRunTabId: (value: number | null) => void;
  setSlidesContextPending: (value: boolean) => void;
  setSlidesContextUrl: (value: string | null) => void;
  setSlidesSeededSourceId: (value: string | null) => void;
  setSlidesAppliedRunId: (value: string | null) => void;
  setSlidesExpanded: (value: boolean) => void;
  resolveActiveSlidesRunId: () => string | null;
  getSlidesSummaryState: () => {
    runId: string | null;
    markdown: string;
    complete: boolean;
    model: string | null;
  };
  setSlidesSummaryState: (payload: {
    markdown: string;
    complete: boolean;
    model: string | null;
  }) => void;
  clearSlidesSummaryPending: () => void;
  clearSlidesSummaryError: () => void;
  updateSlidesTextState: () => void;
  requestSlidesContext: () => void | Promise<void>;
  updateSlideSummaryFromMarkdown: (
    markdown: string,
    opts?: { preserveIfEmpty?: boolean; source?: "summary" | "slides" },
  ) => void;
  renderMarkdown: (markdown: string) => void;
  renderMarkdownDisplay: () => void;
  queueSlidesRender: () => void;
  setPhase: (phase: PanelPhase, opts?: { error?: string | null }) => void;
};

export function createSummaryViewRuntime(opts: SummaryViewRuntimeOpts) {
  function resetSummaryView({
    preserveChat = false,
    clearRunId = true,
    stopSlides = true,
  }: {
    preserveChat?: boolean;
    clearRunId?: boolean;
    stopSlides?: boolean;
  } = {}) {
    opts.setCurrentRunTabId(null);
    opts.renderEl.replaceChildren(opts.renderSlidesHostEl, opts.renderMarkdownHostEl);
    opts.renderMarkdownHostEl.innerHTML = "";
    opts.getSlidesRenderer().clear();
    opts.metricsController.clearForMode("summary");
    opts.panelState.summaryMarkdown = null;
    opts.panelState.summaryFromCache = null;
    opts.panelState.slides = null;
    if (clearRunId) {
      opts.panelState.runId = null;
      opts.panelState.slidesRunId = null;
    }
    opts.setSlidesExpanded(true);
    opts.setSlidesContextPending(false);
    opts.setSlidesContextUrl(null);
    opts.setSlidesTranscriptTimedText(null);
    opts.slidesTextController.reset();
    opts.setSlidesSeededSourceId(null);
    opts.setSlidesAppliedRunId(null);
    if (stopSlides) {
      opts.stopSlidesStream();
    }
    opts.refreshSummarizeControl();
    if (!preserveChat) {
      opts.resetChatState();
    }
  }

  function buildPanelCachePayload(): PanelCachePayload | null {
    const tabId = opts.getCurrentRunTabId() ?? opts.getActiveTabId();
    const url = opts.panelState.currentSource?.url ?? opts.getActiveTabUrl();
    if (!tabId || !url) return null;
    const slidesSummary = opts.getSlidesSummaryState();
    const hasSlidesSummaryState = Boolean(slidesSummary.runId || slidesSummary.markdown.trim());
    return {
      tabId,
      url,
      title: opts.panelState.currentSource?.title ?? null,
      runId: opts.panelState.runId ?? null,
      slidesRunId: opts.panelState.slidesRunId ?? null,
      summaryMarkdown: opts.panelState.summaryMarkdown ?? null,
      summaryFromCache: opts.panelState.summaryFromCache ?? null,
      slidesSummaryMarkdown: slidesSummary.markdown || null,
      slidesSummaryComplete: hasSlidesSummaryState ? slidesSummary.complete : null,
      slidesSummaryModel: hasSlidesSummaryState ? slidesSummary.model : null,
      lastMeta: opts.panelState.lastMeta,
      slides: opts.panelState.slides ?? null,
      transcriptTimedText: opts.slidesTextController.getTranscriptTimedText() ?? null,
    };
  }

  function applyPanelCache(payload: PanelCachePayload, applyOpts?: { preserveChat?: boolean }) {
    const preserveChat = applyOpts?.preserveChat ?? false;
    resetSummaryView({ preserveChat });
    opts.panelState.runId = payload.runId ?? null;
    opts.panelState.slidesRunId =
      payload.slidesRunId ?? (opts.getSlidesParallelValue() ? null : (payload.runId ?? null));
    opts.setCurrentRunTabId(payload.tabId);
    opts.panelState.currentSource = { url: payload.url, title: payload.title ?? null };
    opts.panelState.lastMeta = payload.lastMeta ?? {
      inputSummary: null,
      model: null,
      modelLabel: null,
    };
    opts.panelState.summaryFromCache = payload.summaryFromCache ?? null;
    opts.setSlidesSummaryState({
      markdown: payload.slidesSummaryMarkdown ?? "",
      complete:
        payload.slidesSummaryComplete ?? Boolean((payload.slidesSummaryMarkdown ?? "").trim()),
      model:
        payload.slidesSummaryModel ??
        opts.panelState.lastMeta.model ??
        opts.panelState.ui?.settings.model ??
        null,
    });
    opts.clearSlidesSummaryPending();
    opts.clearSlidesSummaryError();
    opts.headerController.setBaseTitle(payload.title || payload.url || "Summarize");
    opts.headerController.setBaseSubtitle(
      buildIdleSubtitle({
        inputSummary: opts.panelState.lastMeta.inputSummary,
        modelLabel: opts.panelState.lastMeta.modelLabel,
        model: opts.panelState.lastMeta.model,
      }),
    );
    opts.setSlidesTranscriptTimedText(payload.transcriptTimedText ?? null);
    if (payload.slides) {
      opts.panelState.slides = {
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
      opts.setSlidesContextPending(false);
      opts.setSlidesContextUrl(payload.url);
      opts.updateSlidesTextState();
      if (!opts.slidesTextController.getTranscriptAvailable()) {
        void opts.requestSlidesContext();
      }
      opts.setSlidesAppliedRunId(opts.resolveActiveSlidesRunId());
    } else {
      opts.panelState.slides = null;
      opts.setSlidesContextPending(false);
      opts.setSlidesContextUrl(null);
      opts.updateSlidesTextState();
      opts.setSlidesAppliedRunId(null);
    }
    opts.getSlidesHydrator().syncFromCache({
      runId: opts.panelState.slidesRunId ?? null,
      summaryFromCache: payload.summaryFromCache,
      hasSlides: Boolean(payload.slides && payload.slides.slides.length > 0),
    });
    if ((payload.slidesSummaryMarkdown ?? "").trim()) {
      opts.updateSlideSummaryFromMarkdown(payload.slidesSummaryMarkdown ?? "", {
        preserveIfEmpty: false,
        source: "slides",
      });
    }
    if (payload.summaryMarkdown) {
      opts.renderMarkdown(payload.summaryMarkdown);
    } else {
      opts.renderMarkdownDisplay();
    }
    opts.queueSlidesRender();
    opts.setPhase("idle");
  }

  return {
    applyPanelCache,
    buildPanelCachePayload,
    resetSummaryView,
  };
}
