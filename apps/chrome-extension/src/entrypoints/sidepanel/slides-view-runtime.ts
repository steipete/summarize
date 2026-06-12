import { shouldPreferUrlMode } from "@steipete/summarize-core/content/url";
import type MarkdownIt from "markdown-it";
import { logExtensionEvent } from "../../lib/extension-logs";
import type { SseSlidesData } from "../../lib/runtime-contracts";
import type { SlidesLayout } from "../../lib/settings";
import { applyPanelStateAction, type PanelStateAction } from "./panel-state-store";
import { createSlideImageLoader, normalizeSlideImageUrl } from "./slide-images";
import {
  normalizeSlidesPayload,
  resolveSlidesPayload,
  slidesPayloadChanged,
} from "./slides-payload";
import { createSlidesRenderer } from "./slides-renderer";
import { formatSlideTimestamp } from "./slides-state";
import type { SlideSummarySource } from "./slides-text-controller";
import { renderSummaryMarkdownDisplay } from "./summary-renderer";
import type { PanelPhase, PanelState, UiState } from "./types";

export function createSlidesViewRuntime({
  renderMarkdownHostEl,
  renderSlidesHostEl,
  summaryCopyBtn,
  chatMessagesEl,
  md,
  headerSetStatus,
  headerSetProgressOverride,
  slidesTextController,
  panelCacheController,
  send,
  refreshSummarizeControl,
  hideSlideNotice,
  getState,
  dispatchPanelState,
  setSlidesBusyValue,
  getSlidesBusy,
  setSlidesContextPending,
  getSlidesContextPending,
  setSlidesContextUrl,
  getSlidesContextUrl,
  setSlidesSeededSourceId,
  getSlidesSeededSourceId,
  setSlidesAppliedRunId,
  getSlidesAppliedRunId,
  resolveActiveSlidesRunId,
  nextSlidesContextRequestId,
  setSlidesExpanded,
  getFallbackSummaryMarkdown,
}: {
  renderMarkdownHostEl: HTMLElement;
  renderSlidesHostEl: HTMLElement;
  summaryCopyBtn: HTMLButtonElement;
  chatMessagesEl: HTMLElement;
  md: MarkdownIt;
  headerSetStatus: (text: string) => void;
  headerSetProgressOverride: (busy: boolean) => void;
  slidesTextController: {
    hasSummaryTitles: () => boolean;
    updateSummaryFromMarkdown: (
      markdown: string,
      opts?: { preserveIfEmpty?: boolean; source?: "summary" | "slides" },
    ) => boolean;
    rebuildDescriptions: () => void;
    syncTextState: () => void;
    getDescriptions: () => Map<number, string>;
    getTitles: () => Map<number, string>;
    getDescriptionEntries: () => Array<[number, string]>;
    getTranscriptTimedText: () => string | null;
  };
  panelCacheController: { scheduleSync: () => void };
  send: (
    message:
      | { type: "panel:seek"; seconds: number }
      | { type: "panel:slides-context"; requestId: string; url?: string },
  ) => Promise<void>;
  refreshSummarizeControl: () => void;
  hideSlideNotice: () => void;
  getState: () => {
    activeTabUrl: string | null;
    autoSummarize: boolean;
    currentSourceTitle: string | null;
    currentSourceUrl: string | null;
    inputMode: "page" | "video";
    panelState: PanelState;
    slidesEnabled: boolean;
    slidesLayout: SlidesLayout;
    slidesExpanded: boolean;
    mediaAvailable: boolean;
  };
  dispatchPanelState?: (action: PanelStateAction) => void;
  setSlidesBusyValue: (value: boolean) => void;
  getSlidesBusy: () => boolean;
  setSlidesContextPending: (value: boolean) => void;
  getSlidesContextPending: () => boolean;
  setSlidesContextUrl: (value: string | null) => void;
  getSlidesContextUrl: () => string | null;
  setSlidesSeededSourceId: (value: string | null) => void;
  getSlidesSeededSourceId: () => string | null;
  setSlidesAppliedRunId: (value: string | null) => void;
  getSlidesAppliedRunId: () => string | null;
  resolveActiveSlidesRunId: () => string | null;
  nextSlidesContextRequestId: () => number;
  setSlidesExpanded: (value: boolean) => void;
  getFallbackSummaryMarkdown?: () => string | null;
}) {
  const slideImageLoader = createSlideImageLoader();
  const dispatch = (action: PanelStateAction) => {
    if (dispatchPanelState) {
      dispatchPanelState(action);
    } else {
      applyPanelStateAction(getState().panelState, action);
    }
  };

  const seekToSlideTimestamp = (seconds: number | null | undefined) => {
    if (seconds == null || !Number.isFinite(seconds)) return;
    void send({ type: "panel:seek", seconds: Math.floor(seconds) });
  };

  const rebuildSlideDescriptions = () => {
    slidesTextController.rebuildDescriptions();
  };

  const queueSlidesRender = () => {
    slidesRenderer.queueRender();
  };

  const updateSlidesTextState = () => {
    slidesTextController.syncTextState();
    refreshSummarizeControl();
    queueSlidesRender();
  };

  const updateSlideThumb = (
    img: HTMLImageElement,
    thumb: HTMLElement,
    imageUrl: string | null | undefined,
  ) => {
    if (imageUrl) {
      thumb.classList.add("isPlaceholder");
      slideImageLoader.observe(img, imageUrl);
      return;
    }
    thumb.classList.add("isPlaceholder");
    img.removeAttribute("src");
    img.dataset.loaded = "false";
    img.dataset.slideImageUrl = "";
  };

  const updateSlideMeta = (
    el: HTMLElement,
    index: number,
    timestamp: number | null | undefined,
    title?: string | null,
    total?: number | null,
  ) => {
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
  };

  const slidesRenderer = createSlidesRenderer({
    hostEl: renderSlidesHostEl,
    markdownHostEl: renderMarkdownHostEl,
    getState: () => {
      const state = getState();
      return {
        slidesEnabled: state.slidesEnabled,
        inputMode: state.inputMode,
        preferredLayout: state.slidesLayout,
        slidesExpanded: state.slidesExpanded,
        slides: state.panelState.slides,
        descriptions: slidesTextController.getDescriptions(),
        titles: slidesTextController.getTitles(),
      };
    },
    ensureDescriptions: rebuildSlideDescriptions,
    onSeek: seekToSlideTimestamp,
    setExpanded: setSlidesExpanded,
    updateThumb: updateSlideThumb,
    updateMeta: updateSlideMeta,
  });

  const renderInlineSlides = (container: HTMLElement, opts?: { fallback?: boolean }) => {
    slidesRenderer.renderInline(container, opts);
  };

  const renderMarkdownDisplay = () => {
    const state = getState();
    renderSummaryMarkdownDisplay({
      activeTabUrl: state.activeTabUrl,
      autoSummarize: state.autoSummarize,
      currentSourceTitle: state.currentSourceTitle,
      currentSourceUrl: state.currentSourceUrl,
      hasSlides: Boolean(state.panelState.slides?.slides.length),
      headerSetStatus,
      hostEl: renderMarkdownHostEl,
      copyButtonEl: summaryCopyBtn,
      inputMode: state.inputMode,
      markdown: state.panelState.summaryMarkdown ?? "",
      md,
      phase: state.panelState.phase,
      renderInlineSlides,
      slidesEnabled: state.slidesEnabled,
      slidesLayout: state.slidesLayout,
      tabTitle: state.panelState.ui?.tab.title ?? null,
      tabUrl: state.panelState.ui?.tab.url ?? null,
    });
  };

  const renderEmptySummaryState = () => {
    const state = getState();
    renderSummaryMarkdownDisplay({
      activeTabUrl: state.activeTabUrl,
      autoSummarize: state.autoSummarize,
      currentSourceTitle: state.currentSourceTitle,
      currentSourceUrl: state.currentSourceUrl,
      hasSlides: Boolean(state.panelState.slides?.slides.length),
      headerSetStatus,
      hostEl: renderMarkdownHostEl,
      copyButtonEl: summaryCopyBtn,
      inputMode: state.inputMode,
      markdown: "",
      md,
      phase: state.panelState.phase,
      renderInlineSlides,
      slidesEnabled: state.slidesEnabled,
      slidesLayout: state.slidesLayout,
      tabTitle: state.panelState.ui?.tab.title ?? null,
      tabUrl: state.panelState.ui?.tab.url ?? null,
    });
  };

  const updateSlideSummaryFromMarkdown = (
    markdown: string,
    opts?: { preserveIfEmpty?: boolean; source?: Exclude<SlideSummarySource, null> },
  ) => {
    const changed = slidesTextController.updateSummaryFromMarkdown(markdown, opts);
    if (!changed) return;
    queueSlidesRender();
  };

  const renderMarkdown = (markdown: string) => {
    const state = getState();
    dispatch({ type: "summary", markdown });
    updateSlideSummaryFromMarkdown(markdown, {
      preserveIfEmpty: slidesTextController.hasSummaryTitles(),
      source: "summary",
    });
    renderMarkdownDisplay();
    panelCacheController.scheduleSync();
  };

  const setSlidesBusy = (next: boolean) => {
    if (getSlidesBusy() === next) return;
    setSlidesBusyValue(next);
    const toggle = document.querySelector<HTMLButtonElement>(".summarizeSlideToggle");
    if (toggle) {
      toggle.dataset.busy = next ? "true" : "false";
    }
    headerSetProgressOverride(next);
    refreshSummarizeControl();
  };

  const requestSlidesContext = async () => {
    const state = getState();
    if (!state.panelState.slides || getSlidesContextPending()) return;
    const sourceUrl = state.panelState.slides.sourceUrl || state.currentSourceUrl || null;
    if (sourceUrl && getSlidesContextUrl() === sourceUrl) return;
    setSlidesContextPending(true);
    const requestId = `slides-${nextSlidesContextRequestId()}`;
    setSlidesContextUrl(sourceUrl);
    void send({ type: "panel:slides-context", requestId, url: sourceUrl ?? undefined });
  };

  const applySlidesPayload = (
    data: SseSlidesData,
    setSlidesTranscriptTimedText: (value: string | null) => void,
  ) => {
    const state = getState();
    const safePayload = normalizeSlidesPayload(data);
    if (!safePayload) return;
    const isSameSource = Boolean(
      state.panelState.slides && state.panelState.slides.sourceId === safePayload.sourceId,
    );
    const activeSlidesRunId = resolveActiveSlidesRunId();
    const normalized: SseSlidesData = {
      ...safePayload,
      slides: safePayload.slides.map((slide) => ({
        ...slide,
        imageUrl: normalizeSlideImageUrl(slide.imageUrl, safePayload.sourceId, slide.index),
      })),
    };
    if (globalThis.chrome?.storage) {
      logExtensionEvent({
        event: "slides:payload:applied",
        scope: "slides:panel",
        level: "verbose",
        detail: {
          slides: normalized.slides.length,
          sourceKind: normalized.sourceKind,
          slideRuntime: normalized.slideRuntime ?? "daemon",
          transcriptAvailable: Boolean(normalized.transcriptTimedText?.trim()),
          ocrAvailable: normalized.ocrAvailable,
        },
      });
    }
    const shouldReplaceSeeded = getSlidesSeededSourceId() === safePayload.sourceId;
    const merged = resolveSlidesPayload(state.panelState.slides, normalized, {
      seededSourceId: getSlidesSeededSourceId(),
      activeSlidesRunId,
      appliedSlidesRunId: getSlidesAppliedRunId(),
    });
    if (shouldReplaceSeeded) {
      setSlidesSeededSourceId(null);
    }
    if (!slidesPayloadChanged(state.panelState.slides, merged)) {
      if (activeSlidesRunId) {
        setSlidesAppliedRunId(activeSlidesRunId);
      }
      return;
    }
    dispatch({ type: "slides", slides: merged });
    if (activeSlidesRunId) {
      setSlidesAppliedRunId(activeSlidesRunId);
    }
    if (!isSameSource) {
      setSlidesContextPending(false);
      setSlidesContextUrl(null);
      setSlidesTranscriptTimedText(null);
    }
    if (!normalized.transcriptTimedText) {
      const sourceUrl = normalized.sourceUrl || state.currentSourceUrl || "";
      if (sourceUrl && !shouldPreferUrlMode(sourceUrl)) {
        void requestSlidesContext();
      }
    }
    if (normalized.transcriptTimedText) {
      setSlidesTranscriptTimedText(normalized.transcriptTimedText);
      setSlidesContextUrl(normalized.sourceUrl || state.currentSourceUrl || null);
      setSlidesContextPending(false);
    }
    updateSlidesTextState();
    const summaryMarkdown = state.panelState.summaryMarkdown || getFallbackSummaryMarkdown?.();
    if (summaryMarkdown) {
      updateSlideSummaryFromMarkdown(summaryMarkdown, {
        preserveIfEmpty: true,
        source: "summary",
      });
      renderInlineSlides(renderMarkdownHostEl, { fallback: true });
    }
    hideSlideNotice();
    renderInlineSlides(chatMessagesEl);
    queueSlidesRender();
    panelCacheController.scheduleSync();
  };

  return {
    slidesRenderer,
    renderEmptySummaryState,
    renderMarkdownDisplay,
    renderMarkdown,
    updateSlideSummaryFromMarkdown,
    setSlidesBusy,
    applySlidesPayload,
    requestSlidesContext,
    queueSlidesRender,
    renderInlineSlides,
    rebuildSlideDescriptions,
    updateSlidesTextState,
  };
}
