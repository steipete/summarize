import type { SseSlidesData } from "../../lib/runtime-contracts";
import { hasResolvedSlidesPayload } from "./slides-pending";

type SlidesPayload = NonNullable<SseSlidesData>;

function normalizeSlideIndex(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) return null;
  return value;
}

function normalizeSlideTimestamp(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : Number.NaN;
}

function normalizeSlideImageValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeSlideTextValue(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function normalizeSlideConfidenceValue(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function normalizeSlidesPayload(data: unknown): SlidesPayload | null {
  if (!data || typeof data !== "object") return null;
  const payload = data as Partial<SlidesPayload>;
  const sourceId = typeof payload.sourceId === "string" ? payload.sourceId.trim() : "";
  if (!sourceId || !Array.isArray(payload.slides)) return null;

  const slidesByIndex = new Map<number, SlidesPayload["slides"][number]>();
  for (const rawSlide of payload.slides) {
    if (!rawSlide || typeof rawSlide !== "object") continue;
    const slide = rawSlide as Partial<SlidesPayload["slides"][number]>;
    const index = normalizeSlideIndex(slide.index);
    if (index == null) continue;
    slidesByIndex.set(index, {
      index,
      timestamp: normalizeSlideTimestamp(slide.timestamp),
      imageUrl: normalizeSlideImageValue(slide.imageUrl),
      ocrText: normalizeSlideTextValue(slide.ocrText),
      ocrConfidence: normalizeSlideConfidenceValue(slide.ocrConfidence),
    });
  }
  if (slidesByIndex.size === 0) return null;

  const transcriptTimedText =
    typeof payload.transcriptTimedText === "string" ? payload.transcriptTimedText : null;

  return {
    sourceUrl: typeof payload.sourceUrl === "string" ? payload.sourceUrl : "",
    sourceId,
    sourceKind: typeof payload.sourceKind === "string" ? payload.sourceKind : "unknown",
    ...(payload.slideRuntime === "browser" || payload.slideRuntime === "daemon"
      ? { slideRuntime: payload.slideRuntime }
      : {}),
    ocrAvailable: payload.ocrAvailable === true,
    ...(transcriptTimedText ? { transcriptTimedText } : {}),
    slides: Array.from(slidesByIndex.values()).sort((a, b) => a.index - b.index),
  };
}

export function mergeSlidesPayload(prev: SlidesPayload, next: SlidesPayload): SlidesPayload {
  if (prev.sourceId !== next.sourceId) return next;
  const mergedByIndex = new Map<number, SlidesPayload["slides"][number]>();
  for (const slide of prev.slides) mergedByIndex.set(slide.index, slide);
  for (const slide of next.slides) {
    const existing = mergedByIndex.get(slide.index);
    mergedByIndex.set(slide.index, existing ? { ...existing, ...slide } : slide);
  }
  const mergedSlides = Array.from(mergedByIndex.values()).sort((a, b) => a.index - b.index);
  return {
    ...prev,
    ...next,
    slides: mergedSlides,
  };
}

export function slidesPayloadChanged(prev: SlidesPayload | null, next: SlidesPayload): boolean {
  if (!prev) return true;
  if (prev.sourceId !== next.sourceId) return true;
  if (prev.slides.length !== next.slides.length) return true;
  for (let i = 0; i < next.slides.length; i += 1) {
    const current = next.slides[i];
    const prior = prev.slides[i];
    if (!prior || current.index !== prior.index) return true;
    if (!Object.is(current.timestamp, prior.timestamp)) return true;
    if (current.imageUrl !== prior.imageUrl) return true;
    if ((current.ocrText ?? null) !== (prior.ocrText ?? null)) return true;
    if ((current.ocrConfidence ?? null) !== (prior.ocrConfidence ?? null)) return true;
  }
  if (next.ocrAvailable !== prev.ocrAvailable) return true;
  if ((next.transcriptTimedText ?? null) !== (prev.transcriptTimedText ?? null)) return true;
  if ((next.slideRuntime ?? "daemon") !== (prev.slideRuntime ?? "daemon")) return true;
  return false;
}

function shouldReplaceSlidesPayload(
  prev: SlidesPayload | null,
  next: SlidesPayload,
  opts: {
    seededSourceId?: string | null;
    activeSlidesRunId?: string | null;
    appliedSlidesRunId?: string | null;
  },
): boolean {
  if (!prev) return true;
  if (prev.sourceId !== next.sourceId) return true;
  if (opts.seededSourceId === next.sourceId) return true;
  if (opts.activeSlidesRunId && opts.appliedSlidesRunId !== opts.activeSlidesRunId) return true;

  const prevResolved = hasResolvedSlidesPayload(prev, opts.seededSourceId);
  const nextResolved = hasResolvedSlidesPayload(next, opts.seededSourceId);

  // The daemon emits full slide payload snapshots. Once we have a real image-bearing
  // payload, treat it as authoritative so stale seeded placeholders cannot linger.
  if (nextResolved) return true;
  if (!prevResolved) return true;

  return false;
}

export function resolveSlidesPayload(
  prev: SlidesPayload | null,
  next: SlidesPayload,
  opts: {
    seededSourceId?: string | null;
    activeSlidesRunId?: string | null;
    appliedSlidesRunId?: string | null;
  } = {},
): SlidesPayload {
  if (shouldReplaceSlidesPayload(prev, next, opts)) return next;
  return mergeSlidesPayload(prev, next);
}
