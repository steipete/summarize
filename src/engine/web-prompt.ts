import { formatTimestamp, parseTranscriptTimedText } from "@steipete/summarize-core/slides";
import type { ExtractedLinkContent } from "../content/index.js";
import type { OutputLanguage } from "../language.js";
import { buildLinkSummaryPrompt, SUMMARY_LENGTH_TARGET_CHARACTERS } from "../prompts/index.js";
import { resolveTargetCharacters, type SummaryLengthArg } from "../shared/summary-length.js";
import { buildSummaryTimestampLimitInstruction } from "./summary-timestamps.js";

type SlidesResult = Awaited<ReturnType<typeof import("../slides/index.js").extractSlidesForSource>>;

const MAX_SLIDE_TRANSCRIPT_CHARS_BY_PRESET = {
  short: 2500,
  medium: 5000,
  long: 9000,
  xl: 15000,
  xxl: 24000,
} as const;

const SLIDE_TRANSCRIPT_DEFAULT_EDGE_SECONDS = 30;
const SLIDE_TRANSCRIPT_LEEWAY_SECONDS = 10;

function truncateTranscript(value: string, limit: number): string {
  if (value.length <= limit) return value;
  const truncated = value.slice(0, limit).trimEnd();
  const clean = truncated.replace(/\s+\S*$/, "").trim();
  const result = clean.length > 0 ? clean : truncated.trim();
  return result.length > 0 ? `${result}…` : "";
}

function buildSlidesPromptText({
  slides,
  transcriptTimedText,
  preset,
}: {
  slides: SlidesResult | null | undefined;
  transcriptTimedText: string | null | undefined;
  preset: "short" | "medium" | "long" | "xl" | "xxl";
}): string | null {
  if (!slides || slides.slides.length === 0) return null;
  const segments = parseTranscriptTimedText(transcriptTimedText);
  const slidesWithTimestamps = slides.slides
    .filter((slide) => Number.isFinite(slide.timestamp))
    .map((slide) => ({ index: slide.index, timestamp: Math.max(0, Math.floor(slide.timestamp)) }))
    .sort((a, b) => a.timestamp - b.timestamp);
  if (slidesWithTimestamps.length === 0) return null;

  const totalBudget = Number(MAX_SLIDE_TRANSCRIPT_CHARS_BY_PRESET[preset]);
  const perSlideBudget = Math.max(
    120,
    Math.floor(totalBudget / Math.max(1, slidesWithTimestamps.length)),
  );
  let remaining = totalBudget;
  const blocks: string[] = [];

  for (let i = 0; i < slidesWithTimestamps.length; i += 1) {
    const slide = slidesWithTimestamps[i];
    if (!slide) continue;
    const prev = slidesWithTimestamps[i - 1];
    const next = slidesWithTimestamps[i + 1];
    const startBase = prev ? Math.floor((prev.timestamp + slide.timestamp) / 2) : slide.timestamp;
    const endBase = next ? Math.ceil((slide.timestamp + next.timestamp) / 2) : slide.timestamp;
    const start = Math.max(
      0,
      (prev ? startBase : slide.timestamp - SLIDE_TRANSCRIPT_DEFAULT_EDGE_SECONDS) -
        SLIDE_TRANSCRIPT_LEEWAY_SECONDS,
    );
    const end =
      (next ? endBase : slide.timestamp + SLIDE_TRANSCRIPT_DEFAULT_EDGE_SECONDS) +
      SLIDE_TRANSCRIPT_LEEWAY_SECONDS;

    const excerptRaw = segments
      .filter((segment) => segment.startSeconds >= start && segment.startSeconds <= end)
      .map((segment) => segment.text)
      .join(" ")
      .trim()
      .replace(/\s+/g, " ");
    const excerptBudget = remaining > 0 ? Math.min(perSlideBudget, remaining) : 0;
    const excerpt =
      excerptRaw && excerptBudget > 0 ? truncateTranscript(excerptRaw, excerptBudget) : "";
    const label = `[slide:${slide.index}] [${formatTimestamp(start)}–${formatTimestamp(end)}]`;
    const block = excerpt ? `${label}\n${excerpt}` : label;
    blocks.push(block);
    remaining = Math.max(0, remaining - block.length);
  }

  return blocks.length > 0 ? blocks.join("\n\n") : null;
}

export function shouldBypassShortContentSummary({
  extracted,
  lengthArg,
  forceSummary,
  maxOutputTokensArg,
  json,
  countTokens,
}: {
  extracted: ExtractedLinkContent;
  lengthArg: SummaryLengthArg;
  forceSummary: boolean;
  maxOutputTokensArg: number | null;
  json: boolean;
  countTokens: (value: string) => number;
}): boolean {
  if (forceSummary) return false;
  if (!extracted.content || extracted.content.length === 0) return false;
  const targetCharacters = resolveTargetCharacters(lengthArg, SUMMARY_LENGTH_TARGET_CHARACTERS);
  if (!Number.isFinite(targetCharacters) || targetCharacters <= 0) return false;
  if (extracted.content.length > targetCharacters) return false;
  if (!json && typeof maxOutputTokensArg === "number") {
    if (countTokens(extracted.content) > maxOutputTokensArg) return false;
  }
  return true;
}

export function buildUrlPrompt({
  extracted,
  outputLanguage,
  lengthArg,
  promptOverride,
  lengthInstruction,
  languageInstruction,
  slides,
}: {
  extracted: ExtractedLinkContent;
  outputLanguage: OutputLanguage;
  lengthArg: SummaryLengthArg;
  promptOverride?: string | null;
  lengthInstruction?: string | null;
  languageInstruction?: string | null;
  slides?: SlidesResult | null;
}): string {
  const preset = lengthArg.kind === "preset" ? lengthArg.preset : "medium";
  const slidesText = buildSlidesPromptText({
    slides,
    transcriptTimedText: extracted.transcriptTimedText,
    preset,
  });
  const isYouTube = extracted.siteName === "YouTube";
  return buildLinkSummaryPrompt({
    url: extracted.url,
    title: extracted.title,
    siteName: extracted.siteName,
    description: extracted.description,
    content: extracted.content,
    truncated: extracted.truncated,
    hasTranscript:
      isYouTube ||
      (extracted.transcriptSource !== null && extracted.transcriptSource !== "unavailable"),
    hasTranscriptTimestamps: Boolean(extracted.transcriptTimedText),
    timestampLimitInstruction: buildSummaryTimestampLimitInstruction(extracted),
    slides:
      slides && slides.slides.length > 0
        ? { count: slides.slides.length, text: slidesText ?? "" }
        : null,
    summaryLength:
      lengthArg.kind === "preset" ? lengthArg.preset : { maxCharacters: lengthArg.maxCharacters },
    outputLanguage,
    shares: [],
    promptOverride: promptOverride ?? null,
    lengthInstruction: lengthInstruction ?? null,
    languageInstruction: languageInstruction ?? null,
  });
}
