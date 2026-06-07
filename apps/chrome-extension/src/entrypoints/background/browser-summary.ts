import { parseTranscriptTimedText } from "../../lib/slides-text";

type BrowserSummaryInput = {
  title: string | null;
  text: string;
  transcriptTimedText?: string | null;
};

function collapseWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
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

export function buildBrowserSummaryMarkdown({
  title,
  text,
  transcriptTimedText,
}: BrowserSummaryInput): string {
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
  const parts = [
    heading,
    intro ? escapeMarkdownText(intro) : "No transcript text was available from the browser\\.",
  ];

  if (segments.length > 0) {
    const keyMoments = pickEvenly(segments, Math.min(6, segments.length)).map(
      (segment) =>
        `- ${formatTimestamp(segment.startSeconds)} ${escapeMarkdownText(
          collapseWhitespace(segment.text),
        )}`,
    );
    if (keyMoments.length > 0) {
      parts.push("## Key moments", keyMoments.join("\n"));
    }
  }

  return parts.join("\n\n");
}
