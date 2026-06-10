import type { TranscriptionSegment } from "./types.js";

const SPEAKER_NUMBER_PATTERN = /^speaker[_\s-]*(\d+)$/i;
const NO_SPACE_BEFORE_PATTERN = /^[,.;:!?%)\]}]/;
const NO_SPACE_AFTER_PATTERN = /[(\[{]$/;

export function formatSpeakerLabel(raw: string): string {
  const trimmed = raw.trim();
  const numbered = SPEAKER_NUMBER_PATTERN.exec(trimmed);
  if (numbered) return `Speaker ${Number(numbered[1])}`;
  if (/^[a-z]$/i.test(trimmed)) return `Speaker ${trimmed.toUpperCase()}`;
  return trimmed
    .split(/[_-]+/)
    .filter(Boolean)
    .map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1)}`)
    .join(" ");
}

export function appendTranscriptToken(current: string, token: string): string {
  const next = token.replace(/\s+/g, " ");
  if (!next) return current;
  if (!current) return next.trimStart();
  if (
    /^\s/.test(next) ||
    /\s$/.test(current) ||
    NO_SPACE_BEFORE_PATTERN.test(next) ||
    NO_SPACE_AFTER_PATTERN.test(current)
  ) {
    return `${current}${next}`;
  }
  return `${current} ${next}`;
}

export function formatDiarizedTranscript(segments: TranscriptionSegment[]): string | null {
  const lines = segments
    .map((segment) => {
      const text = segment.text.replace(/\s+/g, " ").trim();
      if (!text) return null;
      const speaker = segment.speaker?.trim();
      return speaker ? `${speaker}: ${text}` : text;
    })
    .filter((line): line is string => Boolean(line));
  return lines.length > 0 ? lines.join("\n") : null;
}
