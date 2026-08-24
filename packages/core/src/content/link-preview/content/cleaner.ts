const WORD_SPLIT_PATTERN = /\s+/g;

export interface ContentBudgetResult {
  content: string;
  truncated: boolean;
  totalCharacters: number;
  wordCount: number;
}

export function normalizeForPrompt(input: string): string {
  return stripInvisibleUnicode(input)
    .replaceAll("\u00A0", " ")
    .replaceAll(/[\t ]+/g, " ")
    .replaceAll(/\s*\n\s*/g, "\n")
    .replaceAll(/\n{3,}/g, "\n\n")
    .trim();
}

export function normalizeWhitespace(input: string): string {
  return stripInvisibleUnicode(input)
    .replaceAll("\u00A0", " ")
    .replaceAll(/[\t ]+/g, " ")
    .replaceAll(/\s*\n\s*/g, "\n")
    .trim();
}

const HTML_ENTITIES: Record<string, string> = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&#39;": "'",
  "&#x27;": "'",
  "&#x2F;": "/",
  "&nbsp;": " ",
};

// Decode in a single pass. Chained replaceAll calls decoded "&amp;" first, so a
// single-escaped "&amp;lt;" became "&lt;" and the next call decoded it again to "<".
export function decodeHtmlEntities(input: string): string {
  return input.replaceAll(
    /&(?:amp|lt|gt|quot|nbsp|#39|#x27|#x2F);/g,
    (entity) => HTML_ENTITIES[entity] ?? entity,
  );
}

export function stripInvisibleUnicode(input: string): string {
  return input.replaceAll(
    /[\u200B-\u200F\u202A-\u202E\u2060-\u2069\uFEFF\u{E0000}-\u{E007F}]/gu,
    "",
  );
}

export function normalizeCandidate(value: string | null | undefined): string | null {
  if (!value) {
    return null;
  }
  const trimmed = value.replaceAll(/\s+/g, " ").trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function clipAtSentenceBoundary(input: string, maxLength: number): string {
  if (input.length <= maxLength) {
    return input;
  }
  const slice = input.slice(0, maxLength);
  const lastSentenceBreak = Math.max(
    slice.lastIndexOf(". "),
    slice.lastIndexOf("! "),
    slice.lastIndexOf("? "),
    slice.lastIndexOf("\n\n"),
  );
  if (lastSentenceBreak > maxLength * 0.5) {
    return slice.slice(0, lastSentenceBreak + 1);
  }
  return slice;
}

export function applyContentBudget(
  baseContent: string,
  maxCharacters: number,
): ContentBudgetResult {
  const totalCharacters = baseContent.length;
  const truncated = totalCharacters > maxCharacters;
  const clipped = truncated ? clipAtSentenceBoundary(baseContent, maxCharacters) : baseContent;
  const content = clipped.trim();
  const wordCount =
    content.length > 0
      ? content.split(WORD_SPLIT_PATTERN).filter((part) => part.length > 0).length
      : 0;
  return { content, truncated, totalCharacters, wordCount };
}
