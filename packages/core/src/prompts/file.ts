import type { OutputLanguage } from "../language.js";
import { formatOutputLanguageInstruction } from "../language.js";
import { buildInstructions, buildTaggedPrompt, type PromptOverrides } from "./format.js";
import { pickSummaryLengthForCharacters, type SummaryLengthTarget } from "./link-summary.js";
import { formatPresetLengthGuidance, resolveSummaryLengthSpec } from "./summary-lengths.js";

type FilePromptOptions = Pick<
  PromptOverrides,
  "promptOverride" | "lengthInstruction" | "languageInstruction"
> & {
  filename: string | null;
  summaryLength: SummaryLengthTarget;
  outputLanguage?: OutputLanguage | null;
};

type AttachedFileOptions = FilePromptOptions & {
  mediaType: string | null;
  contentLength?: number | null;
};

type FileTextOptions = FilePromptOptions & {
  originalMediaType: string | null;
  contentMediaType: string;
  contentLength: number;
  content?: string | null;
};

function buildFilePrompt(
  input: (AttachedFileOptions & { kind: "attached" }) | (FileTextOptions & { kind: "text" }),
): string {
  const {
    filename,
    summaryLength,
    outputLanguage,
    promptOverride,
    lengthInstruction,
    languageInstruction,
  } = input;
  const isText = input.kind === "text";
  const mediaType = isText ? input.originalMediaType : input.mediaType;
  const shouldIgnoreSponsors = Boolean(
    mediaType?.startsWith("audio/") || mediaType?.startsWith("video/"),
  );
  const contentCharacters = typeof input.contentLength === "number" ? input.contentLength : null;
  const effectiveSummaryLength =
    typeof summaryLength !== "string" &&
    contentCharacters !== null &&
    (isText || contentCharacters > 0) &&
    summaryLength.maxCharacters > contentCharacters
      ? { maxCharacters: contentCharacters }
      : summaryLength;
  const preset =
    typeof effectiveSummaryLength === "string"
      ? effectiveSummaryLength
      : pickSummaryLengthForCharacters(effectiveSummaryLength.maxCharacters);
  const directive = resolveSummaryLengthSpec(preset);
  const contentLengthLine =
    contentCharacters !== null && (isText || contentCharacters > 0)
      ? `Extracted content length: ${contentCharacters.toLocaleString()} characters. Hard limit: never exceed this length. If the requested length is larger, do not pad—finish early rather than adding filler.`
      : "";
  const headerLines = [
    filename ? `Filename: ${filename}` : null,
    mediaType ? `${isText ? "Original media type" : "Media type"}: ${mediaType}` : null,
    ...(isText ? [`Provided as: ${input.contentMediaType}`, contentLengthLine] : []),
  ].filter(Boolean);

  const baseInstructions = [
    "Hard rules: never mention sponsor/ads; never output quotation marks of any kind (straight or curly), even for titles.",
    "Never include quotation marks in the output. Apostrophes in contractions are OK. If a title or excerpt would normally use quotes, remove them and optionally italicize the text instead.",
    "You summarize files for curious users.",
    isText ? "Summarize the file content below." : "Summarize the attached file.",
    "Be factual and do not invent details.",
    shouldIgnoreSponsors
      ? "Omit sponsor messages, ads, promos, and calls-to-action (including podcast ad reads), even if they appear in the transcript. Do not mention or acknowledge them, and do not say you skipped or ignored anything. Avoid sponsor/ad/promo language, brand names like Squarespace, or CTA phrases like discount code."
      : "",
    directive.guidance,
    directive.formatting,
    "Format the answer in Markdown.",
    "Use short paragraphs; use bullet lists only when they improve scanability; avoid rigid templates.",
    "If a standout line is present, include 1-2 short exact excerpts (max 25 words each) formatted as Markdown italics using single asterisks only. Do not use quotation marks of any kind (straight or curly). Remove any quotation marks from excerpts. If you cannot format an italic excerpt, omit it. Never include ad/sponsor/boilerplate excerpts and do not mention them.",
    "Do not use emojis.",
    typeof effectiveSummaryLength === "string" ? formatPresetLengthGuidance(preset) : "",
    typeof effectiveSummaryLength === "string"
      ? ""
      : `Target length: up to ${effectiveSummaryLength.maxCharacters.toLocaleString()} characters total (including Markdown and whitespace). Hard limit: do not exceed it.`,
    isText ? "" : contentLengthLine,
    formatOutputLanguageInstruction(outputLanguage ?? { kind: "auto" }),
    "Final check: remove any sponsor/ad references or mentions of skipping/ignoring content. Remove any quotation marks. Ensure standout excerpts are italicized; otherwise omit them.",
    "Return only the summary.",
  ]
    .filter((line) => typeof line === "string" && line.trim().length > 0)
    .join("\n");

  return buildTaggedPrompt({
    instructions: buildInstructions({
      base: baseInstructions,
      overrides: { promptOverride, lengthInstruction, languageInstruction },
    }),
    context: headerLines.join("\n"),
    content: isText && typeof input.content === "string" ? input.content : "",
  });
}

export function buildFileSummaryPrompt(options: AttachedFileOptions): string {
  return buildFilePrompt({ ...options, kind: "attached" });
}

export function buildFileTextSummaryPrompt(options: FileTextOptions): string {
  return buildFilePrompt({ ...options, kind: "text" });
}
