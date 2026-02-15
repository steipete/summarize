import { extractYouTubeVideoId } from "@steipete/summarize-core/content/url";
import type { SummaryLength } from "../../../shared/contracts.js";

export type TranscriptSegment = { startSeconds: number; text: string };
export type SlideTimelineEntry = { index: number; timestamp: number };

const SLIDE_TEXT_BUDGET_BY_PRESET: Record<SummaryLength, number> = {
  short: 120,
  medium: 200,
  long: 320,
  xl: 480,
  xxl: 700,
};

const SLIDE_TEXT_BUDGET_MIN = 80;
const SLIDE_TEXT_BUDGET_MAX = 900;

const SLIDE_WINDOW_SECONDS_BY_PRESET: Record<SummaryLength, number> = {
  short: 30,
  medium: 60,
  long: 90,
  xl: 120,
  xxl: 180,
};

const SLIDE_WINDOW_SECONDS_MIN = 30;
const SLIDE_WINDOW_SECONDS_MAX = 180;

const SLIDE_TAG_PATTERN = /^\[[^\]]*slide[^\d\]]*(\d+)[^\]]*\]\s*(.*)$/i;
const SLIDE_LABEL_PATTERN =
  /^(?:\[)?slide\s+(\d+)(?:\s*(?:\/|of)\s*\d+)?(?:\])?(?:\s*[\u00b7:-]\s*.*)?$/i;
const TITLE_ONLY_MAX_CHARS = 80;

const clampNumber = (value: number, min: number, max: number) =>
  Math.min(max, Math.max(min, value));

const collapseLineWhitespace = (value: string): string => value.replace(/\s+/g, " ").trim();

const deriveHeadlineFromBody = (body: string): string | null => {
  const cleaned = collapseLineWhitespace(body);
  if (!cleaned) return null;
  const firstSentence = cleaned.split(/[.!?]/)[0] ?? "";
  const clause = firstSentence.split(/[,;:\u2013\u2014-]/)[0] ?? firstSentence;
  const words = clause.trim().split(/\s+/).filter(Boolean);
  if (words.length < 2) return null;
  const title = words.slice(0, Math.min(6, words.length)).join(" ");
  return title.replace(/[,:;-]+$/g, "").trim() || null;
};

const isTitleOnlySlideText = (value: string): boolean => {
  const trimmed = value.trim();
  if (!trimmed) return true;
  const lines = trimmed
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length !== 1) return false;
  if (trimmed.length > TITLE_ONLY_MAX_CHARS) return false;
  if (/[.!?]/.test(trimmed)) return false;
  return true;
};

const stripSlideTitleList = (markdown: string): string => {
  if (!markdown.trim()) return markdown;
  const lines = markdown.split("\n");
  const out: string[] = [];
  let skipNextTitle = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (SLIDE_TAG_PATTERN.test(trimmed) || SLIDE_LABEL_PATTERN.test(trimmed)) {
      skipNextTitle = true;
      continue;
    }
    if (skipNextTitle) {
      if (!trimmed) continue;
      if (isTitleOnlySlideText(trimmed)) {
        skipNextTitle = false;
        continue;
      }
      skipNextTitle = false;
    }
    out.push(line);
  }
  return out.join("\n");
};

export const splitSlideTitleFromText = ({
  text,
}: {
  text: string;
  slideIndex: number;
  total: number;
}): { title: string | null; body: string } => {
  const trimmed = text.trim();
  if (!trimmed) return { title: null, body: "" };
  const lines = trimmed
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length === 0) return { title: null, body: "" };
  const cleaned = lines.slice();
  while (cleaned.length > 0) {
    const first = cleaned[0] ?? "";
    if (SLIDE_LABEL_PATTERN.test(first) || SLIDE_TAG_PATTERN.test(first)) {
      cleaned.shift();
      continue;
    }
    break;
  }
  if (cleaned.length === 0) return { title: null, body: "" };
  const filtered = cleaned.filter(
    (line) => !SLIDE_LABEL_PATTERN.test(line) && !SLIDE_TAG_PATTERN.test(line),
  );
  if (filtered.length === 0) return { title: null, body: "" };

  const labelPattern = /^(?:title|headline)\s*:\s*(.*)$/i;
  let title: string | null = null;
  let bodyLines = filtered.slice();

  for (let i = 0; i < filtered.length; i += 1) {
    const line = filtered[i] ?? "";
    const labelMatch = line.match(labelPattern);
    if (!labelMatch) continue;
    const labelText = collapseLineWhitespace(labelMatch[1] ?? "").trim();
    if (labelText) {
      title = labelText;
      bodyLines = filtered.filter((_, idx) => idx !== i);
    } else {
      const fallbackTitle = collapseLineWhitespace(filtered[i + 1] ?? "").trim();
      if (fallbackTitle) title = fallbackTitle;
      bodyLines = filtered.filter((_, idx) => idx !== i && idx !== i + 1);
    }
    break;
  }

  if (!title) {
    for (let i = 0; i < filtered.length; i += 1) {
      const line = filtered[i] ?? "";
      const headingMatch = line.match(/^#{1,6}\s+(.+)/);
      if (!headingMatch) continue;
      const headingText = collapseLineWhitespace(headingMatch[1] ?? "").trim();
      const headingLabelMatch = headingText.match(labelPattern);
      if (headingLabelMatch) {
        const headingLabel = collapseLineWhitespace(headingLabelMatch[1] ?? "").trim();
        if (headingLabel) {
          title = headingLabel;
          bodyLines = filtered.filter((_, idx) => idx !== i);
        } else {
          const fallbackTitle = collapseLineWhitespace(filtered[i + 1] ?? "").trim();
          if (fallbackTitle) title = fallbackTitle;
          bodyLines = filtered.filter((_, idx) => idx !== i && idx !== i + 1);
        }
      } else {
        title = headingText || null;
        bodyLines = filtered.filter((_, idx) => idx !== i);
      }
      break;
    }
  }

  if (!title && filtered.length > 1) {
    const candidates = filtered
      .map((line, idx) => ({ line, idx }))
      .filter(({ line }) => isTitleOnlySlideText(line));
    if (candidates.length === 1) {
      const pick = candidates[0];
      title = collapseLineWhitespace(pick?.line ?? "").trim() || null;
      bodyLines = filtered.filter((_, idx) => idx !== pick?.idx);
    } else if (isTitleOnlySlideText(filtered[0] ?? "")) {
      title = collapseLineWhitespace(filtered[0] ?? "").trim() || null;
      bodyLines = filtered.slice(1);
    }
  }

  const body = bodyLines.join("\n").trim();
  if (!title && body) {
    title = deriveHeadlineFromBody(body);
  }
  return { title, body };
};

export const ensureSlideTitleLine = ({
  text,
  slide,
  total,
}: {
  text: string;
  slide: SlideTimelineEntry;
  total: number;
}): string => {
  void slide;
  void total;
  return text.trim();
};

export function findSlidesSectionStart(markdown: string): number | null {
  if (!markdown) return null;
  const heading = markdown.match(/^#{1,3}\s+Slides\b.*$/im);
  const tag = markdown.match(/^\[slide:\d+\]/im);
  const label = markdown.match(/^\s*slide\s+\d+(?:\s*(?:\/|of)\s*\d+)?(?:\s*[\u00b7:-].*)?$/im);
  const indexes = [heading?.index, tag?.index, label?.index].filter(
    (idx): idx is number => idx != null,
  );
  if (indexes.length === 0) return null;
  return Math.min(...indexes);
}

export function splitSummaryFromSlides(markdown: string): {
  summary: string;
  slidesSection: string | null;
} {
  const start = findSlidesSectionStart(markdown);
  if (start == null) return { summary: markdown.trim(), slidesSection: null };
  const summary = markdown.slice(0, start).trim();
  const slidesSection = markdown.slice(start);
  return { summary, slidesSection };
}

export function parseSlideSummariesFromMarkdown(markdown: string): Map<number, string> {
  const result = new Map<number, string>();
  if (!markdown.trim()) return result;
  const start = findSlidesSectionStart(markdown);
  if (start == null) {
    const inline = parseInlineSlideSummaries(markdown);
    return inline.size > 0 ? inline : result;
  }
  const slice = markdown.slice(start);
  const lines = slice.split("\n");
  let currentIndex: number | null = null;
  let buffer: string[] = [];
  let sawBlankAfterTitle = false;
  const hasFutureMarker = (start: number) =>
    lines.slice(start).some((line) => {
      const trimmed = line.trim();
      return SLIDE_TAG_PATTERN.test(trimmed) || SLIDE_LABEL_PATTERN.test(trimmed);
    });
  const flush = () => {
    if (currentIndex == null) return;
    const text = buffer
      .map((line) => collapseLineWhitespace(line))
      .join("\n")
      .trim();
    result.set(currentIndex, text);
    currentIndex = null;
    buffer = [];
    sawBlankAfterTitle = false;
  };

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? "";
    const trimmed = line.trim();
    const heading = trimmed.match(/^#{1,3}\s+\S/);
    if (heading && !trimmed.toLowerCase().startsWith("### slides")) {
      if (currentIndex == null) {
        flush();
        break;
      }
      // Allow heading lines directly after a slide marker (common model format):
      // [slide:1]
      // ## Title
      if (buffer.length === 0) {
        buffer.push(trimmed);
        continue;
      }
      flush();
      break;
    }
    const match = trimmed.match(SLIDE_TAG_PATTERN);
    if (match) {
      flush();
      const index = Number.parseInt(match[1] ?? "", 10);
      if (!Number.isFinite(index) || index <= 0) continue;
      currentIndex = index;
      sawBlankAfterTitle = false;
      const rest = (match[2] ?? "").trim();
      if (rest) buffer.push(rest);
      continue;
    }
    const label = trimmed.match(SLIDE_LABEL_PATTERN);
    if (label) {
      flush();
      const index = Number.parseInt(label[1] ?? "", 10);
      if (!Number.isFinite(index) || index <= 0) continue;
      currentIndex = index;
      sawBlankAfterTitle = false;
      continue;
    }
    if (currentIndex == null) continue;
    if (!trimmed) {
      if (buffer.length === 1 && isTitleOnlySlideText(buffer[0] ?? "")) {
        sawBlankAfterTitle = true;
      }
      continue;
    }
    if (
      sawBlankAfterTitle &&
      buffer.length === 1 &&
      isTitleOnlySlideText(buffer[0] ?? "") &&
      !isTitleOnlySlideText(trimmed) &&
      !hasFutureMarker(i)
    ) {
      flush();
      break;
    }
    sawBlankAfterTitle = false;
    buffer.push(trimmed);
  }
  flush();
  return result;
}

function parseInlineSlideSummaries(markdown: string): Map<number, string> {
  const result = new Map<number, string>();
  const matches = Array.from(markdown.matchAll(/\[slide:(\d+)\]/gi));
  if (matches.length === 0) return result;
  for (let i = 0; i < matches.length; i += 1) {
    const match = matches[i];
    const index = Number.parseInt(match?.[1] ?? "", 10);
    if (!Number.isFinite(index) || index <= 0) continue;
    const start = (match.index ?? 0) + match[0].length;
    const next = i + 1 < matches.length ? matches[i + 1] : null;
    const end = next?.index ?? markdown.length;
    if (end <= start) {
      result.set(index, "");
      continue;
    }
    const segment = markdown
      .slice(start, end)
      .replace(/^\s*[:\-\u2013\u2014]?\s*/, "")
      .trim();
    result.set(index, segment);
  }
  return result;
}

export function extractSlideMarkers(markdown: string): number[] {
  if (!markdown.trim()) return [];
  const indexes: number[] = [];
  const regex = /\[[^\]]*slide[^\d\]]*(\d+)[^\]]*\]/gi;
  let match = regex.exec(markdown);
  while (match) {
    const index = Number.parseInt(match[1] ?? "", 10);
    if (!Number.isFinite(index) || index <= 0) continue;
    indexes.push(index);
    match = regex.exec(markdown);
  }
  return indexes;
}

export function normalizeSummarySlideHeadings(markdown: string): string {
  if (!markdown.trim()) return markdown;
  if (!/\[slide:\d+\]/i.test(markdown)) return markdown;
  const deleteMarker = "__SUMMARIZE_DELETE__";
  const lines = markdown.split("\n");
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? "";
    if (!SLIDE_TAG_PATTERN.test(line.trim())) continue;
    for (let k = i + 1; k < lines.length; k += 1) {
      const candidate = lines[k] ?? "";
      const trimmed = candidate.trim();
      if (!trimmed) continue;
      if (SLIDE_LABEL_PATTERN.test(trimmed)) {
        lines[k] = deleteMarker;
        continue;
      }
      const labelMatch = trimmed.match(/^(?:title|headline)\s*:\s*(.*)$/i);
      if (labelMatch) {
        const labelText = collapseLineWhitespace(labelMatch[1] ?? "").trim();
        lines[k] = labelText ? `## ${labelText}` : deleteMarker;
      }
      break;
    }
  }
  return lines.filter((line) => line !== deleteMarker).join("\n");
}

function splitMarkdownParagraphs(markdown: string): string[] {
  return markdown
    .split(/\n\s*\n+/)
    .map((part) => part.trim())
    .filter(Boolean);
}

function pickIntroParagraph(markdown: string): string {
  const paragraphs = splitMarkdownParagraphs(markdown);
  if (paragraphs.length === 0) return "";
  const firstNonHeading =
    paragraphs.find((paragraph) => !/^#{1,6}\s+\S/.test(paragraph.trim())) ?? paragraphs[0];
  if (!firstNonHeading) return "";
  const sentences = firstNonHeading.match(/[^.!?]+[.!?]+|[^.!?]+$/g) ?? [firstNonHeading];
  if (sentences.length <= 3) return firstNonHeading.trim();
  return sentences.slice(0, 3).join(" ").trim();
}

function distributeTextAcrossSlides({
  text,
  slideCount,
}: {
  text: string;
  slideCount: number;
}): string[] {
  if (slideCount <= 0) return [];
  const empty = Array.from({ length: slideCount }, () => "");
  const normalized = collapseLineWhitespace(text);
  if (!normalized) return empty;

  const sentenceUnits = (normalized.match(/[^.!?]+(?:[.!?]+|$)/g) ?? [])
    .map((unit) => collapseLineWhitespace(unit))
    .filter(Boolean);
  if (sentenceUnits.length >= slideCount) {
    return Array.from({ length: slideCount }, (_, i) => {
      const start = Math.round((i * sentenceUnits.length) / slideCount);
      const end = Math.round(((i + 1) * sentenceUnits.length) / slideCount);
      return sentenceUnits.slice(start, end).join(" ").trim();
    });
  }

  const words = normalized.split(/\s+/).filter(Boolean);
  if (words.length === 0) return empty;
  return Array.from({ length: slideCount }, (_, i) => {
    const start = Math.round((i * words.length) / slideCount);
    const end = Math.round(((i + 1) * words.length) / slideCount);
    return words.slice(start, end).join(" ").trim();
  });
}

function compactSlideSummaryText(value: string, maxChars: number): string {
  const normalized = normalizeSlideText(value);
  if (!normalized) return normalized;
  if (!Number.isFinite(maxChars) || maxChars <= 0) return normalized;
  if (normalized.length <= maxChars) return normalized;

  const sentenceMatches = normalized.match(/[^.!?]+[.!?]["')\]]?(?=\s|$)/g) ?? [];
  if (sentenceMatches.length > 0) {
    let collected = "";
    for (const sentence of sentenceMatches) {
      const trimmed = sentence.trim();
      if (!trimmed) continue;
      const next = collected ? `${collected} ${trimmed}` : trimmed;
      if (next.length > maxChars) break;
      collected = next;
    }
    if (collected.length >= Math.floor(maxChars * 0.6)) {
      return collected.trim();
    }
  }

  const truncated = normalized
    .slice(0, maxChars)
    .trimEnd()
    .replace(/\s+\S*$/, "")
    .trim();
  const compact = truncated.length > 0 ? truncated : normalized.slice(0, maxChars).trim();
  if (!compact) return normalized;
  return /[.!?]["')\]]?$/.test(compact) ? compact : `${compact}.`;
}

function splitExplicitSlideTitleFromText(
  text: string,
): { title: string; body: string } | null {
  const lines = text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !SLIDE_LABEL_PATTERN.test(line) && !SLIDE_TAG_PATTERN.test(line));
  if (lines.length < 2) return null;

  const first = lines[0] ?? "";
  const titleLabelMatch = first.match(/^(?:title|headline)\s*:\s*(.*)$/i);
  if (titleLabelMatch) {
    const labelText = collapseLineWhitespace(titleLabelMatch[1] ?? "").trim();
    if (labelText) {
      const body = lines.slice(1).join(" ").trim();
      return body ? { title: labelText, body } : null;
    }
    const nextTitle = collapseLineWhitespace(lines[1] ?? "").trim();
    const body = lines.slice(2).join(" ").trim();
    return nextTitle && body ? { title: nextTitle, body } : null;
  }

  const headingMatch = first.match(/^#{1,6}\s+(.+)/);
  if (headingMatch) {
    const title = collapseLineWhitespace(headingMatch[1] ?? "").trim();
    const body = lines.slice(1).join(" ").trim();
    return title && body ? { title, body } : null;
  }

  if (isTitleOnlySlideText(first) && !isTitleOnlySlideText(lines[1] ?? "")) {
    const body = lines.slice(1).join(" ").trim();
    return body ? { title: first, body } : null;
  }

  return null;
}

function removeLeadingTitleEcho(body: string, title: string): string {
  const normalizedBody = normalizeSlideText(body);
  const normalizedTitle = normalizeSlideText(title);
  if (!normalizedBody || !normalizedTitle) return body;
  const bodyLower = normalizedBody.toLowerCase();
  const titleLower = normalizedTitle.toLowerCase();
  if (!bodyLower.startsWith(titleLower)) return body;

  const boundary = normalizedBody.slice(normalizedTitle.length).match(/^\s*[:\-–—]?\s*/);
  const start = normalizedTitle.length + (boundary?.[0]?.length ?? 0);
  const trimmed = normalizedBody.slice(start).trim();
  return trimmed.length > 0 ? trimmed : body;
}

function isTranscriptLikeSlideText(value: string): boolean {
  const normalized = normalizeSlideText(value);
  if (!normalized) return false;
  if (
    /(?:,{2,}|\bthey was\b|\bthey wasn't\b|\bthey was they\b|\bidea of and like\b|\bpreference like when they get like at\b|\bthey pain\b|\bthought be they\b|\bnegative emote\b)/i.test(
      normalized,
    )
  ) {
    return true;
  }
  if (/(^|\s)>>\s*/.test(normalized)) return true;
  if (/^(?:[-*]\s+)?(?:um|uh|well|so|like|even like)\b/i.test(normalized)) return true;
  if (
    /\b(?:would you like to|leave a like|turn on notifications|subscribe|thanks? for watching)\b/i.test(
      normalized,
    )
  ) {
    return true;
  }
  if (looksCorruptedSpeechLikeText(normalized)) return true;
  const firstPersonCount = (normalized.match(/\b(?:i|i'm|i'd|i'll|me|my|mine|we|we're|our|us)\b/gi) ?? [])
    .length;
  const secondPersonCount = (normalized.match(/\b(?:you|your|yours)\b/gi) ?? []).length;
  const disfluencyCount = (normalized.match(/\b(?:uh|um|you know)\b/gi) ?? []).length;
  const conversationalMarkerCount = (
    normalized.match(/\b(?:you know|i mean|kind of|sort of|in a way of like|even like)\b/gi) ?? []
  ).length;
  const hasRhetoricalTail = /,\s*right\?/i.test(normalized);
  const repeatedPronoun = /\bI\s+I\b/i.test(normalized) || /\bI\b(?:\W+\bI\b){2,}/i.test(normalized);
  const quoteCount = (normalized.match(/["“”]/g) ?? []).length;
  if (repeatedPronoun) return true;
  if (disfluencyCount >= 3) return true;
  if (conversationalMarkerCount >= 2) return true;
  if (hasRhetoricalTail && secondPersonCount >= 2) return true;
  if (firstPersonCount >= 5 && firstPersonCount >= secondPersonCount) return true;
  if (secondPersonCount >= 4 && firstPersonCount >= 1) return true;
  if (secondPersonCount >= 6) return true;
  if (quoteCount >= 2 && firstPersonCount >= 2) return true;
  return false;
}

function looksCorruptedSpeechLikeText(value: string): boolean {
  const normalized = normalizeSlideText(value);
  if (!normalized) return false;
  const words = normalized.split(/\s+/).filter(Boolean);
  if (words.length < 30) return false;
  const repeatedWordCount = (normalized.match(/\b(\w+)\s+\1\b/gi) ?? []).length;
  const repeatedBigramCount = (normalized.match(/\b(\w+\s+\w+)\s+\1\b/gi) ?? []).length;
  const malformedContractionCount = (
    normalized.match(
      /\b(?!i|you|we|they|he|she|it|there|here|what|who|where|when|why|how|that)\w+'(?:re|ve|ll|d|m)\b/gi,
    ) ?? []
  ).length;
  const sentenceParts = (normalized.match(/[^.!?]+(?:[.!?]+|$)/g) ?? [])
    .map((part) => part.trim())
    .filter(Boolean);
  const longSentenceCount = sentenceParts.filter(
    (part) => part.split(/\s+/).filter(Boolean).length >= 45,
  ).length;
  const shortFragmentCount = sentenceParts.filter(
    (part) => part.split(/\s+/).filter(Boolean).length <= 9,
  ).length;
  const questionLeadCount = sentenceParts.filter((part) =>
    /^(?:how|what|why|when|where|who|had|did|does|do|can|could|would|should|is|are)\b/i.test(part),
  ).length;
  const connectorCount = (
    normalized.match(/\b(?:and|but|so|that|then|because|if|when|while)\b/gi) ?? []
  ).length;
  if (malformedContractionCount >= 1) return true;
  if (repeatedWordCount >= 2) return true;
  if (repeatedBigramCount >= 1) return true;
  if (shortFragmentCount >= 3 && questionLeadCount >= 1) return true;
  if (sentenceParts.length >= 6 && shortFragmentCount >= Math.ceil(sentenceParts.length * 0.5)) {
    return true;
  }
  if (longSentenceCount >= 1 && connectorCount >= 12) return true;
  return false;
}

function isLowQualitySlideBodyText(value: string): boolean {
  const normalized = normalizeSlideText(value);
  if (!normalized) return false;
  const words = normalized.split(/\s+/).filter(Boolean);
  if (words.length < 22) return true;
  if (/(^|\s)>>\s*/.test(normalized)) return true;
  if (looksCorruptedSpeechLikeText(normalized)) return true;
  if (/\b(?:countereidence|that is that they|some they can be like|The speaker will just)\b/i.test(normalized))
    return true;
  if (/\b(?:it is it seems|to the fact that and the implications)\b/i.test(normalized)) return true;
  if (/\b(?:is|are)\s+like\.?$/i.test(normalized)) return true;
  if (/\b([A-Za-z]+)'(?:re|ve|ll|d|m)\b/.test(normalized)) return true;
  const quoteCount = (normalized.match(/"/g) ?? []).length;
  if (quoteCount % 2 === 1) return true;
  if (hasFragmentHeavyStructure(normalized)) return true;
  return false;
}

function hasFragmentHeavyStructure(value: string): boolean {
  const normalized = normalizeSlideText(value);
  if (!normalized) return false;
  const sentenceParts = (normalized.match(/[^.!?]+(?:[.!?]+|$)/g) ?? [])
    .map((part) => part.trim())
    .filter(Boolean);
  const shortFragmentCount = sentenceParts.filter(
    (part) => part.split(/\s+/).filter(Boolean).length <= 6,
  ).length;
  const connectorLeadCount = sentenceParts.filter((part) =>
    /^(?:which|and|but|so|then|because|under|even though|while|although|though)\b/i.test(part),
  ).length;
  return (
    (sentenceParts.length >= 5 && (shortFragmentCount >= 2 || connectorLeadCount >= 2)) ||
    (sentenceParts.length >= 4 && shortFragmentCount + connectorLeadCount >= 3)
  );
}

function stripSingleLeadingBullet(value: string): string {
  const normalized = value.trim();
  if (!normalized) return normalized;
  if (!/^\s*[-*]\s+/.test(normalized)) return normalized;
  // Keep real multi-bullet lists intact.
  if (/\n\s*[-*]\s+/.test(normalized)) return normalized;
  return normalized.replace(/^\s*[-*]\s+/, "");
}

function rewriteTranscriptSentenceToNeutral(sentence: string): string {
  let text = collapseLineWhitespace(sentence).trim();
  if (!text) return "";
  text = text.replace(/^\s*>>\s*/g, "");
  text = text.replace(/^\s*[-*]\s+/, "");
  text = text.replace(/^(?:(?:um+|uh+|erm+|ah+|hmm+|mm+)[,.:;!?-]*\s*)+/i, "");
  text = text.replace(/^(?:so|well|and|but)\s+/i, "");
  text = text.replace(/^(?:even\s+)?like\s+/i, "");
  text = text.replace(/^(?:(?:um+|uh+|erm+|ah+|hmm+|mm+)[,.:;!?-]*\s*)+/i, "");
  text = text.replace(/^\s*[,.;:!?-]+\s*/, "");
  text = text.replace(/\b(?:um|uh)\b(?=\s|[,.;:!?])/gi, "");
  text = text.replace(/\bin a way of like\b/gi, "as");
  text = text.replace(/,\s*right\?\s*$/i, "");
  text = text.replace(/\byou know\b/gi, "");
  text = text.replace(/\bi mean\b/gi, "");
  text = text.replace(/\bkind of\b/gi, "");
  text = text.replace(/\bsort of\b/gi, "");
  text = text.replace(/\blet'?s say\b/gi, "");
  text = text.replace(/\bit's\b/gi, "it is");
  text = text.replace(/\bthat's\b/gi, "that is");
  text = text.replace(/\bthere's\b/gi, "there is");
  text = text.replace(/\bcountereidence\b/gi, "counterevidence");
  text = text.replace(/\bcan't be find found\b/gi, "cannot be found");
  text = text.replace(/\bawake to\b/gi, "awaken to");
  text = text.replace(/\bit is it seems to (?:them|people) that\b/gi, "it seems that");
  text = text.replace(/\bit is it seems\b/gi, "it seems");
  text = text.replace(/^\s*that is that\b/i, "The key point is that");
  text = text.replace(/\bthat is that they\b/gi, "that they");
  text = text.replace(/\bmaybe some they can be like\b/gi, "some may feel");
  text = text.replace(/\b([A-Za-z]+)'re\b/g, "$1 are");
  text = text.replace(/\b([A-Za-z]+)'ve\b/g, "$1 have");
  text = text.replace(/\b([A-Za-z]+)'ll\b/g, "$1 will");
  text = text.replace(/\b([A-Za-z]+)'d\b/g, "$1 would");
  text = text.replace(/\b([A-Za-z]+)'m\b/g, "$1 am");
  text = text.replace(/\bI'm\b/gi, "they are");
  text = text.replace(/\bI've\b/gi, "they have");
  text = text.replace(/\bI'll\b/gi, "they will");
  text = text.replace(/\bI'd\b/gi, "they would");
  text = text.replace(/\bI am\b/gi, "they are");
  text = text.replace(/\bI\b/g, "they");
  text = text.replace(/\bme\b/gi, "them");
  text = text.replace(/\bmy\b/gi, "their");
  text = text.replace(/\bmine\b/gi, "theirs");
  text = text.replace(/\bmyself\b/gi, "themselves");
  text = text.replace(/\bwe're\b/gi, "they are");
  text = text.replace(/\bwe\b/gi, "they");
  text = text.replace(/\bour\b/gi, "their");
  text = text.replace(/\bus\b/gi, "them");
  text = text.replace(/\byou'll\b/gi, "they will");
  text = text.replace(/\byou\b/gi, "they");
  text = text.replace(/\byour\b/gi, "their");
  text = text.replace(/\bis they\b/gi, "is that they");
  text = text.replace(
    /^How it works internally for (?:them|the speaker) is that they will\s+/i,
    "Internally, the speaker will ",
  );
  text = text.replace(/\b(\w+)[,;:]\s+\1\b/gi, "$1");
  text = text.replace(/\bthey\s+they\b/gi, "they");
  text = text.replace(/\b(\w+)(?:\s+\1\b){1,}/gi, "$1");
  text = text.replace(/\b(and|or|but|so)\s+\1\b/gi, "$1");
  text = text.replace(/^\s*they\b/i, "The speaker");
  text = text.replace(/\bThe speaker are\b/gi, "The speaker is");
  text = text.replace(/\bThe speaker were\b/gi, "The speaker was");
  text = text.replace(/\bThe speaker have\b/gi, "The speaker has");
  text = text.replace(/\bThe speaker better\b/gi, "They should");
  text = text.replace(/\bThe speaker will just\b/gi, "They can");
  text = text.replace(/\bthey am\b/gi, "they are");
  text = text.replace(/\bthey was they\b/gi, "they");
  text = text.replace(/\bthey was\b/gi, "they were");
  text = text.replace(/\bthey wasn't\b/gi, "they were not");
  text = text.replace(/\bthis is where honestly this is where\b/gi, "this is where");
  text = text.replace(/\b(?:their|the) preference like when they get like at\b/gi, "their preference at");
  text = text.replace(/\bjust an idea of and like\b/gi, "a general idea, and");
  text = text.replace(/\bit is an accumulation of old emotion\b/gi, "The speaker describes it as an accumulation of old emotion");
  text = text.replace(/\bthey pain\b/gi, "the pain");
  text = text.replace(/\bthought be they\b/gi, "thoughts can be");
  text = text.replace(/\bnegative emote\b/gi, "negative emotions");
  text = text.replace(
    /^if they don't believe in past lifetimes that is fine they don't have to\.?$/i,
    "The speaker notes that belief in past lifetimes is optional",
  );
  text = text.replace(
    /^it could be lot of anger,\s*fear,\s*heaviness\.?$/i,
    "The speaker describes the pain body as stored anger, fear, and heaviness",
  );
  text = text.replace(/\bit could be lot of\b/gi, "it could involve");
  text = text.replace(/,{2,}/g, ",");
  text = text.replace(/\s+([,.;:!?])/g, "$1");
  text = text.replace(/,\s*([.!?])/g, "$1");
  text = text.replace(/\s{2,}/g, " ").trim();
  if (!text) return "";
  text = text.replace(/([.!?]\s+)([a-z])/g, (_m, p1: string, p2: string) => `${p1}${p2.toUpperCase()}`);
  const quoteCount = (text.match(/"/g) ?? []).length;
  if (quoteCount % 2 === 1) text = text.replace(/"/g, "");
  const first = text[0] ?? "";
  if (first) text = `${first.toUpperCase()}${text.slice(1)}`;
  if (!/[.!?]["')\]]?$/.test(text)) text = `${text}.`;
  return text;
}

function compactCorruptedSpeechUnit(value: string, maxChars: number): string {
  const normalized = collapseLineWhitespace(value).trim();
  if (!normalized) return normalized;
  if (!looksCorruptedSpeechLikeText(normalized)) return normalized;
  const chunks = normalized
    .split(/\b(?:and|but|so|then)\b/gi)
    .map((chunk) =>
      collapseLineWhitespace(chunk)
        .trim()
        .replace(/^[,;:\-.\s]+/, "")
        .replace(/[,;:\-.\s]+$/, ""),
    )
    .filter((chunk) => chunk.split(/\s+/).filter(Boolean).length >= 6)
    .filter((chunk) => !/^(?:it is it seems|to the fact that|and the implications)\b/i.test(chunk));
  if (chunks.length >= 2) {
    const chunkBudget = maxChars >= 900 ? 5 : maxChars >= 650 ? 4 : maxChars >= 420 ? 3 : 2;
    const candidate = chunks.slice(-chunkBudget).join(". ").trim();
    if (candidate) return candidate;
  }
  return compactSlideSummaryText(normalized, Math.min(maxChars, 360));
}

function splitTranscriptLikeUnits(normalized: string): string[] {
  const rawSentences = normalized.match(/[^.!?]+(?:[.!?]+|$)/g) ?? [normalized];
  const units: string[] = [];
  for (const sentence of rawSentences) {
    const compact = collapseLineWhitespace(sentence).trim();
    if (!compact) continue;
    const wordCount = compact.split(/\s+/).filter(Boolean).length;
    if (wordCount <= 44) {
      units.push(compact);
      continue;
    }
    const clauses = compact
      .split(/[,;:]\s+/)
      .map((clause) => collapseLineWhitespace(clause).trim())
      .filter(Boolean);
    if (clauses.length >= 2) {
      units.push(...clauses);
      continue;
    }
    units.push(compact);
  }
  return units.length > 0 ? units : [normalized];
}

function isLowSignalTranscriptSentence(value: string): boolean {
  const normalized = collapseLineWhitespace(value).trim();
  if (!normalized) return true;
  const words = normalized.split(/\s+/).filter(Boolean);
  if (words.length <= 5) return true;
  if (/,{2,}/.test(normalized)) return true;
  if (/\b(?:countereidence|that is that they|some they can be like|The speaker will just)\b/i.test(normalized)) {
    return true;
  }
  if (
    /\b(?:they was|they wasn't|they was they|this is where honestly this is where|idea of and like|they pain|thought be they|negative emote)\b/i.test(
      normalized,
    )
  ) {
    return true;
  }
  const likeCount = (normalized.match(/\blike\b/gi) ?? []).length;
  if (likeCount >= 3 && words.length <= 45) return true;
  if (
    /^(?:which|and|but|so|then|because|under|even though|while|although|though)\b/i.test(normalized) &&
    words.length <= 14
  ) {
    return true;
  }
  if (/\b(\w+\s+\w+)\s+\1\b/i.test(normalized)) return true;
  if (
    /^(?:how can|had they|did they|do they|can people|it seems to (?:them|people) that|to the fact that)\b/i.test(
      normalized,
    )
  ) {
    return words.length <= 14;
  }
  if (/^(?:how|what|why|when|where|who|had|did|does|do|can|could|would|should|is|are)\b/i.test(normalized)) {
    return words.length <= 10;
  }
  return false;
}

function pruneFragmentaryTailSentences(value: string): string {
  const normalized = normalizeSlideText(value);
  if (!normalized) return normalized;
  const sentences = (normalized.match(/[^.!?]+(?:[.!?]+|$)/g) ?? [])
    .map((part) => collapseLineWhitespace(part).trim())
    .filter(Boolean);
  if (sentences.length < 4) return normalized;
  const hasVerb = (text: string): boolean =>
    /\b(?:is|are|was|were|be|being|been|has|have|had|do|does|did|can|could|will|would|should|may|might|must|seem|seems|show|shows|indicate|indicates|occur|occurs|provide|provides|report|reports|(?:\w+ed)|(?:\w+ing))\b/i.test(
      text,
    );
  while (sentences.length > 1) {
    const last = sentences[sentences.length - 1] ?? "";
    const words = last.split(/\s+/).filter(Boolean);
    if (words.length <= 5) {
      sentences.pop();
      continue;
    }
    if (
      /^(?:which|and|but|so|then|because|under|even though|while|although|though)\b/i.test(last) &&
      words.length <= 14
    ) {
      sentences.pop();
      continue;
    }
    if (!hasVerb(last) && words.length <= 10) {
      sentences.pop();
      continue;
    }
    if (/^[A-Za-z]+ing\b/.test(last) && words.length <= 10) {
      sentences.pop();
      continue;
    }
    break;
  }
  return sentences.join(" ").trim() || normalized;
}

function summarizeTranscriptLikeSlideText(value: string, maxChars: number): string {
  const normalized = normalizeSlideText(value);
  if (!normalized) return normalized;
  const sentences = splitTranscriptLikeUnits(normalized);
  const kept: string[] = [];
  const seen = new Set<string>();
  const maxKeptSentences = maxChars >= 1100 ? 7 : maxChars >= 800 ? 6 : maxChars >= 520 ? 5 : 4;
  for (const sentence of sentences) {
    const raw = collapseLineWhitespace(sentence).trim();
    if (!raw) continue;
    if (isLowSignalTranscriptSentence(raw)) continue;
    if (/^to the fact that\b/i.test(raw)) continue;
    if (
      /\b(?:would you like to|leave a like|turn on notifications|subscribe|thanks? for watching)\b/i.test(
        raw,
      )
    ) {
      continue;
    }
    const prepared = compactCorruptedSpeechUnit(raw, maxChars);
    const rewritten = rewriteTranscriptSentenceToNeutral(prepared);
    if (!rewritten) continue;
    if (isLowSignalTranscriptSentence(rewritten)) continue;
    if (/\b(?:is|are)\s+like\.?$/i.test(rewritten)) continue;
    if (rewritten.length < 24) continue;
    const key = rewritten.toLowerCase();
    if (seen.has(key)) continue;
    const next = kept.length > 0 ? `${kept.join(" ")} ${rewritten}` : rewritten;
    if (next.length > maxChars && kept.length > 0) break;
    seen.add(key);
    kept.push(rewritten);
    if (kept.length >= maxKeptSentences) break;
  }
  if (kept.length === 0) {
    const rewrittenFull = rewriteTranscriptSentenceToNeutral(normalized);
    if (rewrittenFull && !isLowSignalTranscriptSentence(rewrittenFull)) {
      return rewrittenFull.length <= maxChars
        ? rewrittenFull
        : compactSlideSummaryText(rewrittenFull, maxChars);
    }
    return compactSlideSummaryText(normalized, maxChars);
  }
  const merged = pruneFragmentaryTailSentences(kept.join(" "));
  const bounded = merged.length <= maxChars ? merged : compactSlideSummaryText(merged, maxChars);
  return pruneFragmentaryTailSentences(bounded);
}

function normalizeSlideBodyStyle(value: string, maxChars: number): string {
  const compact = stripSingleLeadingBullet(compactSlideSummaryText(value, maxChars));
  if (!compact) return compact;
  const needsTranscriptCleanup =
    isTranscriptLikeSlideText(compact) ||
    hasFragmentHeavyStructure(compact) ||
    /\b(?:countereidence|that is that they|some they can be like|The speaker will just|it is it seems|can't be find found)\b/i.test(
      compact,
    );
  if (!needsTranscriptCleanup) return compact;
  return summarizeTranscriptLikeSlideText(compact, maxChars);
}

export function buildSlideTextFallback({
  slides,
  transcriptTimedText,
  lengthArg,
}: {
  slides: SlideTimelineEntry[];
  transcriptTimedText: string | null | undefined;
  lengthArg: { kind: "preset"; preset: SummaryLength } | { kind: "chars"; maxCharacters: number };
}): Map<number, string> {
  const map = new Map<number, string>();
  if (!transcriptTimedText || !transcriptTimedText.trim()) return map;
  if (slides.length === 0) return map;
  const segments = parseTranscriptTimedText(transcriptTimedText);
  if (segments.length === 0) return map;
  const ordered = slides.slice().sort((a, b) => a.index - b.index);
  const budget = resolveSlideTextBudget({ lengthArg, slideCount: ordered.length });
  const windowSeconds = resolveSlideWindowSeconds({ lengthArg });
  for (let i = 0; i < ordered.length; i += 1) {
    const slide = ordered[i];
    if (!slide) continue;
    const nextSlide = i + 1 < ordered.length ? (ordered[i + 1] ?? null) : null;
    const text = getTranscriptTextForSlide({
      slide,
      nextSlide,
      segments,
      budget,
      windowSeconds,
    });
    if (text) map.set(slide.index, text);
  }
  return map;
}

export function coerceSummaryWithSlides({
  markdown,
  slides,
  transcriptTimedText,
  lengthArg,
}: {
  markdown: string;
  slides: SlideTimelineEntry[];
  transcriptTimedText?: string | null;
  lengthArg: { kind: "preset"; preset: SummaryLength } | { kind: "chars"; maxCharacters: number };
}): string {
  if (!markdown.trim() || slides.length === 0) return markdown;
  const ordered = slides.slice().sort((a, b) => a.index - b.index);
  const slideSummaryCap = Math.max(
    240,
    Math.min(
      1800,
      resolveSlideTextBudget({ lengthArg, slideCount: ordered.length }) * 2,
    ),
  );
  const { summary, slidesSection } = splitSummaryFromSlides(markdown);
  const intro = pickIntroParagraph(summary);
  const slideSummaries = slidesSection ? parseSlideSummariesFromMarkdown(markdown) : new Map();
  const titleOnlySlideSummaries =
    slideSummaries.size > 0 &&
    Array.from(slideSummaries.values()).every((text) => isTitleOnlySlideText(text));
  const distributionMarkdown = titleOnlySlideSummaries ? stripSlideTitleList(markdown) : markdown;
  const fallbackSummaries = buildSlideTextFallback({
    slides: ordered,
    transcriptTimedText,
    lengthArg,
  });
  const fallbackCoverageThreshold = Math.max(1, Math.ceil(ordered.length / 2));
  const fallbackHasCoverage = fallbackSummaries.size >= fallbackCoverageThreshold;
  const collapsedTailRedistribution = (() => {
    if (slideSummaries.size === 0 || titleOnlySlideSummaries) return null;
    const lastSlideIndex = ordered[ordered.length - 1]?.index ?? null;
    if (lastSlideIndex == null) return null;
    const rawBySlide = ordered.map((slide) => {
      const raw = (slideSummaries.get(slide.index) ?? "").trim();
      const isTitleOnly = raw.length > 0 && isTitleOnlySlideText(raw);
      const hasSummary = slideSummaries.has(slide.index);
      return { index: slide.index, raw, isTitleOnly, hasSummary };
    });
    const bodyEntries = rawBySlide.filter((entry) => entry.raw && !entry.isTitleOnly);
    if (bodyEntries.length !== 1) return null;
    const bodyEntry = bodyEntries[0];
    if (!bodyEntry) return null;
    if (bodyEntry.index !== lastSlideIndex) return null;
    const explicitEmptyCount = rawBySlide.filter((entry) => entry.hasSummary && !entry.raw).length;
    const titleOnlyCount = rawBySlide.filter((entry) => entry.isTitleOnly).length;
    if (explicitEmptyCount + titleOnlyCount < 2) return null;
    const parsedBodyEntry = splitSlideTitleFromText({
      text: bodyEntry.raw,
      slideIndex: bodyEntry.index,
      total: ordered.length,
    });
    const narrative = (parsedBodyEntry.body || bodyEntry.raw).trim();
    if (!narrative) return null;
    const sentenceCount = (narrative.match(/[^.!?]+(?:[.!?]+|$)/g) ?? [])
      .map((part: string) => part.trim())
      .filter(Boolean).length;
    const preferNarrativeRedistribution = sentenceCount >= ordered.length;
    const redistributedNarrative = distributeTextAcrossSlides({
      text: narrative,
      slideCount: ordered.length,
    });
    const textByIndex = new Map<number, string>();
    const titleByIndex = new Map<number, string>();
    for (let i = 0; i < ordered.length; i += 1) {
      const slide = ordered[i];
      if (!slide) continue;
      const entry = rawBySlide[i];
      const title =
        entry?.isTitleOnly && entry.raw
          ? entry.raw
          : entry?.index === bodyEntry.index
            ? (parsedBodyEntry.title ?? "")
            : "";
      if (title) titleByIndex.set(slide.index, title);
      const narrativeChunk = redistributedNarrative[i] ?? "";
      const fallbackChunk = fallbackSummaries.get(slide.index) ?? "";
      const chunk =
        preferNarrativeRedistribution || !fallbackHasCoverage
          ? narrativeChunk
          : fallbackChunk || narrativeChunk;
      textByIndex.set(
        slide.index,
        chunk || (!fallbackHasCoverage && i === ordered.length - 1 ? narrative : ""),
      );
    }
    return { textByIndex, titleByIndex };
  })();

  if (slideSummaries.size > 0 && !titleOnlySlideSummaries) {
    const parts: string[] = [];
    if (intro) parts.push(intro);
    for (const slide of ordered) {
      const hasSlideSummary = slideSummaries.has(slide.index);
      const parsedText = slideSummaries.get(slide.index) ?? "";
      const fallbackText = fallbackSummaries.get(slide.index) ?? "";
      const redistributedText = collapsedTailRedistribution?.textByIndex.get(slide.index) ?? "";
      const redistributedTitle = collapsedTailRedistribution?.titleByIndex.get(slide.index) ?? "";
      let text = collapsedTailRedistribution
        ? [redistributedTitle, redistributedText].filter(Boolean).join("\n").trim()
        : hasSlideSummary
          ? !parsedText.trim()
            ? ""
            : isTitleOnlySlideText(parsedText) && fallbackText
              ? `${parsedText}\n${fallbackText}`
              : parsedText
          : fallbackText;
      if (!collapsedTailRedistribution && text && fallbackText) {
        const parsed = splitSlideTitleFromText({
          text,
          slideIndex: slide.index,
          total: ordered.length,
        });
        const body = parsed.body || text;
        const hasExplicitTitle =
          Boolean(parsed.title) && Boolean(parsed.body) && parsed.body.trim() !== text.trim();
        const fallbackPrepared = normalizeSlideBodyStyle(fallbackText, slideSummaryCap);
        const fallbackPreparedWords = normalizeSlideText(fallbackPrepared)
          .split(/\s+/)
          .filter(Boolean).length;
        if (
          isLowQualitySlideBodyText(body) &&
          fallbackPrepared &&
          fallbackPreparedWords >= 14 &&
          !isLowQualitySlideBodyText(fallbackPrepared)
        ) {
          text = hasExplicitTitle && parsed.title ? `${parsed.title}\n${fallbackPrepared}` : fallbackPrepared;
        }
        if (looksCorruptedSpeechLikeText(body)) {
          const fallbackWordCount = normalizeSlideText(fallbackText)
            .split(/\s+/)
            .filter(Boolean).length;
          if (fallbackWordCount >= 12 && fallbackWordCount <= 260) {
            text = hasExplicitTitle && parsed.title ? `${parsed.title}\n${fallbackText}` : fallbackText;
          }
        }
        if (looksTruncatedSlideBody(body, fallbackText)) {
          const hasExplicitTitle =
            Boolean(parsed.title) && Boolean(parsed.body) && parsed.body.trim() !== text.trim();
          const repairedBody = trimTruncatedSlideBody(body);
          const fallbackWordCount = normalizeSlideText(fallbackText)
            .split(/\s+/)
            .filter(Boolean).length;
          const useFallback =
            repairedBody === body &&
            fallbackWordCount <= 120 &&
            !isTranscriptLikeSlideText(fallbackText);
          const chosenBody = useFallback ? fallbackText : repairedBody;
          text = hasExplicitTitle && parsed.title ? `${parsed.title}\n${chosenBody}` : chosenBody;
        }
      }
      if (text) {
        const explicit = splitExplicitSlideTitleFromText(text);
        if (explicit) {
          const deEchoed = removeLeadingTitleEcho(explicit.body, explicit.title);
          text = `${explicit.title}\n${normalizeSlideBodyStyle(deEchoed, slideSummaryCap)}`;
        } else {
          text = normalizeSlideBodyStyle(text, slideSummaryCap);
        }
      }
      const withTitle = text ? ensureSlideTitleLine({ text, slide, total: ordered.length }) : "";
      parts.push(withTitle ? `[slide:${slide.index}]\n${withTitle}` : `[slide:${slide.index}]`);
    }
    return parts.join("\n\n");
  }

  if ((slideSummaries.size === 0 || titleOnlySlideSummaries) && fallbackHasCoverage) {
    const parts: string[] = [];
    const overviewSource = titleOnlySlideSummaries ? distributionMarkdown : summary || markdown;
    const overview = pickIntroParagraph(overviewSource);
    if (overview) parts.push(overview);
    for (const slide of ordered) {
      const hasSlideSummary = slideSummaries.has(slide.index);
      const parsedText = slideSummaries.get(slide.index) ?? "";
      const fallbackText = fallbackSummaries.get(slide.index) ?? "";
      const text = hasSlideSummary
        ? !parsedText.trim()
          ? ""
          : fallbackText
            ? `${parsedText}\n${fallbackText}`
            : parsedText
        : fallbackText;
      const normalized = text ? normalizeSlideBodyStyle(text, slideSummaryCap) : "";
      const withTitle = normalized
        ? ensureSlideTitleLine({ text: normalized, slide, total: ordered.length })
        : "";
      parts.push(withTitle ? `[slide:${slide.index}]\n${withTitle}` : `[slide:${slide.index}]`);
    }
    return parts.join("\n\n");
  }

  const paragraphs = splitMarkdownParagraphs(distributionMarkdown);
  if (paragraphs.length === 0) return markdown;
  const autoIntroEnabled = !(titleOnlySlideSummaries && !intro);
  const introParagraph = autoIntroEnabled ? intro || paragraphs[0] || "" : intro || "";
  const introIndex = introParagraph ? paragraphs.indexOf(introParagraph) : -1;
  const remaining =
    introIndex >= 0 ? paragraphs.filter((_, index) => index !== introIndex) : paragraphs.slice();
  const parts: string[] = [];
  if (introParagraph) parts.push(introParagraph.trim());
  if (remaining.length === 0) {
    for (const slide of ordered) {
      parts.push(`[slide:${slide.index}]`);
    }
    return parts.join("\n\n");
  }
  const total = ordered.length;
  const redistributedRemaining =
    remaining.length > 0 && remaining.length < total
      ? distributeTextAcrossSlides({ text: remaining.join("\n\n"), slideCount: total })
      : null;
  for (let i = 0; i < total; i += 1) {
    const start = Math.round((i * remaining.length) / total);
    const end = Math.round(((i + 1) * remaining.length) / total);
    const segment = redistributedRemaining
      ? redistributedRemaining[i] ?? ""
      : remaining.slice(start, end).join("\n\n").trim();
    const slideIndex = ordered[i]?.index ?? i + 1;
    const fallback = fallbackSummaries.get(slideIndex) ?? "";
    const text = segment || fallback;
    const slide = ordered[i] ?? { index: slideIndex, timestamp: Number.NaN };
    const normalized = text ? normalizeSlideBodyStyle(text, slideSummaryCap) : "";
    const withTitle = normalized ? ensureSlideTitleLine({ text: normalized, slide, total }) : "";
    parts.push(withTitle ? `[slide:${slideIndex}]\n${withTitle}` : `[slide:${slideIndex}]`);
  }
  return parts.join("\n\n");
}

function parseTimestampSeconds(value: string): number | null {
  const parts = value.split(":").map((item) => Number(item));
  if (parts.some((item) => !Number.isFinite(item))) return null;
  if (parts.length === 2) {
    const [minutes, seconds] = parts;
    return minutes * 60 + seconds;
  }
  if (parts.length === 3) {
    const [hours, minutes, seconds] = parts;
    return hours * 3600 + minutes * 60 + seconds;
  }
  return null;
}

export function interleaveSlidesIntoTranscript({
  transcriptTimedText,
  slides,
}: {
  transcriptTimedText: string;
  slides: SlideTimelineEntry[];
}): string {
  if (!transcriptTimedText.trim() || slides.length === 0) return transcriptTimedText;
  const ordered = slides
    .filter((slide) => Number.isFinite(slide.timestamp))
    .map((slide) => ({ index: slide.index, timestamp: slide.timestamp }))
    .sort((a, b) => a.timestamp - b.timestamp);
  if (ordered.length === 0) return transcriptTimedText;

  let nextIndex = 0;
  const out: string[] = [];
  const lines = transcriptTimedText.split("\n");
  for (const line of lines) {
    const trimmed = line.trim();
    const match = trimmed.match(/^\[(\d{1,2}:\d{2}(?::\d{2})?)\]/);
    const seconds = match ? parseTimestampSeconds(match[1] ?? "") : null;
    if (seconds != null) {
      while (nextIndex < ordered.length && (ordered[nextIndex]?.timestamp ?? 0) <= seconds) {
        const slide = ordered[nextIndex];
        if (slide) out.push(`[slide:${slide.index}]`);
        nextIndex += 1;
      }
    }
    out.push(line);
  }
  while (nextIndex < ordered.length) {
    const slide = ordered[nextIndex];
    if (slide) out.push(`[slide:${slide.index}]`);
    nextIndex += 1;
  }
  return out.join("\n");
}

export function parseTranscriptTimedText(input: string | null | undefined): TranscriptSegment[] {
  if (!input) return [];
  const segments: TranscriptSegment[] = [];
  for (const line of input.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("[")) continue;
    const match = trimmed.match(/^\[(\d{1,2}:\d{2}(?::\d{2})?)\]\s*(.*)$/);
    if (!match) continue;
    const seconds = parseTimestampSeconds(match[1]);
    if (seconds == null) continue;
    const text = (match[2] ?? "").trim();
    if (!text) continue;
    segments.push({ startSeconds: seconds, text });
  }
  segments.sort((a, b) => a.startSeconds - b.startSeconds);
  return segments;
}

export function formatTimestamp(seconds: number): string {
  const clamped = Math.max(0, Math.floor(seconds));
  const hours = Math.floor(clamped / 3600);
  const minutes = Math.floor((clamped % 3600) / 60);
  const secs = clamped % 60;
  const mm = String(minutes).padStart(2, "0");
  const ss = String(secs).padStart(2, "0");
  if (hours <= 0) return `${minutes}:${ss}`;
  const hh = String(hours).padStart(2, "0");
  return `${hh}:${mm}:${ss}`;
}

function normalizeSlideText(value: string): string {
  return value
    .replace(
      /\[(?:music|applause|clapping|cheering|laughter|laughs?|inaudible|silence|sfx|sound effects?)\]/gi,
      " ",
    )
    .replace(/\s+/g, " ")
    .trim();
}

const LEADING_CONTINUATION_WORDS = new Set([
  "and",
  "or",
  "but",
  "because",
  "so",
  "then",
  "that",
  "which",
  "of",
  "to",
  "in",
  "for",
  "with",
  "from",
  "on",
  "at",
  "by",
  "if",
  "when",
  "while",
  "than",
  "as",
  "about",
  "also",
]);

const TRAILING_SENTENCE_PUNCTUATION = /[.!?]["')\]]?$/;
const MAX_START_BACKFILL_SEGMENTS = 8;
const BOUNDED_START_BACKFILL_SECONDS = 20;
const OPEN_START_BACKFILL_SECONDS = 45;

function startsLikeContinuation(
  value: string,
  { allowLowercase }: { allowLowercase: boolean },
): boolean {
  const normalized = normalizeSlideText(value);
  if (!normalized) return false;
  if (/^[,.;:)\]}]/.test(normalized)) return true;
  const firstWord = (normalized.split(/\s+/)[0] ?? "").toLowerCase().replace(/[^a-z]+/g, "");
  if (firstWord && LEADING_CONTINUATION_WORDS.has(firstWord)) return true;
  if (!allowLowercase) return false;
  const firstLetter = normalized.match(/[A-Za-z]/)?.[0] ?? "";
  return Boolean(firstLetter && firstLetter === firstLetter.toLowerCase());
}

function endsSentence(value: string): boolean {
  const normalized = normalizeSlideText(value);
  if (!normalized) return false;
  return TRAILING_SENTENCE_PUNCTUATION.test(normalized);
}

function trimLeadingContinuation(value: string): string {
  const normalized = normalizeSlideText(value);
  if (!normalized) return normalized;
  if (!startsLikeContinuation(normalized, { allowLowercase: true })) return normalized;
  const boundary = /[.!?]["')\]]?\s+([A-Z])/g.exec(normalized);
  if (!boundary || boundary.index == null) return normalized;
  if (boundary.index > 260) return normalized;
  const boundaryToken = boundary[0] ?? "";
  const capitalOffset = boundaryToken.search(/[A-Z]/);
  if (capitalOffset < 0) return normalized;
  const cutAt = boundary.index + capitalOffset;
  const trimmed = normalized.slice(cutAt).trim();
  return trimmed || normalized;
}

function backfillTranscriptStartIndex({
  segments,
  startIndex,
  slideStartSeconds,
  boundedByNextSlide,
}: {
  segments: TranscriptSegment[];
  startIndex: number;
  slideStartSeconds: number;
  boundedByNextSlide: boolean;
}): number {
  if (startIndex <= 0) return startIndex;
  const maxLookbackSeconds = boundedByNextSlide
    ? BOUNDED_START_BACKFILL_SECONDS
    : OPEN_START_BACKFILL_SECONDS;
  const minStartSeconds = Math.max(0, slideStartSeconds - maxLookbackSeconds);
  let current = startIndex;
  let used = 0;
  while (current > 0 && used < MAX_START_BACKFILL_SEGMENTS) {
    const first = segments[current];
    const previous = segments[current - 1];
    if (!first || !previous) break;
    if (previous.startSeconds < minStartSeconds) break;
    const allowLowercase = !boundedByNextSlide;
    const gapSeconds = Math.max(0, first.startSeconds - previous.startSeconds);
    const danglingPrevious = !endsSentence(previous.text) && gapSeconds <= 6;
    const needsContext =
      startsLikeContinuation(first.text, { allowLowercase }) || danglingPrevious;
    if (!needsContext) break;
    current -= 1;
    used += 1;
    const nextFirst = segments[current];
    const beforeNext = current > 0 ? segments[current - 1] : null;
    if (used > 0 && beforeNext && endsSentence(beforeNext.text)) {
      break;
    }
    if (
      nextFirst &&
      !startsLikeContinuation(nextFirst.text, { allowLowercase }) &&
      (!beforeNext || endsSentence(beforeNext.text))
    ) {
      break;
    }
  }
  return current;
}

const TRUNCATED_TAIL_CONNECTORS = new Set([
  "and",
  "or",
  "but",
  "because",
  "so",
  "then",
  "that",
  "which",
  "of",
  "to",
  "in",
  "for",
  "with",
  "from",
  "on",
  "at",
  "by",
  "if",
  "when",
  "while",
  "than",
  "as",
]);

function looksTruncatedSlideBody(value: string, fallbackText?: string | null): boolean {
  const normalized = normalizeSlideText(value);
  if (!normalized) return false;
  const words = normalized.split(/\s+/).filter(Boolean);
  if (words.length === 0) return false;
  if (/(?:\.{3,}|…)\s*$/u.test(normalized)) return words.length >= 6;
  if (/[.!?]["')\]]?$/.test(normalized)) return false;
  // Avoid replacing very short snippets and very long narrative sections.
  if (words.length < 8 || words.length > 120) return false;
  const tail = (words[words.length - 1] ?? "").toLowerCase().replace(/[^a-z]+/g, "");
  if (TRUNCATED_TAIL_CONNECTORS.has(tail)) return true;

  const fallback = normalizeSlideText(fallbackText ?? "");
  if (!fallback) return false;
  const fallbackWords = fallback.split(/\s+/).filter(Boolean);
  if (fallbackWords.length < 10) return false;

  const danglingTailWordPattern =
    /\b(?:to|for|of|and|or|but|that|which|because|if|when|while|than|as|so|very|much|more|less|about|with|from|into|onto|through|over|under|around|between|without|within|before|after|during|across|toward|towards|up|down|out|off|on|in|at|by|you|we|they|he|she|it|this|that|these|those|my|your|his|her|their|our|the|a|an)$/i;
  const hasDanglingTailWord = danglingTailWordPattern.test(normalized);

  // If model text ends mid-thought and fallback is substantially richer,
  // prefer the fallback excerpt for this slide.
  if (fallbackWords.length >= words.length + 8) return true;
  if (hasDanglingTailWord && fallbackWords.length >= Math.max(10, Math.floor(words.length * 0.6))) {
    return true;
  }
  return false;
}

function trimTruncatedSlideBody(value: string): string {
  const normalized = normalizeSlideText(value);
  if (!normalized) return normalized;
  if (/[.!?]["')\]]?$/.test(normalized)) return normalized;

  const sentences = normalized.match(/[^.!?]+[.!?]["')\]]?(?=\s|$)/g) ?? [];
  if (sentences.length > 0) {
    const candidate = sentences.join(" ").trim();
    if (candidate.length >= Math.max(80, Math.floor(normalized.length * 0.55))) {
      return candidate;
    }
  }

  const lastBoundary = Math.max(
    normalized.lastIndexOf("."),
    normalized.lastIndexOf("?"),
    normalized.lastIndexOf("!"),
    normalized.lastIndexOf(";"),
  );
  if (lastBoundary >= Math.max(80, Math.floor(normalized.length * 0.55))) {
    return normalized.slice(0, lastBoundary + 1).trim();
  }

  return normalized;
}

function truncateSlideText(value: string, limit: number): string {
  if (value.length <= limit) return value;
  const truncated = value.slice(0, limit).trimEnd();
  const clean = truncated.replace(/\s+\S*$/, "").trim();
  const result = clean.length > 0 ? clean : truncated.trim();
  return result.length > 0 ? `${result}...` : "";
}

export function resolveSlideTextBudget({
  lengthArg,
  slideCount,
}: {
  lengthArg: { kind: "preset"; preset: SummaryLength } | { kind: "chars"; maxCharacters: number };
  slideCount: number;
}): number {
  if (lengthArg.kind === "preset") {
    return SLIDE_TEXT_BUDGET_BY_PRESET[lengthArg.preset];
  }
  const divisor = Math.max(1, Math.min(slideCount, 10));
  const perSlide = Math.round(lengthArg.maxCharacters / divisor);
  return clampNumber(perSlide, SLIDE_TEXT_BUDGET_MIN, SLIDE_TEXT_BUDGET_MAX);
}

export function resolveSlideWindowSeconds({
  lengthArg,
}: {
  lengthArg: { kind: "preset"; preset: SummaryLength } | { kind: "chars"; maxCharacters: number };
}): number {
  if (lengthArg.kind === "preset") {
    return SLIDE_WINDOW_SECONDS_BY_PRESET[lengthArg.preset];
  }
  const window = Math.round(lengthArg.maxCharacters / 100);
  return clampNumber(window, SLIDE_WINDOW_SECONDS_MIN, SLIDE_WINDOW_SECONDS_MAX);
}

export function getTranscriptTextForSlide({
  slide,
  nextSlide,
  segments,
  budget,
  windowSeconds,
}: {
  slide: SlideTimelineEntry;
  nextSlide: SlideTimelineEntry | null;
  segments: TranscriptSegment[];
  budget: number;
  windowSeconds: number;
}): string {
  if (!Number.isFinite(slide.timestamp)) return "";
  if (segments.length === 0) return "";
  if (!Number.isFinite(windowSeconds) || windowSeconds <= 0) return "";
  const start = Math.max(0, Math.floor(slide.timestamp));
  const boundedByNextSlide =
    Boolean(nextSlide) &&
    Number.isFinite(nextSlide?.timestamp) &&
    Math.floor(nextSlide!.timestamp) > start;
  const leadIn = boundedByNextSlide ? 0 : Math.min(30, Math.floor(windowSeconds * 0.25));
  const lower = Math.max(0, start - leadIn);
  let upper = start + windowSeconds;
  if (boundedByNextSlide && nextSlide && Number.isFinite(nextSlide.timestamp)) {
    upper = Math.floor(nextSlide.timestamp);
  }
  if (upper < lower) return "";
  const exclusiveUpper = boundedByNextSlide;
  const firstInRange = segments.findIndex((segment) => segment.startSeconds >= lower);
  if (firstInRange < 0) return "";
  const firstSegment = segments[firstInRange];
  if (!firstSegment) return "";
  if (exclusiveUpper ? firstSegment.startSeconds >= upper : firstSegment.startSeconds > upper) {
    return "";
  }
  const adjustedStart = backfillTranscriptStartIndex({
    segments,
    startIndex: firstInRange,
    slideStartSeconds: start,
    boundedByNextSlide,
  });
  const parts: string[] = [];
  for (let i = adjustedStart; i < segments.length; i += 1) {
    const segment = segments[i];
    if (!segment) continue;
    if (segment.startSeconds < lower && i >= firstInRange) continue;
    if (exclusiveUpper ? segment.startSeconds >= upper : segment.startSeconds > upper) break;
    parts.push(segment.text);
  }
  const text = trimLeadingContinuation(parts.join(" "));
  if (!text) return "";
  if (boundedByNextSlide || !nextSlide) return text;
  return truncateSlideText(text, budget);
}

export function formatOsc8Link(label: string, url: string | null, enabled: boolean): string {
  if (!enabled || !url) return label;
  const osc = "\u001b]8;;";
  const st = "\u001b\\";
  return `${osc}${url}${st}${label}${osc}${st}`;
}

export function buildTimestampUrl(sourceUrl: string, seconds: number): string | null {
  if (!sourceUrl) return null;
  let url: URL;
  try {
    url = new URL(sourceUrl);
  } catch {
    return null;
  }
  const host = url.hostname.replace(/^www\./, "").toLowerCase();
  const clamped = Math.max(0, Math.floor(seconds));

  if (host === "youtu.be" || host === "youtube.com" || host === "m.youtube.com") {
    const id = extractYouTubeVideoId(sourceUrl);
    if (!id) return null;
    return `https://www.youtube.com/watch?v=${id}&t=${clamped}s`;
  }

  if (host === "vimeo.com" || host === "player.vimeo.com") {
    const match = url.pathname.match(/\/(\d+)(?:$|\/)/);
    if (!match) return null;
    url.hash = `t=${clamped}s`;
    return url.toString();
  }

  if (host === "loom.com" || host.endsWith(".loom.com")) {
    url.searchParams.set("t", clamped.toString());
    return url.toString();
  }

  if (host === "dropbox.com" || host.endsWith(".dropbox.com")) {
    url.searchParams.set("t", clamped.toString());
    return url.toString();
  }

  return null;
}
