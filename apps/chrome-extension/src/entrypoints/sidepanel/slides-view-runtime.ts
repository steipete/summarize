import { shouldPreferUrlMode } from "@steipete/summarize-core/content/url";
import type MarkdownIt from "markdown-it";
import { logExtensionEvent } from "../../lib/extension-logs";
import type { SseSlidesData } from "../../lib/runtime-contracts";
import { patchPanelState } from "./panel-state-store";
import { createSlideImageLoader, normalizeSlideImageUrl } from "./slide-images";
import {
  normalizeSlidesPayload,
  resolveSlidesPayload,
  slidesPayloadChanged,
} from "./slides-payload";
import { createSlidesRenderer } from "./slides-renderer";
import { resolveSlidesInputMode } from "./slides-session-state";
import { formatSlideTimestamp } from "./slides-state";
import type { createSlidesTextController } from "./slides-text-controller";
import { renderSummaryMarkdownDisplay } from "./summary-renderer";
import type { PanelState, SlideSummarySource } from "./types";

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
  panelState,

  getFallbackSummaryMarkdown,
}: {
  renderMarkdownHostEl: HTMLElement;
  renderSlidesHostEl: HTMLElement;
  summaryCopyBtn: HTMLButtonElement;
  chatMessagesEl: HTMLElement;
  md: InstanceType<typeof MarkdownIt>;
  headerSetStatus: (text: string) => void;
  headerSetProgressOverride: (busy: boolean) => void;
  slidesTextController: Pick<
    ReturnType<typeof createSlidesTextController>,
    | "hasSummaryTitles"
    | "updateSummaryFromMarkdown"
    | "rebuildDescriptions"
    | "syncTextState"
    | "getDescriptions"
    | "getTitles"
    | "getDescriptionEntries"
    | "getTranscriptTimedText"
  >;
  panelCacheController: { scheduleSync: () => void };
  send: (
    message:
      | { type: "panel:seek"; seconds: number }
      | { type: "panel:slides-context"; requestId: string; url?: string },
  ) => Promise<void>;
  refreshSummarizeControl: () => void;
  hideSlideNotice: () => void;
  panelState: PanelState;

  getFallbackSummaryMarkdown?: () => string | null;
}) {
  const slideImageLoader = createSlideImageLoader();

  const updateSlidesSession = (value: Partial<PanelState["slidesSession"]>) => {
    patchPanelState(panelState, "slidesSession", value);
  };
  const resolveActiveSlidesRunId = () => {
    if (panelState.slidesRunId) return panelState.slidesRunId;
    if (panelState.slides && panelState.runId) return panelState.runId;
    return null;
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
    getState: () => ({
      slidesEnabled: panelState.slidesSession.slidesEnabled,
      inputMode: resolveSlidesInputMode(panelState.slidesSession),
      preferredLayout: panelState.slidesSession.slidesLayout,
      slidesExpanded: panelState.slidesSession.slidesExpanded,
      slides: panelState.slides,
      descriptions: slidesTextController.getDescriptions(),
      titles: slidesTextController.getTitles(),
    }),
    ensureDescriptions: rebuildSlideDescriptions,
    onSeek: seekToSlideTimestamp,
    setExpanded: (slidesExpanded) => updateSlidesSession({ slidesExpanded }),
    updateThumb: updateSlideThumb,
    updateMeta: updateSlideMeta,
  });

  const renderInlineSlides = (container: HTMLElement, opts?: { fallback?: boolean }) => {
    slidesRenderer.renderInline(container, opts);
  };

  const renderMarkdownDisplay = () => {
    renderSummaryMarkdownDisplay({
      activeTabUrl: panelState.navigation.activeTabUrl,
      autoSummarize: panelState.panelSession.autoSummarize,
      currentSourceTitle: panelState.currentSource?.title ?? null,
      currentSourceUrl: panelState.currentSource?.url ?? null,
      hasSlides: Boolean(panelState.slides?.slides.length),
      headerSetStatus,
      hostEl: renderMarkdownHostEl,
      copyButtonEl: summaryCopyBtn,
      inputMode: resolveSlidesInputMode(panelState.slidesSession),
      markdown: panelState.summaryMarkdown ?? "",
      md,
      phase: panelState.phase,
      renderInlineSlides,
      slidesEnabled: panelState.slidesSession.slidesEnabled,
      slidesLayout: panelState.slidesSession.slidesLayout,
      tabTitle: panelState.ui?.tab.title ?? null,
      tabUrl: panelState.ui?.tab.url ?? null,
    });
  };

  const renderEmptySummaryState = () => {
    renderSummaryMarkdownDisplay({
      activeTabUrl: panelState.navigation.activeTabUrl,
      autoSummarize: panelState.panelSession.autoSummarize,
      currentSourceTitle: panelState.currentSource?.title ?? null,
      currentSourceUrl: panelState.currentSource?.url ?? null,
      hasSlides: Boolean(panelState.slides?.slides.length),
      headerSetStatus,
      hostEl: renderMarkdownHostEl,
      copyButtonEl: summaryCopyBtn,
      inputMode: resolveSlidesInputMode(panelState.slidesSession),
      markdown: "",
      md,
      phase: panelState.phase,
      renderInlineSlides,
      slidesEnabled: panelState.slidesSession.slidesEnabled,
      slidesLayout: panelState.slidesSession.slidesLayout,
      tabTitle: panelState.ui?.tab.title ?? null,
      tabUrl: panelState.ui?.tab.url ?? null,
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
    panelState.summaryMarkdown = markdown;
    updateSlideSummaryFromMarkdown(markdown, {
      preserveIfEmpty: slidesTextController.hasSummaryTitles(),
      source: "summary",
    });
    renderMarkdownDisplay();
    panelCacheController.scheduleSync();
  };

  const setSlidesBusy = (next: boolean) => {
    if (panelState.slidesSession.slidesBusy === next) return;
    updateSlidesSession({ slidesBusy: next });
    const toggle = document.querySelector<HTMLButtonElement>(".summarizeSlideToggle");
    if (toggle) {
      toggle.dataset.busy = next ? "true" : "false";
    }
    headerSetProgressOverride(next);
    refreshSummarizeControl();
  };

  const requestSlidesContext = async () => {
    if (!panelState.slides || panelState.slidesSession.slidesContextPending) return;
    const sourceUrl = panelState.slides.sourceUrl || panelState.currentSource?.url || null;
    if (sourceUrl && panelState.slidesSession.slidesContextUrl === sourceUrl) return;
    patchPanelState(panelState, "slidesSession", {
      slidesContextRequestId: panelState.slidesSession.slidesContextRequestId + 1,
    });
    const requestId = `slides-${panelState.slidesSession.slidesContextRequestId}`;
    updateSlidesSession({
      slidesContextPending: true,
      slidesContextUrl: sourceUrl,
    });
    void send({ type: "panel:slides-context", requestId, url: sourceUrl ?? undefined });
  };

  const applySlidesPayload = (
    data: SseSlidesData,
    setSlidesTranscriptTimedText: (value: string | null) => void,
  ) => {
    const safePayload = normalizeSlidesPayload(data);
    if (!safePayload) return;
    const isSameSource = Boolean(
      panelState.slides && panelState.slides.sourceId === safePayload.sourceId,
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
    const shouldReplaceSeeded =
      panelState.slidesSession.slidesSeededSourceId === safePayload.sourceId;
    const merged = resolveSlidesPayload(panelState.slides, normalized, {
      seededSourceId: panelState.slidesSession.slidesSeededSourceId,
      activeSlidesRunId,
      appliedSlidesRunId: panelState.slidesSession.slidesAppliedRunId,
    });
    if (shouldReplaceSeeded) {
      updateSlidesSession({ slidesSeededSourceId: null });
    }
    if (!slidesPayloadChanged(panelState.slides, merged)) {
      if (activeSlidesRunId) {
        updateSlidesSession({ slidesAppliedRunId: activeSlidesRunId });
      }
      return;
    }
    panelState.slides = merged;
    if (activeSlidesRunId) {
      updateSlidesSession({ slidesAppliedRunId: activeSlidesRunId });
    }
    if (!isSameSource) {
      updateSlidesSession({
        slidesContextPending: false,
        slidesContextUrl: null,
      });
      setSlidesTranscriptTimedText(null);
    }
    if (!normalized.transcriptTimedText) {
      const sourceUrl = normalized.sourceUrl || panelState.currentSource?.url || "";
      if (sourceUrl && !shouldPreferUrlMode(sourceUrl)) {
        void requestSlidesContext();
      }
    }
    if (normalized.transcriptTimedText) {
      setSlidesTranscriptTimedText(normalized.transcriptTimedText);
      updateSlidesSession({
        slidesContextUrl: normalized.sourceUrl || panelState.currentSource?.url || null,
        slidesContextPending: false,
      });
    }
    updateSlidesTextState();
    const summaryMarkdown = panelState.summaryMarkdown || getFallbackSummaryMarkdown?.();
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
