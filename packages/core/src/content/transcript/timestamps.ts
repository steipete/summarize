import type { TranscriptSegment } from "../link-preview/types.js";

const TIMESTAMP_SPLIT_PATTERN = /:/;
const INTEGER_TIMESTAMP_PART_PATTERN = /^\d+$/;
const SECONDS_TIMESTAMP_PART_PATTERN = /^\d+(?:[,.]\d+)?$/;

export function formatTimestampMs(ms: number): string {
  const safe = Math.max(0, Math.round(ms));
  const totalSeconds = Math.floor(safe / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) {
    return `${hours}:${minutes.toString().padStart(2, "0")}:${seconds.toString().padStart(2, "0")}`;
  }
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}

export function parseTimestampStringToMs(value: string): number | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (/^\d+(?:\.\d+)?$/.test(trimmed)) {
    const seconds = Number(trimmed);
    return Number.isFinite(seconds) && seconds >= 0 ? Math.round(seconds * 1000) : null;
  }

  const parts = trimmed.split(TIMESTAMP_SPLIT_PATTERN).map((part) => part.trim());
  if (parts.length < 2 || parts.length > 3) return null;
  const secondsPart = parts.pop();
  if (secondsPart == null) return null;
  if (!SECONDS_TIMESTAMP_PART_PATTERN.test(secondsPart)) return null;
  const seconds = Number(secondsPart.replace(",", "."));
  if (!Number.isFinite(seconds) || seconds < 0 || seconds >= 60) return null;

  const minutesPart = parts.pop();
  if (minutesPart == null) return null;
  if (!INTEGER_TIMESTAMP_PART_PATTERN.test(minutesPart)) return null;
  const minutes = Number(minutesPart);
  if (!Number.isFinite(minutes) || minutes < 0) return null;

  const hoursPart = parts.pop();
  if (hoursPart != null && !INTEGER_TIMESTAMP_PART_PATTERN.test(hoursPart)) return null;
  const hours = hoursPart != null ? Number(hoursPart) : 0;
  if (!Number.isFinite(hours) || hours < 0) return null;
  if (hoursPart != null && minutes >= 60) return null;

  return Math.round((hours * 3600 + minutes * 60 + seconds) * 1000);
}

export function parseTimestampToMs(value: unknown, assumeSeconds = false): number | null {
  if (typeof value === "number") {
    if (!Number.isFinite(value) || value < 0) return null;
    return assumeSeconds ? Math.round(value * 1000) : Math.round(value);
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return null;
    if (trimmed.includes(":")) {
      const parsed = parseTimestampStringToMs(trimmed);
      if (parsed != null) return parsed;
    }
    const numeric = Number(trimmed);
    if (Number.isFinite(numeric) && numeric >= 0) {
      return assumeSeconds ? Math.round(numeric * 1000) : Math.round(numeric);
    }
  }
  return null;
}

export function formatTranscriptSegments(segments: TranscriptSegment[]): string | null {
  if (!segments || segments.length === 0) return null;
  const lines = segments
    .map((segment) => {
      const text = segment.text.replace(/\s+/g, " ").trim();
      if (!text) return null;
      const speaker = segment.speaker?.trim();
      return `[${formatTimestampMs(segment.startMs)}] ${speaker ? `${speaker}: ` : ""}${text}`;
    })
    .filter((line): line is string => Boolean(line));
  if (lines.length === 0) return null;
  return lines.join("\n");
}
