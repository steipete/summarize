import type { SummaryLength } from "../shared/contracts.js";

export type SummaryLengthSpec = {
  guidance: string;
  formatting: string;
  targetCharacters: number;
  minCharacters: number;
  maxCharacters: number;
  maxTokens: number;
};

export const SUMMARY_LENGTH_SPECS: Record<SummaryLength, SummaryLengthSpec> = {
  short: {
    guidance:
      "Write a tight summary that delivers the primary claim plus one high-signal supporting detail.",
    formatting:
      "Use 1-2 short paragraphs (a single paragraph is fine). Aim for 2-5 sentences total.",
    targetCharacters: 900,
    minCharacters: 600,
    maxCharacters: 1200,
    maxTokens: 768,
  },
  medium: {
    guidance:
      "Write a clear summary that covers the core claim plus the most important supporting evidence or data points.",
    formatting:
      "Use 1-3 short paragraphs (2 is typical, but a single paragraph is okay if the content is simple). Aim for 2-3 sentences per paragraph.",
    targetCharacters: 1800,
    minCharacters: 1200,
    maxCharacters: 2500,
    maxTokens: 1536,
  },
  long: {
    guidance:
      "Write a detailed summary that prioritizes the most important points first, followed by key supporting facts or events, then secondary details or conclusions stated in the source.",
    formatting:
      "Paragraphs are optional; use up to 3 short paragraphs. Aim for 2-4 sentences per paragraph when you split into paragraphs.",
    targetCharacters: 4200,
    minCharacters: 2500,
    maxCharacters: 6000,
    maxTokens: 3072,
  },
  xl: {
    guidance:
      "Write a detailed summary that captures the main points, supporting facts, and concrete numbers or quotes when present.",
    formatting: "Use 2-5 short paragraphs. Aim for 2-4 sentences per paragraph.",
    targetCharacters: 9000,
    minCharacters: 6000,
    maxCharacters: 14000,
    maxTokens: 6144,
  },
  xxl: {
    guidance:
      "Write a comprehensive summary that covers background, main points, evidence, and stated outcomes in the source text; avoid adding implications or recommendations unless explicitly stated.",
    formatting: "Use 3-7 short paragraphs. Aim for 2-4 sentences per paragraph.",
    targetCharacters: 17000,
    minCharacters: 14000,
    maxCharacters: 22000,
    maxTokens: 12288,
  },
};

const formatCount = (value: number): string => value.toLocaleString();

export const SUMMARY_LENGTH_TO_TOKENS: Record<SummaryLength, number> = Object.fromEntries(
  Object.entries(SUMMARY_LENGTH_SPECS).map(([key, spec]) => [key, spec.maxTokens]),
) as Record<SummaryLength, number>;

export const SUMMARY_LENGTH_TARGET_CHARACTERS: Record<SummaryLength, number> = Object.fromEntries(
  Object.entries(SUMMARY_LENGTH_SPECS).map(([key, spec]) => [key, spec.targetCharacters]),
) as Record<SummaryLength, number>;

export const SUMMARY_LENGTH_MAX_CHARACTERS: Record<SummaryLength, number> = Object.fromEntries(
  Object.entries(SUMMARY_LENGTH_SPECS).map(([key, spec]) => [key, spec.maxCharacters]),
) as Record<SummaryLength, number>;

export function resolveSummaryLengthSpec(length: SummaryLength): SummaryLengthSpec {
  return SUMMARY_LENGTH_SPECS[length];
}

export function formatPresetLengthGuidance(length: SummaryLength): string {
  const spec = resolveSummaryLengthSpec(length);
  return `Target length: around ${formatCount(spec.targetCharacters)} characters (acceptable range ${formatCount(spec.minCharacters)}-${formatCount(spec.maxCharacters)}). This is a soft guideline; prioritize clarity.`;
}
