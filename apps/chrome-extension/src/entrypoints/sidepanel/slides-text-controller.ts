import { logExtensionEvent } from "../../lib/extension-logs";
import type { SseSlidesData } from "../../lib/runtime-contracts";
import { parseTranscriptTimedText } from "../../lib/slides-text";
import {
  buildSlideDescriptions,
  deriveSlideSummaries,
  resolveSlidesTextState,
  type SlideTextMode,
} from "./slides-state";

export type SlideSummarySource = "summary" | "slides" | "slides-partial" | null;

export function createSlidesTextController(options: {
  getSlides: () => SseSlidesData["slides"] | null | undefined;
  getLengthValue: () => string;
  getSlidesOcrEnabled: () => boolean;
}) {
  let slidesTextMode: SlideTextMode = "transcript";
  let slidesTextToggleVisible = false;
  let slidesTranscriptTimedText: string | null = null;
  let slidesTranscriptAvailable = false;
  let slidesOcrAvailable = false;
  let slideDescriptions = new Map<number, string>();
  let slideSummaryByIndex = new Map<number, string>();
  let slideTitleByIndex = new Map<number, string>();
  let slideSummarySource: SlideSummarySource = null;
  let lastDescriptionLogKey = "";

  const getSlides = () => options.getSlides() ?? [];

  const rebuildDescriptions = () => {
    slideDescriptions = new Map();
    const slides = getSlides();
    if (slides.length === 0) return;
    slideDescriptions = buildSlideDescriptions({
      slides,
      slideSummaries: slideSummaryByIndex,
      transcriptTimedText: slidesTranscriptTimedText,
      lengthValue: options.getLengthValue(),
      slidesTextMode,
      slidesOcrEnabled: options.getSlidesOcrEnabled(),
      slidesOcrAvailable,
      slidesTranscriptAvailable,
      allowTranscriptFallback:
        slideSummarySource !== "summary" || slideSummaryByIndex.size < slides.length,
    });
    const detail = {
      slides: slides.length,
      descriptions: slideDescriptions.size,
      summaries: slideSummaryByIndex.size,
      titles: slideTitleByIndex.size,
      transcriptAvailable: slidesTranscriptAvailable,
      ocrAvailable: slidesOcrAvailable,
      textMode: slidesTextMode,
      source: slideSummarySource ?? (slidesTranscriptAvailable ? "transcript" : "none"),
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
      slidesTextMode = "transcript";
      slidesTextToggleVisible = false;
      slidesTranscriptTimedText = null;
      slidesTranscriptAvailable = false;
      slidesOcrAvailable = false;
      slideDescriptions = new Map();
      slideSummaryByIndex = new Map();
      slideTitleByIndex = new Map();
      slideSummarySource = null;
      lastDescriptionLogKey = "";
    },
    clearSummarySource() {
      slideSummarySource = null;
    },
    rebuildDescriptions,
    setTranscriptTimedText(value: string | null) {
      slidesTranscriptTimedText = value ?? null;
      slidesTranscriptAvailable = parseTranscriptTimedText(slidesTranscriptTimedText).length > 0;
    },
    syncTextState() {
      const nextState = resolveSlidesTextState({
        slides: getSlides(),
        slidesOcrEnabled: options.getSlidesOcrEnabled(),
        slidesTranscriptAvailable,
        currentMode: slidesTextMode,
      });
      slidesOcrAvailable = nextState.slidesOcrAvailable;
      slidesTextToggleVisible = nextState.slidesTextToggleVisible;
      slidesTextMode = nextState.slidesTextMode;
      rebuildDescriptions();
    },
    setTextMode(next: SlideTextMode) {
      if (next === slidesTextMode) return false;
      if (next === "ocr" && !slidesOcrAvailable) return false;
      slidesTextMode = next;
      rebuildDescriptions();
      return true;
    },
    updateSummaryFromMarkdown(
      markdown: string,
      opts?: { preserveIfEmpty?: boolean; source?: Exclude<SlideSummarySource, null> },
    ) {
      const source = opts?.source ?? "summary";
      const derived = deriveSlideSummaries({
        markdown,
        slides: getSlides(),
        transcriptTimedText: slidesTranscriptTimedText,
        lengthValue: options.getLengthValue(),
      });
      if (source === "summary" && slideSummarySource === "slides") {
        return false;
      }
      if (!derived) {
        if (opts?.preserveIfEmpty) return false;
        slideSummaryByIndex = new Map();
        slideTitleByIndex = new Map();
        if (source === "slides") {
          slideSummarySource = null;
        } else if (slideSummarySource === source) {
          slideSummarySource = null;
        }
        rebuildDescriptions();
        return true;
      }
      slideSummaryByIndex = derived.summaries;
      slideTitleByIndex = derived.titles;
      slideSummarySource = source;
      rebuildDescriptions();
      return true;
    },
    getTextMode: () => slidesTextMode,
    getTextToggleVisible: () => slidesTextToggleVisible,
    getTranscriptTimedText: () => slidesTranscriptTimedText,
    getTranscriptAvailable: () => slidesTranscriptAvailable,
    getOcrAvailable: () => slidesOcrAvailable,
    getDescriptions: () => slideDescriptions,
    getDescriptionEntries: () => Array.from(slideDescriptions.entries()),
    getSummaryEntries: () => Array.from(slideSummaryByIndex.entries()),
    getTitles: () => slideTitleByIndex,
    hasSummaryTitles: () => slideTitleByIndex.size > 0,
  };
}
