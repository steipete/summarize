import { formatTimestamp, parseTimestampSeconds } from "@steipete/summarize-core/slides";
import type { ExtractedLinkContent } from "../content/index.js";

const TIMED_TRANSCRIPT_LINE_RE = /^\[(\d{1,2}:\d{2}(?::\d{2})?)\]\s+/;
const KEY_MOMENTS_HEADING_RE = /^\s{0,3}(?:#{1,6}\s*)?Key moments\s*:?\s*$/i;
const MARKDOWN_HEADING_RE = /^\s{0,3}#{1,6}\s+\S/;
const KEY_MOMENT_LINE_RE =
  /^\s*(?:[-*+]\s+)?(?:\[(\d{1,2}:\d{2}(?::\d{2})?)\]|(\d{1,2}:\d{2}(?::\d{2})?))(?=\s|[-:–—])/;
const SMALL_OVERSHOOT_TOLERANCE_SECONDS = 5;
const FALLBACK_KEY_MOMENT_COUNT = 3;

function readTranscriptMaxSeconds(
  extracted: Pick<ExtractedLinkContent, "transcriptSegments" | "transcriptTimedText">,
): number | null {
  let maxSeconds: number | null = null;

  for (const segment of extracted.transcriptSegments ?? []) {
    if (!segment) continue;
    const startSeconds = Math.floor(segment.startMs / 1000);
    if (Number.isFinite(startSeconds) && startSeconds >= 0) {
      maxSeconds = maxSeconds == null ? startSeconds : Math.max(maxSeconds, startSeconds);
    }
    if (typeof segment.endMs === "number" && Number.isFinite(segment.endMs)) {
      const endSeconds = Math.floor(segment.endMs / 1000);
      if (endSeconds >= 0) {
        maxSeconds = maxSeconds == null ? endSeconds : Math.max(maxSeconds, endSeconds);
      }
    }
  }

  for (const line of extracted.transcriptTimedText?.split("\n") ?? []) {
    const match = line.trim().match(TIMED_TRANSCRIPT_LINE_RE);
    if (!match) continue;
    const seconds = parseTimestampSeconds(match[1] ?? "");
    if (seconds == null) continue;
    maxSeconds = maxSeconds == null ? seconds : Math.max(maxSeconds, seconds);
  }

  return maxSeconds;
}

function trimEdgeBlankLines(lines: string[]): string[] {
  let start = 0;
  let end = lines.length;
  while (start < end && lines[start]?.trim() === "") start += 1;
  while (end > start && lines[end - 1]?.trim() === "") end -= 1;
  return lines.slice(start, end);
}

function readLeadingKeyMomentSeconds(line: string): number | null {
  const match = line.match(KEY_MOMENT_LINE_RE);
  const raw = match?.[1] ?? match?.[2] ?? null;
  return raw ? parseTimestampSeconds(raw) : null;
}

function hasInvalidLeadingKeyMomentTimestamp(line: string): boolean {
  const match = line.match(KEY_MOMENT_LINE_RE);
  const raw = match?.[1] ?? match?.[2] ?? null;
  return Boolean(raw && parseTimestampSeconds(raw) == null);
}

function clampLeadingKeyMomentTimestamp(line: string, maxSeconds: number): string {
  const match = line.match(KEY_MOMENT_LINE_RE);
  if (!match) return line;
  const raw = match?.[1] ?? match?.[2] ?? null;
  if (!raw) return line;
  const replacement = formatTimestamp(maxSeconds);
  return line.replace(match[1] ? `[${raw}]` : raw, match[1] ? `[${replacement}]` : replacement);
}

function hasKeyMomentsSection(markdown: string): boolean {
  return markdown.split("\n").some((line) => KEY_MOMENTS_HEADING_RE.test(line.trim()));
}

function cleanTranscriptMomentText(value: string): string {
  const cleaned = value.replace(/\s+/g, " ").replace(/^\W+/, "").trim();
  if (cleaned.length <= 140) return cleaned;
  const truncated = cleaned
    .slice(0, 140)
    .replace(/\s+\S*$/, "")
    .trim();
  return truncated.length > 0 ? `${truncated}...` : "";
}

function readTimedTranscriptMoments({
  extracted,
  maxSeconds,
}: {
  extracted: Pick<ExtractedLinkContent, "transcriptTimedText">;
  maxSeconds: number;
}): { seconds: number; text: string }[] {
  const moments: { seconds: number; text: string }[] = [];
  for (const line of extracted.transcriptTimedText?.split("\n") ?? []) {
    const match = line.trim().match(TIMED_TRANSCRIPT_LINE_RE);
    if (!match) continue;
    const seconds = parseTimestampSeconds(match[1] ?? "");
    if (seconds == null || seconds > maxSeconds) continue;
    const text = cleanTranscriptMomentText(line.trim().slice(match[0].length));
    if (!text) continue;
    moments.push({ seconds, text });
  }
  return moments;
}

function pickFallbackKeyMoments(
  moments: { seconds: number; text: string }[],
): { seconds: number; text: string }[] {
  if (moments.length <= FALLBACK_KEY_MOMENT_COUNT) return moments;
  const indexes = new Set<number>();
  for (let i = 0; i < FALLBACK_KEY_MOMENT_COUNT; i += 1) {
    indexes.add(Math.round((i * (moments.length - 1)) / (FALLBACK_KEY_MOMENT_COUNT - 1)));
  }
  return Array.from(indexes)
    .sort((a, b) => a - b)
    .map((index) => moments[index])
    .filter((moment): moment is { seconds: number; text: string } => Boolean(moment));
}

export function buildSummaryTimestampLimitInstruction(
  extracted: Pick<
    ExtractedLinkContent,
    "transcriptSegments" | "transcriptTimedText" | "mediaDurationSeconds"
  >,
): string | null {
  const maxSeconds = resolveSummaryTimestampUpperBound(extracted);
  if (maxSeconds == null) return null;
  return `The last available timestamp is ${formatTimestamp(maxSeconds)}. Never use a later timestamp.`;
}

export function resolveSummaryTimestampUpperBound(
  extracted: Pick<
    ExtractedLinkContent,
    "transcriptSegments" | "transcriptTimedText" | "mediaDurationSeconds"
  >,
): number | null {
  const transcriptMaxSeconds = readTranscriptMaxSeconds(extracted);
  const durationSeconds =
    typeof extracted.mediaDurationSeconds === "number" &&
    Number.isFinite(extracted.mediaDurationSeconds) &&
    extracted.mediaDurationSeconds > 0
      ? Math.floor(extracted.mediaDurationSeconds)
      : null;

  if (durationSeconds != null) return durationSeconds;
  return transcriptMaxSeconds;
}

export function shouldSanitizeSummaryKeyMoments({
  extracted,
  hasSlides,
}: {
  extracted: Pick<
    ExtractedLinkContent,
    "transcriptSegments" | "transcriptTimedText" | "mediaDurationSeconds"
  >;
  hasSlides: boolean;
}): boolean {
  if (hasSlides) return false;
  return resolveSummaryTimestampUpperBound(extracted) != null;
}

export function sanitizeSummaryKeyMoments({
  markdown,
  maxSeconds,
}: {
  markdown: string;
  maxSeconds: number | null;
}): string {
  if (!markdown || maxSeconds == null) return markdown;

  const lines = markdown.split("\n");
  const output: string[] = [];

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    if (!KEY_MOMENTS_HEADING_RE.test(line.trim())) {
      output.push(line);
      continue;
    }

    let sectionEnd = index + 1;
    while (sectionEnd < lines.length) {
      const candidate = lines[sectionEnd] ?? "";
      if (MARKDOWN_HEADING_RE.test(candidate.trim())) break;
      sectionEnd += 1;
    }

    const keptLines: string[] = [];
    let keptTimestampCount = 0;
    for (const sectionLine of lines.slice(index + 1, sectionEnd)) {
      if (hasInvalidLeadingKeyMomentTimestamp(sectionLine)) continue;
      const seconds = readLeadingKeyMomentSeconds(sectionLine);
      if (seconds != null && seconds > maxSeconds) {
        if (seconds - maxSeconds <= SMALL_OVERSHOOT_TOLERANCE_SECONDS) {
          keptTimestampCount += 1;
          keptLines.push(clampLeadingKeyMomentTimestamp(sectionLine, maxSeconds));
        }
        continue;
      }
      if (seconds != null) keptTimestampCount += 1;
      keptLines.push(sectionLine);
    }

    const normalizedLines = trimEdgeBlankLines(keptLines);
    if (keptTimestampCount > 0) {
      output.push(line);
      output.push(...normalizedLines);
    }

    index = sectionEnd - 1;
  }

  return output
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function ensureSummaryKeyMoments({
  markdown,
  extracted,
  maxSeconds,
}: {
  markdown: string;
  extracted: Pick<ExtractedLinkContent, "transcriptTimedText">;
  maxSeconds: number | null;
}): string {
  if (!markdown || maxSeconds == null || hasKeyMomentsSection(markdown)) return markdown;
  const moments = pickFallbackKeyMoments(readTimedTranscriptMoments({ extracted, maxSeconds }));
  if (moments.length === 0) return markdown;
  const section = [
    "### Key moments",
    ...moments.map((moment) => `- [${formatTimestamp(moment.seconds)}] ${moment.text}`),
  ].join("\n");
  return `${markdown.trim()}\n\n${section}`;
}
