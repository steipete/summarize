import { SUMMARY_LENGTH_SPECS } from "@steipete/summarize-core/prompts";
import type { SummaryLength, SseSlidesData } from "../../lib/runtime-contracts";
import { buildSlidePresentation, type SlidePresentationCard } from "../../lib/slides-presentation";
import {
  buildSlideTextFallback,
  resolveSlideTextBudget,
  splitSummaryFromSlides,
  type SlideTimelineEntry,
} from "../../lib/slides-text";
import { chooseSlideDescription, sanitizeSlideSummaryTitle } from "./slide-text-policy";
import { shouldHideSummaryForSlides } from "./slides-view-policy";

const SLIDE_OCR_MIN_CHARS = 16;
const SLIDE_OCR_SIGNIFICANT_TOTAL = 200;
const SLIDE_OCR_SIGNIFICANT_SLIDES = 3;
const SLIDE_OCR_GIBBERISH_MIN_CHARS = 24;
const SLIDE_OCR_GIBBERISH_MIN_TOKENS = 8;
const SLIDE_OCR_GIBBERISH_MAX_SHORT_TOKEN_RATIO = 0.55;
const SLIDE_OCR_GIBBERISH_MAX_SYMBOL_RATIO = 0.42;
const SLIDE_OCR_GIBBERISH_WEIRD_SYMBOL_RATIO = 0.08;
const SLIDE_CUSTOM_LENGTH_PATTERN = /^(?<value>\d+(?:\.\d+)?)(?<unit>k|m)?$/i;

export type SlideTextMode = "transcript" | "ocr";

type SlideLike = SseSlidesData["slides"][number];

export type SlideSummaryDerivation = {
  cards: SlidePresentationCard[];
  summaries: Map<number, string>;
  titles: Map<number, string>;
};

export function splitSlidesMarkdown(markdown: string): { summary: string; slides: string | null } {
  const { summary, slidesSection } = splitSummaryFromSlides(markdown);
  const slides = slidesSection?.trim() ?? "";
  return { summary, slides: slides.length > 0 ? slides : null };
}

export function selectMarkdownForLayout({
  markdown,
  slidesEnabled,
  inputMode,
  hasSlides,
  slidesLayout,
}: {
  markdown: string;
  slidesEnabled: boolean;
  inputMode: "page" | "video";
  hasSlides: boolean;
  slidesLayout: string;
}): string {
  const trimmed = markdown.trim();
  if (!trimmed) return "";
  if (shouldHideSummaryForSlides({ slidesEnabled, inputMode, hasSlides })) {
    const { summary, slides } = splitSlidesMarkdown(markdown);
    return slides ? summary : "";
  }
  const { summary, slides } = splitSlidesMarkdown(markdown);
  if (slidesLayout === "strip" || slidesLayout === "gallery") {
    return summary || slides || markdown;
  }
  return markdown;
}

export function formatSlideTimestamp(seconds: number | null | undefined): string | null {
  if (seconds == null || !Number.isFinite(seconds)) return null;
  const total = Math.max(0, Math.floor(seconds));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  const mm = minutes.toString().padStart(2, "0");
  const ss = secs.toString().padStart(2, "0");
  return hours > 0 ? `${hours}:${mm}:${ss}` : `${minutes}:${ss}`;
}

export function resolveSlidesLengthArg(
  lengthValue: string,
): { kind: "preset"; preset: SummaryLength } | { kind: "chars"; maxCharacters: number } {
  const normalized = lengthValue.trim().toLowerCase();
  if (Object.hasOwn(SUMMARY_LENGTH_SPECS, normalized)) {
    return { kind: "preset", preset: normalized as SummaryLength };
  }
  const match = normalized.match(SLIDE_CUSTOM_LENGTH_PATTERN);
  if (!match) return { kind: "preset", preset: "short" };
  const value = Number(match.groups?.value ?? match[1]);
  if (!Number.isFinite(value) || value <= 0) {
    return { kind: "preset", preset: "short" };
  }
  const unit = (match.groups?.unit ?? "").toLowerCase();
  const multiplier = unit === "m" ? 1_000_000 : unit === "k" ? 1_000 : 1;
  return { kind: "chars", maxCharacters: Math.round(value * multiplier) };
}

export function normalizeSlideText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function hasMeaningfulSlideSummaryText(value: string): boolean {
  const normalized = normalizeSlideText(value);
  if (!normalized) return false;
  if (/^#{1,6}$/.test(normalized)) return false;
  return true;
}

export function normalizeOcrText(raw: string | null | undefined): string {
  const text = normalizeSlideText(raw ?? "");
  if (!text) return "";
  if (text.length < SLIDE_OCR_GIBBERISH_MIN_CHARS) return text;

  const tokens = text.split(" ").filter(Boolean);
  if (tokens.length === 0) return "";

  const wordishTokens = tokens
    .map((token) => token.replace(/[^\p{L}]/gu, ""))
    .filter((token) => token.length > 0);
  const letterTokens = wordishTokens;
  const shortLetterTokens = letterTokens.filter((token) => token.length <= 3);
  const longWordishTokens = tokens.filter((token) => {
    const stripped = token.replace(/[^\p{L}\p{N}]/gu, "");
    return stripped.length >= 4 && /\p{L}/u.test(stripped);
  });

  const mixedCaseTokens = letterTokens.filter(
    (token) => /[A-Z]/.test(token) && /[a-z]/.test(token),
  );
  const hasLongWord = letterTokens.some((token) => token.length >= 5 && /[aeiou]/i.test(token));

  const chars = Array.from(text);
  const letters = chars.filter((char) => /\p{L}/u.test(char)).length;
  const digits = chars.filter((char) => /\p{N}/u.test(char)).length;
  const spaces = chars.filter((char) => char === " ").length;
  const symbols = Math.max(0, chars.length - letters - digits - spaces);
  const symbolRatio = chars.length > 0 ? symbols / chars.length : 0;
  const weirdSymbols = chars.filter((char) => /[=^~`_|]/.test(char)).length;
  const weirdSymbolRatio = chars.length > 0 ? weirdSymbols / chars.length : 0;

  if (
    tokens.length >= SLIDE_OCR_GIBBERISH_MIN_TOKENS &&
    letterTokens.length > 0 &&
    shortLetterTokens.length / letterTokens.length >= SLIDE_OCR_GIBBERISH_MAX_SHORT_TOKEN_RATIO &&
    longWordishTokens.length < 2
  ) {
    return "";
  }

  if (
    tokens.length >= SLIDE_OCR_GIBBERISH_MIN_TOKENS &&
    letterTokens.length > 0 &&
    !hasLongWord &&
    mixedCaseTokens.length / letterTokens.length >= 0.45 &&
    longWordishTokens.length < 2
  ) {
    return "";
  }

  if (
    symbolRatio >= SLIDE_OCR_GIBBERISH_MAX_SYMBOL_RATIO &&
    weirdSymbolRatio >= SLIDE_OCR_GIBBERISH_WEIRD_SYMBOL_RATIO &&
    longWordishTokens.length < 2
  ) {
    return "";
  }

  return text;
}

function truncateSlideText(value: string, limit: number): string {
  if (value.length <= limit) return value;
  const truncated = value.slice(0, limit).trimEnd();
  const clean = truncated.replace(/\s+\S*$/, "").trim();
  const result = clean.length > 0 ? clean : truncated.trim();
  return result.length > 0 ? `${result}...` : "";
}

function getOcrTextForSlide(slide: SlideLike, budget: number): string {
  const text = normalizeOcrText(slide.ocrText);
  return text ? truncateSlideText(text, budget) : "";
}

function createTimeline(slides: SlideLike[]): SlideTimelineEntry[] {
  return slides.map((slide) => ({
    index: slide.index,
    timestamp: Number.isFinite(slide.timestamp) ? slide.timestamp : Number.NaN,
  }));
}

function countSummaryParagraphs(markdown: string): number {
  const { summary } = splitSlidesMarkdown(markdown);
  return summary
    .split(/\n\s*\n+/)
    .map((part) => part.trim())
    .filter(Boolean)
    .filter((part) => !/^#{1,6}\s+\S/.test(part)).length;
}

export function deriveSlideSummaries({
  markdown,
  slides,
  transcriptTimedText,
  lengthValue,
}: {
  markdown: string;
  slides: SlideLike[];
  transcriptTimedText: string | null;
  lengthValue: string;
}): SlideSummaryDerivation | null {
  const lengthArg = resolveSlidesLengthArg(lengthValue);
  const directPresentation = buildSlidePresentation({
    markdown,
    slides: createTimeline(slides),
    transcriptTimedText,
    lengthArg,
    coerce: false,
    includeTranscriptFallback: false,
  });
  const directHasEverySlideBody =
    slides.length > 0 && slides.every((slide) => directPresentation.summaries.has(slide.index));
  const summaryParagraphCount = countSummaryParagraphs(markdown);
  const shouldCoerce =
    summaryParagraphCount >= 2 &&
    (directPresentation.cards.length === 0 || !directHasEverySlideBody);
  const presentation = shouldCoerce
    ? buildSlidePresentation({
        markdown,
        slides: createTimeline(slides),
        transcriptTimedText,
        lengthArg,
        coerce: true,
        coerceReserveIntro: false,
        includeTranscriptFallback: false,
      })
    : directPresentation;
  const summaries = new Map<number, string>();
  const titles = new Map<number, string>();
  for (const card of presentation.cards) {
    const title = sanitizeSlideSummaryTitle(normalizeSlideText(card.title ?? ""));
    const body = normalizeSlideText(card.body);
    if (hasMeaningfulSlideSummaryText(body)) summaries.set(card.index, body);
    if (hasMeaningfulSlideSummaryText(title)) titles.set(card.index, title);
  }
  if (summaries.size === 0 && titles.size === 0) return null;
  return { cards: presentation.cards, summaries, titles };
}

export function buildSlideDescriptions({
  slides,
  slideSummaries,
  transcriptTimedText,
  lengthValue,
  slidesTextMode,
  slidesOcrEnabled,
  slidesOcrAvailable,
  slidesTranscriptAvailable,
  allowTranscriptFallback = true,
}: {
  slides: SlideLike[];
  slideSummaries?: ReadonlyMap<number, string>;
  transcriptTimedText: string | null;
  lengthValue: string;
  slidesTextMode: SlideTextMode;
  slidesOcrEnabled: boolean;
  slidesOcrAvailable: boolean;
  slidesTranscriptAvailable: boolean;
  allowTranscriptFallback?: boolean;
}): Map<number, string> {
  const descriptions = new Map<number, string>();
  const lengthArg = resolveSlidesLengthArg(lengthValue);
  const timeline = createTimeline(slides);
  const fallbackSummaries = allowTranscriptFallback
    ? buildSlideTextFallback({
        slides: timeline,
        transcriptTimedText,
        lengthArg,
      })
    : new Map<number, string>();
  const budget = resolveSlideTextBudget({ lengthArg, slideCount: timeline.length });
  const allowOcrFallback = slidesOcrEnabled && slidesOcrAvailable && !slidesTranscriptAvailable;
  for (const slide of slides) {
    const summaryText = slideSummaries?.get(slide.index) ?? "";
    const transcriptText = fallbackSummaries.get(slide.index) ?? "";
    const ocrText = getOcrTextForSlide(slide, budget);
    descriptions.set(
      slide.index,
      chooseSlideDescription({
        summaryText,
        transcriptText,
        ocrText,
        preferOcr: slidesTextMode === "ocr",
        allowOcrFallback,
      }),
    );
  }
  return descriptions;
}

export function resolveSlidesTextState({
  slides,
  slidesOcrEnabled,
  slidesTranscriptAvailable,
  currentMode,
}: {
  slides: SlideLike[];
  slidesOcrEnabled: boolean;
  slidesTranscriptAvailable: boolean;
  currentMode: SlideTextMode;
}): {
  slidesOcrAvailable: boolean;
  slidesTextToggleVisible: boolean;
  slidesTextMode: SlideTextMode;
} {
  let slidesOcrAvailable = false;
  let ocrTotal = 0;
  let ocrSlides = 0;
  for (const slide of slides) {
    const text = normalizeOcrText(slide.ocrText);
    if (text.length > 0) slidesOcrAvailable = true;
    if (text.length >= SLIDE_OCR_MIN_CHARS) {
      ocrTotal += text.length;
      ocrSlides += 1;
    }
  }
  const ocrSignificant =
    slidesOcrAvailable &&
    ocrTotal >= SLIDE_OCR_SIGNIFICANT_TOTAL &&
    ocrSlides >= SLIDE_OCR_SIGNIFICANT_SLIDES;
  const allowOcr = slidesOcrEnabled && ocrSignificant;
  let slidesTextMode = currentMode;
  if ((!allowOcr || !slidesOcrAvailable) && slidesTextMode === "ocr") {
    slidesTextMode = "transcript";
  }
  if (!slidesTranscriptAvailable && !allowOcr) {
    slidesTextMode = "transcript";
  }
  return {
    slidesOcrAvailable,
    slidesTextToggleVisible: allowOcr,
    slidesTextMode,
  };
}
