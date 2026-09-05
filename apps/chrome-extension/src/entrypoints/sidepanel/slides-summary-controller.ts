import { buildSlidePresentation } from "../../lib/slides-presentation";
import { createInitialSlidesSummaryState, patchPanelState } from "./panel-state-store";
import { resolveSlidesLengthArg } from "./slides-state";
import { createStreamController } from "./stream-controller";
import type { PanelState, RunStart, SlideSummarySource, UiState } from "./types";

type SlidesSummarySnapshot = {
  runId: string | null;
  markdown: string;
  complete: boolean;
  model: string | null;
};

type SlidesSummaryControllerOptions = {
  getToken: () => Promise<string>;

  friendlyFetchError: (error: unknown, fallback: string) => string;
  panelUrlsMatch: (left: string | null | undefined, right: string | null | undefined) => boolean;
  getPanelState: () => PanelState;
  getUiState: () => UiState | null;
  getActiveTabUrl: () => string | null;
  getInputMode: () => "page" | "video";
  getInputModeOverride: () => "page" | "video" | null;
  getSlidesEnabled: () => boolean;
  getLengthValue: () => string;
  getTranscriptTimedText: () => string | null;
  clearSummarySource: () => void;
  updateSlideSummaryFromMarkdown: (
    markdown: string,
    opts?: { preserveIfEmpty?: boolean; source?: Exclude<SlideSummarySource, null> },
  ) => void;
  renderMarkdown: (markdown: string) => void;
  renderInlineSlidesFallback: () => void;
};

export function createSlidesSummaryController(options: SlidesSummaryControllerOptions) {
  let activeGeneration = 0;

  const getState = () => options.getPanelState().slidesSummary;
  const updateState = (value: Partial<PanelState["slidesSummary"]>) => {
    patchPanelState(options.getPanelState(), "slidesSummary", value);
  };
  const isCurrentGeneration = (generation: number) => generation === activeGeneration;

  const getEffectiveInputMode = () => options.getInputModeOverride() ?? options.getInputMode();
  const getCurrentUrl = () =>
    options.getPanelState().currentSource?.url ?? options.getActiveTabUrl() ?? null;
  const getFallbackModel = () =>
    options.getPanelState().lastMeta.model ?? options.getUiState()?.settings.model ?? "auto";

  const applyMarkdown = (markdown: string) => {
    if (!markdown.trim()) return;
    const state = getState();
    const currentUrl = getCurrentUrl();
    if (state.url && currentUrl && !options.panelUrlsMatch(state.url, currentUrl)) return;
    if (!options.getSlidesEnabled()) {
      updateState({ pending: markdown });
      return;
    }
    if (getEffectiveInputMode() !== "video") {
      updateState({ pending: markdown });
      return;
    }

    let output = markdown;
    const slides = options.getPanelState().slides?.slides ?? [];
    if (slides.length > 0) {
      output = buildSlidePresentation({
        markdown,
        slides: slides.map((slide) => ({
          index: slide.index,
          timestamp: Number.isFinite(slide.timestamp) ? slide.timestamp : Number.NaN,
        })),
        transcriptTimedText: options.getTranscriptTimedText(),
        lengthArg: resolveSlidesLengthArg(options.getLengthValue()),
      }).markdown;
    }
    options.updateSlideSummaryFromMarkdown(output, {
      preserveIfEmpty: false,
      source: "slides",
    });
    if (!options.getPanelState().summaryMarkdown?.trim()) {
      options.renderMarkdown(output);
    }
  };

  const maybeApplyPending = () => {
    const state = getState();
    if (!state.pending) return;
    const phase = options.getPanelState().phase;
    if (phase === "connecting" || phase === "streaming") return;
    const markdown = state.pending;
    updateState({ pending: null });
    applyMarkdown(markdown);
  };

  const applyGeneratedSummary = ({
    runId,
    url,
    markdown,
    model,
    complete,
  }: {
    runId: string;
    url: string | null;
    markdown: string;
    model: string;
    complete: boolean;
  }) => {
    const currentUrl = getCurrentUrl();
    if (url && currentUrl && !options.panelUrlsMatch(url, currentUrl)) return;
    const state = getState();
    if (state.runId && state.runId !== runId) return;
    updateState({
      runId,
      url,
      markdown,
      model,
      complete,
      hadError: false,
      pending: null,
    });
    if (!markdown.trim()) return;
    if (!complete) {
      if (options.getSlidesEnabled() && getEffectiveInputMode() === "video") {
        options.updateSlideSummaryFromMarkdown(markdown, {
          preserveIfEmpty: true,
          source: "slides-partial",
        });
        if (options.getPanelState().summaryMarkdown && options.getPanelState().slides) {
          options.renderInlineSlidesFallback();
        }
      }
      return;
    }
    const phase = options.getPanelState().phase;
    if (phase === "connecting" || phase === "streaming") {
      updateState({ pending: markdown });
      return;
    }
    applyMarkdown(markdown);
  };

  const createGenerationStreamController = (generation: number) =>
    createStreamController({
      getToken: options.getToken,
      onStatus: () => {},
      onPhaseChange: () => {},
      idleTimeoutMs: 600_000,
      idleTimeoutMessage: "Slides summary stalled. The daemon may have stopped.",
      onMeta: (meta) => {
        if (!isCurrentGeneration(generation)) return;
        if (typeof meta.model === "string") {
          updateState({ model: meta.model });
        }
      },
      onRender: (markdown) => {
        if (!isCurrentGeneration(generation)) return;
        updateState({ markdown });
        if (options.getSlidesEnabled() && getEffectiveInputMode() === "video") {
          options.updateSlideSummaryFromMarkdown(markdown, {
            preserveIfEmpty: true,
            source: "slides-partial",
          });
          if (options.getPanelState().summaryMarkdown && options.getPanelState().slides) {
            options.renderInlineSlidesFallback();
          }
        }
      },
      onReset: () => {
        if (!isCurrentGeneration(generation)) return;
        updateState({
          markdown: "",
          pending: null,
          hadError: false,
          complete: false,
          model: getFallbackModel(),
        });
      },
      onError: (error) => {
        if (!isCurrentGeneration(generation)) return "";
        updateState({ hadError: true });
        return options.friendlyFetchError(error, "Slides summary failed");
      },
      onDone: () => {
        if (!isCurrentGeneration(generation)) return;
        const state = getState();
        if (state.hadError) {
          updateState({ complete: false });
          return;
        }
        updateState({ complete: true });
        const markdown = state.markdown;
        if (!markdown.trim()) return;
        const phase = options.getPanelState().phase;
        if (phase === "connecting" || phase === "streaming") {
          updateState({ pending: markdown });
          return;
        }
        applyMarkdown(markdown);
      },
    });

  let streamController = createGenerationStreamController(activeGeneration);

  return {
    stop() {
      activeGeneration += 1;
      streamController.abort();
      streamController = createGenerationStreamController(activeGeneration);
      options.getPanelState().slidesSummary = createInitialSlidesSummaryState();
      options.clearSummarySource();
    },
    start(run: RunStart) {
      activeGeneration += 1;
      streamController.abort();
      streamController = createGenerationStreamController(activeGeneration);
      return streamController.start(run);
    },
    getSnapshot(): SlidesSummarySnapshot {
      const state = getState();
      return {
        runId: state.runId,
        markdown: state.markdown,
        complete: state.complete,
        model: state.model,
      };
    },
    getMarkdown() {
      return getState().markdown;
    },
    getComplete() {
      return getState().complete;
    },
    getModel() {
      return getState().model;
    },
    getRunId() {
      return getState().runId;
    },
    setSnapshot(payload: { markdown: string; complete: boolean; model: string | null }) {
      updateState(payload);
    },
    clearPending() {
      updateState({ pending: null });
    },
    clearError() {
      updateState({ hadError: false });
    },
    setRunId(value: string | null) {
      updateState({ runId: value });
    },
    setUrl(value: string | null) {
      updateState({ url: value });
    },
    resetSummaryState() {
      updateState({
        markdown: "",
        pending: null,
        hadError: false,
        complete: false,
      });
    },
    setModel(value: string | null) {
      updateState({ model: value });
    },
    applyGeneratedSummary,
    applyMarkdown,
    maybeApplyPending,
  };
}
