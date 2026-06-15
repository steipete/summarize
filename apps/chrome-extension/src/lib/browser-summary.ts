import type { BrowserAiSummaryInput } from "./panel-contracts";
import { parseTranscriptTimedText } from "./slides-text";

type BrowserSummaryInput = {
  title: string | null;
  text: string;
  transcriptTimedText?: string | null;
};

function collapseWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function normalizeSourceText(value: string): string {
  return value
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function splitSentences(value: string): string[] {
  return collapseWhitespace(value)
    .split(/(?<=[.!?])\s+/)
    .map((part) => part.trim())
    .filter(Boolean);
}

function formatTimestamp(seconds: number): string {
  const clamped = Math.max(0, Math.floor(seconds));
  const minutes = Math.floor(clamped / 60);
  const secs = clamped % 60;
  return `${minutes}:${String(secs).padStart(2, "0")}`;
}

function escapeMarkdownText(value: string): string {
  return value.replace(/[\\`*_[\]{}()#+\-.!|>]/g, "\\$&");
}

function pickEvenly<T>(items: T[], limit: number): T[] {
  if (items.length <= limit) return items;
  return Array.from({ length: limit }, (_value, index) => {
    const itemIndex = Math.round((index * (items.length - 1)) / Math.max(1, limit - 1));
    return items[itemIndex] as T;
  });
}

function renderKeyMoments(keyMoments: BrowserAiSummaryInput["keyMoments"]): string[] {
  if (keyMoments.length === 0) return [];
  return [
    "## Key moments",
    keyMoments
      .map(
        (moment) =>
          `- ${formatTimestamp(moment.startSeconds)} ${escapeMarkdownText(
            collapseWhitespace(moment.text),
          )}`,
      )
      .join("\n"),
  ];
}

function normalizeGeneratedPoints(value: string): string[] {
  return value
    .replace(/^```(?:text|markdown)?\s*/i, "")
    .replace(/\s*```$/, "")
    .split(/\n+/)
    .map((line) =>
      line
        .trim()
        .replace(/^#{1,6}\s+/, "")
        .replace(/^(?:[-*•]|\d+[.)])\s+/, "")
        .trim(),
    )
    .filter(Boolean);
}

export function buildBrowserSummaryPayload({
  title,
  text,
  transcriptTimedText,
}: BrowserSummaryInput): {
  markdown: string;
  sourceText: string;
  keyMoments: BrowserAiSummaryInput["keyMoments"];
} {
  const segments = parseTranscriptTimedText(transcriptTimedText);
  const sourceText = segments.length > 0 ? segments.map((segment) => segment.text).join(" ") : text;
  const sentences = splitSentences(sourceText);
  const introSentences = sentences.slice(0, Math.min(4, Math.max(2, sentences.length)));
  const intro =
    introSentences.join(" ") ||
    collapseWhitespace(sourceText)
      .slice(0, 800)
      .replace(/\s+\S*$/, "")
      .trim();
  const heading = title?.trim() ? `## ${escapeMarkdownText(title.trim())}` : "## Summary";
  const keyMoments = pickEvenly(segments, Math.min(6, segments.length)).map((segment) => ({
    startSeconds: segment.startSeconds,
    text: segment.text,
  }));
  const parts = [
    heading,
    intro ? escapeMarkdownText(intro) : "No transcript text was available from the browser\\.",
    ...renderKeyMoments(keyMoments),
  ];

  return {
    markdown: parts.join("\n\n"),
    sourceText: normalizeSourceText(sourceText),
    keyMoments,
  };
}

export function buildBrowserSummaryMarkdown(input: BrowserSummaryInput): string {
  return buildBrowserSummaryPayload(input).markdown;
}

export function buildBrowserAiSummaryMarkdown({
  title,
  summary,
  keyMoments,
}: {
  title: string | null;
  summary: string;
  keyMoments: BrowserAiSummaryInput["keyMoments"];
}): string {
  const heading = title?.trim() ? `## ${escapeMarkdownText(title.trim())}` : "## Summary";
  const points = normalizeGeneratedPoints(summary);
  const body =
    points.length > 1
      ? points.map((point) => `- ${escapeMarkdownText(point)}`).join("\n")
      : escapeMarkdownText(points[0] ?? collapseWhitespace(summary));
  return [heading, body, ...renderKeyMoments(keyMoments)].filter(Boolean).join("\n\n");
}
