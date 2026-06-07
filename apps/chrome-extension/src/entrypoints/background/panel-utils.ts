import type { SummaryLength } from "../../lib/runtime-contracts";
import {
  buildSlideTextFallback,
  parseTranscriptTimedText,
  resolveSlideTextBudget,
  type SlideTimelineEntry,
} from "../../lib/slides-text";

const optionsWindowSize = { width: 940, height: 680 };
const optionsWindowMin = { width: 820, height: 560 };
const optionsWindowMargin = 20;
const MAX_SLIDE_OCR_CHARS = 8000;
const SUMMARY_LENGTHS = new Set(["short", "medium", "long", "xl", "xxl"]);

export type SlidesPayload = {
  sourceUrl: string;
  sourceId: string;
  sourceKind: string;
  ocrAvailable: boolean;
  transcriptTimedText?: string | null;
  slides: Array<{
    index: number;
    timestamp: number;
    ocrText?: string | null;
    ocrConfidence?: number | null;
  }>;
};

export function formatSlideTimestamp(seconds: number): string {
  const safe = Math.max(0, Math.floor(seconds));
  const h = Math.floor(safe / 3600);
  const m = Math.floor((safe % 3600) / 60);
  const s = safe % 60;
  const mm = m.toString().padStart(2, "0");
  const ss = s.toString().padStart(2, "0");
  return h > 0 ? `${h}:${mm}:${ss}` : `${m}:${ss}`;
}

function resolveLengthArg(
  length: string | null | undefined,
): { kind: "preset"; preset: SummaryLength } | { kind: "chars"; maxCharacters: number } {
  const normalized = (length ?? "").trim().toLowerCase();
  if (SUMMARY_LENGTHS.has(normalized)) {
    return { kind: "preset", preset: normalized as SummaryLength };
  }
  const custom = normalized.match(/^(\d+(?:\.\d+)?)(k|m)?$/);
  if (!custom) return { kind: "preset", preset: "medium" };
  const value = Number(custom[1]);
  if (!Number.isFinite(value) || value <= 0) return { kind: "preset", preset: "medium" };
  const unit = custom[2] ?? "";
  const multiplier = unit === "m" ? 1_000_000 : unit === "k" ? 1_000 : 1;
  return { kind: "chars", maxCharacters: Math.round(value * multiplier) };
}

function buildTranscriptSlidesText(
  slides: SlidesPayload,
  length: string | null | undefined,
): Map<number, string> {
  if (parseTranscriptTimedText(slides.transcriptTimedText).length === 0) return new Map();
  const timeline: SlideTimelineEntry[] = slides.slides.map((slide) => ({
    index: slide.index,
    timestamp: Number.isFinite(slide.timestamp) ? slide.timestamp : Number.NaN,
  }));
  const lengthArg = resolveLengthArg(length);
  return buildSlideTextFallback({
    slides: timeline,
    transcriptTimedText: slides.transcriptTimedText ?? null,
    lengthArg,
  });
}

export function buildSlidesText(
  slides: SlidesPayload | null,
  allowOcr: boolean,
  length?: string | null,
): { count: number; text: string } | null {
  if (!slides || slides.slides.length === 0) return null;
  let remaining = MAX_SLIDE_OCR_CHARS;
  const lines: string[] = [];
  const transcriptTextBySlide = buildTranscriptSlidesText(slides, length);
  for (const slide of slides.slides) {
    const text =
      (allowOcr ? slide.ocrText?.trim() : "") || transcriptTextBySlide.get(slide.index)?.trim();
    if (!text) continue;
    const timestamp = Number.isFinite(slide.timestamp)
      ? formatSlideTimestamp(slide.timestamp)
      : null;
    const label = timestamp ? `@ ${timestamp}` : "";
    const entry = `Slide ${slide.index} ${label}:\n${text}`.trim();
    if (entry.length > remaining && lines.length > 0) break;
    lines.push(entry);
    remaining -= entry.length;
    if (remaining <= 0) break;
  }
  if (lines.length > 0) return { count: slides.slides.length, text: lines.join("\n\n") };
  return null;
}

export function resolveOptionsUrl(): string {
  const page = chrome.runtime.getManifest().options_ui?.page ?? "options.html";
  return chrome.runtime.getURL(page);
}

function isContentTabUrl(url: string | null | undefined): url is string {
  if (!url) return false;
  return !(
    url.startsWith("chrome-extension://") ||
    url.startsWith("chrome://") ||
    url.startsWith("moz-extension://") ||
    url.startsWith("edge://") ||
    url.startsWith("about:")
  );
}

export async function openOptionsWindow() {
  const url = resolveOptionsUrl();
  try {
    if (chrome.windows?.create) {
      const current = await chrome.windows.getCurrent();
      const maxWidth = current.width
        ? Math.max(optionsWindowMin.width, current.width - optionsWindowMargin)
        : null;
      const maxHeight = current.height
        ? Math.max(optionsWindowMin.height, current.height - optionsWindowMargin)
        : null;
      const width = maxWidth
        ? Math.min(optionsWindowSize.width, maxWidth)
        : optionsWindowSize.width;
      const height = maxHeight
        ? Math.min(optionsWindowSize.height, maxHeight)
        : optionsWindowSize.height;
      await chrome.windows.create({ url, type: "popup", width, height });
      return;
    }
  } catch {
    // ignore and fall back
  }
  void chrome.runtime.openOptionsPage();
}

export async function getActiveTab(windowId?: number): Promise<chrome.tabs.Tab | null> {
  const query =
    typeof windowId === "number"
      ? { active: true, windowId }
      : { active: true, currentWindow: true };
  const [activeTab] = await chrome.tabs.query(query);
  if (isContentTabUrl(activeTab?.url)) {
    return activeTab;
  }

  const fallbackTabs = await chrome.tabs.query(
    typeof windowId === "number" ? { windowId } : { currentWindow: true },
  );
  const contentTab = fallbackTabs.find((tab) => isContentTabUrl(tab.url)) ?? null;
  return contentTab;
}

export function normalizeUrl(value: string) {
  try {
    const url = new URL(value);
    url.hash = "";
    return url.toString();
  } catch {
    return value;
  }
}

export function urlsMatch(a: string, b: string) {
  const left = normalizeUrl(a);
  const right = normalizeUrl(b);
  if (left === right) return true;
  const boundaryMatch = (longer: string, shorter: string) => {
    if (!longer.startsWith(shorter)) return false;
    if (longer.length === shorter.length) return true;
    const next = longer[shorter.length];
    return next === "/" || next === "?" || next === "&";
  };
  return boundaryMatch(left, right) || boundaryMatch(right, left);
}
