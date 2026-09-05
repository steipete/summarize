import { isYouTubeVideoUrl, shouldPreferUrlMode } from "@steipete/summarize-core/content/url";
import { buildIdleSubtitle } from "../../lib/header";
import type { PanelCachePayload } from "./panel-cache";
import { patchPanelState, resetPanelSummary, restorePanelSession } from "./panel-state-store";
import { normalizeSlideImageUrl } from "./slide-images";
import { normalizeSlidesPayload } from "./slides-payload";
import { clearSummaryCopyButton } from "./summary-renderer";
import type { PanelPhase, PanelState } from "./types";

type SlidesTextControllerLike = {
  reset: () => void;
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
  summaryCopyBtn: HTMLButtonElement;
  slidesRenderer: { clear: () => void };
  metricsController: MetricsControllerLike;
  headerController: HeaderControllerLike;
  slidesTextController: SlidesTextControllerLike;
  slidesHydrator: SlidesHydratorLike;
  stopSlidesStream: () => void;
  refreshSummarizeControl: () => void;
  setSlidesTranscriptTimedText: (value: string | null) => void;
  updateSlidesTextState: () => void;
  requestSlidesContext: () => void | Promise<void>;
  requestSlidesCapture: () => void;
  refreshBrowserAiSlides: () => void | Promise<void>;
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
  const resolveActiveSlidesRunId = () => {
    if (opts.panelState.slidesRunId) return opts.panelState.slidesRunId;
    if (opts.panelState.slides && opts.panelState.runId) return opts.panelState.runId;
    return null;
  };

  function resetSummaryView({
    clearRunId = true,
    stopSlides = true,
  }: {
    clearRunId?: boolean;
    stopSlides?: boolean;
  } = {}) {
    opts.renderEl.replaceChildren(opts.renderSlidesHostEl, opts.renderMarkdownHostEl);
    opts.renderMarkdownHostEl.innerHTML = "";
    clearSummaryCopyButton(opts.summaryCopyBtn);
    opts.metricsController.clearForMode("summary");
    resetPanelSummary(opts.panelState, { clearRunId, clearSlides: stopSlides });
    patchPanelState(opts.panelState, "slidesSession", {
      slidesExpanded: true,
      ...(stopSlides
        ? {
            slidesContextPending: false,
            slidesContextUrl: null,
            slidesSeededSourceId: null,
            slidesAppliedRunId: null,
          }
        : {}),
    });
    if (stopSlides) {
      opts.slidesRenderer.clear();
      opts.setSlidesTranscriptTimedText(null);
      opts.slidesTextController.reset();
      opts.stopSlidesStream();
    }
    opts.refreshSummarizeControl();
  }

  function applyPanelCache(payload: PanelCachePayload) {
    resetSummaryView();
    const slidesRunId =
      payload.slidesRunId ??
      (opts.panelState.slidesSession.slidesParallel ? null : (payload.runId ?? null));
    restorePanelSession(opts.panelState, {
      tabId: payload.tabId,
      runId: payload.runId ?? null,
      slidesRunId,
      source: { url: payload.url, title: payload.title ?? null },
      meta: payload.lastMeta ?? {
        inputSummary: null,
        model: null,
        modelLabel: null,
      },
      summaryFromCache: payload.summaryFromCache ?? null,
    });
    patchPanelState(opts.panelState, "slidesSummary", {
      markdown: payload.slidesSummaryMarkdown ?? "",
      complete:
        payload.slidesSummaryComplete ?? Boolean((payload.slidesSummaryMarkdown ?? "").trim()),
      model:
        payload.slidesSummaryModel ??
        opts.panelState.lastMeta.model ??
        opts.panelState.ui?.settings.model ??
        null,
      pending: null,
      hadError: false,
    });
    opts.headerController.setBaseTitle(payload.title || payload.url || "Summarize");
    opts.headerController.setBaseSubtitle(
      buildIdleSubtitle({
        inputSummary: opts.panelState.lastMeta.inputSummary,
        modelLabel: opts.panelState.lastMeta.modelLabel,
        model: opts.panelState.lastMeta.model,
      }),
    );
    opts.setSlidesTranscriptTimedText(payload.transcriptTimedText ?? null);
    const normalizedSlides = normalizeSlidesPayload(payload.slides);
    const hasNormalizedSlides = Boolean(normalizedSlides && normalizedSlides.slides.length > 0);
    if (normalizedSlides && hasNormalizedSlides) {
      opts.panelState.slides = {
        ...normalizedSlides,
        slides: normalizedSlides.slides.map((slide) => ({
          ...slide,
          imageUrl: normalizeSlideImageUrl(slide.imageUrl, normalizedSlides.sourceId, slide.index),
        })),
      };
      patchPanelState(opts.panelState, "slidesSession", {
        slidesContextPending: false,
        slidesContextUrl: opts.slidesTextController.getTranscriptAvailable() ? payload.url : null,
      });
      opts.updateSlidesTextState();
      if (
        !opts.slidesTextController.getTranscriptAvailable() &&
        payload.url &&
        !shouldPreferUrlMode(payload.url)
      ) {
        void opts.requestSlidesContext();
      }
      patchPanelState(opts.panelState, "slidesSession", {
        slidesAppliedRunId: resolveActiveSlidesRunId(),
      });
    } else {
      opts.panelState.slides = null;
      patchPanelState(opts.panelState, "slidesSession", {
        slidesContextPending: false,
        slidesContextUrl: null,
        slidesAppliedRunId: null,
      });
      opts.updateSlidesTextState();
      if (payload.summaryMarkdown && payload.url && isYouTubeVideoUrl(payload.url)) {
        opts.requestSlidesCapture();
      }
    }
    opts.slidesHydrator.syncFromCache({
      runId: opts.panelState.slidesRunId ?? null,
      summaryFromCache: payload.summaryFromCache,
      hasSlides: hasNormalizedSlides,
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
    if (hasNormalizedSlides) {
      void opts.refreshBrowserAiSlides();
    }
  }

  return {
    applyPanelCache,
    resetSummaryView,
  };
}
