import { extractYouTubeVideoId } from "../content/url.js";
import type { SummaryLength } from "../shared/contracts.js";
import type { SlideTimelineEntry, TranscriptSegment } from "./text-types.js";

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

const clampNumber = (value: number, min: number, max: number) =>
  Math.min(max, Math.max(min, value));

function parseTimestampSeconds(value: string): number | null {
  const rawParts = value.split(":").map((item) => item.trim());
  if (rawParts.length !== 2 && rawParts.length !== 3) return null;
  if (rawParts.some((item) => !/^\d+$/.test(item))) return null;
  const parts = rawParts.map((item) => Number(item));
  if (parts.some((item) => !Number.isFinite(item))) return null;
  if (parts.length === 2) {
    const [minutes, seconds] = parts;
    if (seconds >= 60) return null;
    return minutes * 60 + seconds;
  }
  if (parts.length === 3) {
    const [hours, minutes, seconds] = parts;
    if (minutes >= 60 || seconds >= 60) return null;
    return hours * 3600 + minutes * 60 + seconds;
  }
  return null;
}

function normalizeSlideText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function truncateSlideText(value: string, limit: number): string {
  if (value.length <= limit) return value;
  const truncated = value.slice(0, limit).trimEnd();
  const clean = truncated.replace(/\s+\S*$/, "").trim();
  const result = clean.length > 0 ? clean : truncated.trim();
  return result.length > 0 ? `${result}...` : "";
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
  const start = Math.max(0, Math.floor(slide.timestamp));
  const leadIn = Math.min(6, Math.floor(windowSeconds * 0.2));
  const lower = Math.max(0, start - leadIn);
  let upper = start + windowSeconds;
  if (nextSlide && Number.isFinite(nextSlide.timestamp)) {
    const next = Math.max(start, Math.floor(nextSlide.timestamp));
    if (next > start) {
      upper = Math.min(upper, next);
    }
  }
  if (upper < lower) return "";
  const parts: string[] = [];
  for (const segment of segments) {
    if (segment.startSeconds < lower) continue;
    if (segment.startSeconds > upper) break;
    parts.push(segment.text);
  }
  const text = normalizeSlideText(parts.join(" "));
  return text ? truncateSlideText(text, budget) : "";
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
