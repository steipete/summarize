import { logExtensionEvent } from "../../lib/extension-logs";
import type { SseSlidesData } from "../../lib/runtime-contracts";
import { parseTranscriptTimedText } from "../../lib/slides-text";
import { createInitialSlidesTextState, patchPanelState } from "./panel-state-store";
import {
  buildSlideDescriptions,
  deriveSlideSummaries,
  resolveSlidesTextState,
  type SlideTextMode,
} from "./slides-state";
import type { PanelState, SlideSummarySource } from "./types";

export function createSlidesTextController(options: {
  panelState: PanelState;

  getSlides: () => SseSlidesData["slides"] | null | undefined;
  getLengthValue: () => string;
  getSlidesOcrEnabled: () => boolean;
}) {
  let lastDescriptionLogKey = "";

  const getSlides = () => options.getSlides() ?? [];
  const getState = () => options.panelState.slidesText;
  const updateState = (value: Partial<PanelState["slidesText"]>) => {
    patchPanelState(options.panelState, "slidesText", value);
  };

  const rebuildDescriptions = () => {
    const state = getState();
    const slideSummaries = recordToMap(state.summariesByIndex);
    const slideTitles = recordToMap(state.titlesByIndex);
    const slides = getSlides();
    const slideDescriptions =
      slides.length === 0
        ? new Map<number, string>()
        : buildSlideDescriptions({
            slides,
            slideSummaries,
            transcriptTimedText: state.transcriptTimedText,
            lengthValue: options.getLengthValue(),
            slidesTextMode: state.mode,
            slidesOcrEnabled: options.getSlidesOcrEnabled(),
            slidesOcrAvailable: state.ocrAvailable,
            slidesTranscriptAvailable: state.transcriptAvailable,
            allowTranscriptFallback:
              state.summarySource !== "summary" || slideSummaries.size < slides.length,
          });
    updateState({ descriptionsByIndex: mapToRecord(slideDescriptions) });
    const detail = {
      slides: slides.length,
      descriptions: slideDescriptions.size,
      summaries: slideSummaries.size,
      titles: slideTitles.size,
      transcriptAvailable: state.transcriptAvailable,
      ocrAvailable: state.ocrAvailable,
      textMode: state.mode,
      source: state.summarySource ?? (state.transcriptAvailable ? "transcript" : "none"),
    };
    const logKey = JSON.stringify(detail);
    if (logKey === lastDescriptionLogKey) return;
    lastDescriptionLogKey = logKey;
    if (globalThis.chrome?.storage) {
      logExtensionEvent({
        event: "slides:text:rebuilt",
        scope: "slides:panel",
        level: "verbose",
        detail,
      });
    }
  };

  return {
    reset() {
      options.panelState.slidesText = createInitialSlidesTextState();
      lastDescriptionLogKey = "";
    },
    clearSummarySource() {
      updateState({ summarySource: null });
    },
    rebuildDescriptions,
    setTranscriptTimedText(value: string | null) {
      const transcriptTimedText = value ?? null;
      updateState({
        transcriptTimedText,
        transcriptAvailable: parseTranscriptTimedText(transcriptTimedText).length > 0,
      });
    },
    syncTextState() {
      const state = getState();
      const nextState = resolveSlidesTextState({
        slides: getSlides(),
        slidesOcrEnabled: options.getSlidesOcrEnabled(),
        slidesTranscriptAvailable: state.transcriptAvailable,
        currentMode: state.mode,
      });
      updateState({
        ocrAvailable: nextState.slidesOcrAvailable,
        toggleVisible: nextState.slidesTextToggleVisible,
        mode: nextState.slidesTextMode,
      });
      rebuildDescriptions();
    },
    setTextMode(next: SlideTextMode) {
      const state = getState();
      if (next === state.mode) return false;
      if (next === "ocr" && !state.ocrAvailable) return false;
      updateState({ mode: next });
      rebuildDescriptions();
      return true;
    },
    updateSummaryFromMarkdown(
      markdown: string,
      opts?: { preserveIfEmpty?: boolean; source?: Exclude<SlideSummarySource, null> },
    ) {
      const state = getState();
      const source = opts?.source ?? "summary";
      const derived = deriveSlideSummaries({
        markdown,
        slides: getSlides(),
        transcriptTimedText: state.transcriptTimedText,
        lengthValue: options.getLengthValue(),
      });
      if (source === "summary" && state.summarySource === "slides") {
        return false;
      }
      if (!derived) {
        if (opts?.preserveIfEmpty) return false;
        updateState({
          summariesByIndex: {},
          titlesByIndex: {},
          summarySource:
            source === "slides" || state.summarySource === source ? null : state.summarySource,
        });
        rebuildDescriptions();
        return true;
      }
      updateState({
        summariesByIndex: mapToRecord(derived.summaries),
        titlesByIndex: mapToRecord(derived.titles),
        summarySource: source,
      });
      rebuildDescriptions();
      return true;
    },
    getTextMode: () => getState().mode,
    getTextToggleVisible: () => getState().toggleVisible,
    getTranscriptTimedText: () => getState().transcriptTimedText,
    getTranscriptAvailable: () => getState().transcriptAvailable,
    getOcrAvailable: () => getState().ocrAvailable,
    getDescriptions: () => recordToMap(getState().descriptionsByIndex),
    getDescriptionEntries: () => mapEntries(getState().descriptionsByIndex),
    getSummaryEntries: () => mapEntries(getState().summariesByIndex),
    getTitles: () => recordToMap(getState().titlesByIndex),
    hasSummaryTitles: () => Object.keys(getState().titlesByIndex).length > 0,
  };
}

function mapToRecord(values: Map<number, string>): Record<number, string> {
  return Object.fromEntries(values) as Record<number, string>;
}

function mapEntries(values: Record<number, string>): Array<[number, string]> {
  return Object.entries(values).map(([index, value]) => [Number(index), value]);
}

function recordToMap(values: Record<number, string>): Map<number, string> {
  return new Map(mapEntries(values));
}
