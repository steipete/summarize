import type { SseSlidesData } from "../../lib/runtime-contracts";
import type { SlideFrameRestoreSnapshot, SlideFrameResponse } from "./content-script-bridge";

type PreparedFrame = SlideFrameResponse & { ok: true };

const MAX_LOCAL_SLIDES = 6;
const MAX_BROWSER_SLIDE_PAYLOADS = 8;
const BROWSER_SLIDE_PAYLOAD_TTL_MS = 5 * 60 * 1000;
const VISIBLE_TAB_CAPTURE_INTERVAL_MS = 700;
const MAX_THUMBNAIL_WIDTH = 960;
const MAX_THUMBNAIL_HEIGHT = 540;
const THUMBNAIL_JPEG_QUALITY = 0.72;
const browserSlidesByRunId = new Map<
  string,
  { slides: SseSlidesData; expiresAt: number; createdAt: number }
>();

function makeRunId() {
  const random =
    typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return `browser-${random}`;
}

function chooseTimestamps(durationSeconds: number | null, maxSlides = MAX_LOCAL_SLIDES): number[] {
  if (!durationSeconds || durationSeconds <= 0 || !Number.isFinite(durationSeconds)) return [0];
  const count = Math.min(maxSlides, Math.max(1, Math.ceil(durationSeconds / 2)));
  const step = durationSeconds / count;
  return Array.from({ length: count }, (_value, index) =>
    Math.max(0, Math.min(durationSeconds - 0.1, index * step + Math.min(0.4, step / 3))),
  );
}

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function blobToDataUrl(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const chunkSize = 0x8000;
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.slice(offset, offset + chunkSize));
  }
  return `data:${blob.type || "image/png"};base64,${btoa(binary)}`;
}

async function cropVisibleTabCapture(dataUrl: string, frame: PreparedFrame): Promise<string> {
  const res = await fetch(dataUrl);
  const blob = await res.blob();
  const image = await createImageBitmap(blob);
  const ratio = frame.devicePixelRatio || 1;
  const sx = clamp(Math.round(frame.rect.x * ratio), 0, Math.max(0, image.width - 1));
  const sy = clamp(Math.round(frame.rect.y * ratio), 0, Math.max(0, image.height - 1));
  const sw = clamp(Math.round(frame.rect.width * ratio), 1, image.width - sx);
  const sh = clamp(Math.round(frame.rect.height * ratio), 1, image.height - sy);
  const scale = Math.min(1, MAX_THUMBNAIL_WIDTH / sw, MAX_THUMBNAIL_HEIGHT / sh);
  const dw = Math.max(1, Math.round(sw * scale));
  const dh = Math.max(1, Math.round(sh * scale));
  const canvas = new OffscreenCanvas(dw, dh);
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Could not prepare slide canvas");
  ctx.drawImage(image, sx, sy, sw, sh, 0, 0, dw, dh);
  const cropped = await canvas.convertToBlob({
    type: "image/jpeg",
    quality: THUMBNAIL_JPEG_QUALITY,
  });
  return await blobToDataUrl(cropped);
}

export function getBrowserSlidesPayload(runId: string): SseSlidesData | null {
  return browserSlidesByRunId.get(runId)?.slides ?? null;
}

export function takeBrowserSlidesPayload(runId: string): SseSlidesData | null {
  const stored = browserSlidesByRunId.get(runId);
  if (!stored || stored.expiresAt <= Date.now()) return null;
  return stored.slides;
}

function pruneBrowserSlidesPayloads(now = Date.now()) {
  for (const [runId, stored] of browserSlidesByRunId) {
    if (stored.expiresAt <= now) browserSlidesByRunId.delete(runId);
  }
  while (browserSlidesByRunId.size > MAX_BROWSER_SLIDE_PAYLOADS) {
    const oldest = Array.from(browserSlidesByRunId.entries()).sort(
      ([_leftId, left], [_rightId, right]) => left.createdAt - right.createdAt,
    )[0]?.[0];
    if (!oldest) return;
    browserSlidesByRunId.delete(oldest);
  }
}

export async function runBrowserSlidesForTab(args: {
  tab: chrome.tabs.Tab;
  windowId: number;
  prepareFrame: (
    tabId: number,
    seconds: number,
  ) => Promise<{ ok: true; data: PreparedFrame } | { ok: false; error: string }>;
  prepareCurrentFrame?: (
    tabId: number,
  ) => Promise<{ ok: true; data: PreparedFrame } | { ok: false; error: string }>;
  beginFrameCapture?: (
    tabId: number,
  ) => Promise<
    { ok: true; state: SlideFrameRestoreSnapshot | null } | { ok: false; error: string }
  >;
  restoreFrame?: (
    tabId: number,
    state?: SlideFrameRestoreSnapshot | null,
  ) => Promise<{ ok: true } | { ok: false; error: string }>;
  transcriptTimedText?: string | null;
  maxSlides?: number;
  captureMode?: "seek" | "current";
}): Promise<{ ok: true; runId: string; slides: SseSlidesData } | { ok: false; error: string }> {
  const tabId = args.tab.id;
  if (typeof tabId !== "number") return { ok: false, error: "No active tab to capture." };
  if (typeof chrome.tabs.captureVisibleTab !== "function") {
    return { ok: false, error: "Visible tab capture is not available in this browser." };
  }

  let expectedUrl = args.tab.url ?? null;
  const ensureOriginalTabIsActive = async () => {
    const [activeTab] = await chrome.tabs.query({ active: true, windowId: args.windowId });
    return activeTab?.id === tabId && (!expectedUrl || activeTab.url === expectedUrl);
  };

  const captureMode = args.captureMode ?? "seek";
  let restoreState: SlideFrameRestoreSnapshot | null = null;
  try {
    if (!(await ensureOriginalTabIsActive())) {
      return { ok: false, error: "Slide capture cancelled because the active tab changed." };
    }
    if (captureMode === "seek") {
      const begin = await args.beginFrameCapture?.(tabId);
      if (begin && !begin.ok) return begin;
      restoreState = begin?.state ?? null;
    }
    const first =
      captureMode === "current"
        ? await args.prepareCurrentFrame?.(tabId)
        : await args.prepareFrame(tabId, 0.4);
    if (!first) return { ok: false, error: "Current frame capture is not available." };
    if (!first.ok) return first;
    expectedUrl = first.data.url || expectedUrl;
    const timestamps =
      captureMode === "current"
        ? [
            typeof first.data.currentTimeSeconds === "number" &&
            Number.isFinite(first.data.currentTimeSeconds)
              ? first.data.currentTimeSeconds
              : 0,
          ]
        : chooseTimestamps(first.data.durationSeconds, args.maxSlides);
    const slides: SseSlidesData["slides"] = [];
    let lastCaptureAt = 0;

    for (const [index, timestamp] of timestamps.entries()) {
      const prepared = index === 0 ? first : await args.prepareFrame(tabId, timestamp);
      if (!prepared.ok) {
        if (slides.length === 0) return prepared;
        continue;
      }
      const elapsed = Date.now() - lastCaptureAt;
      if (elapsed < VISIBLE_TAB_CAPTURE_INTERVAL_MS) {
        await delay(VISIBLE_TAB_CAPTURE_INTERVAL_MS - elapsed);
      }
      if (!(await ensureOriginalTabIsActive())) {
        return { ok: false, error: "Slide capture cancelled because the active tab changed." };
      }
      const capture = await chrome.tabs.captureVisibleTab(args.windowId, { format: "png" });
      lastCaptureAt = Date.now();
      if (!(await ensureOriginalTabIsActive())) {
        return { ok: false, error: "Slide capture cancelled because the active tab changed." };
      }
      const imageUrl = await cropVisibleTabCapture(capture, prepared.data);
      slides.push({
        index: index + 1,
        timestamp,
        imageUrl,
        ocrText: null,
        ocrConfidence: null,
      });
    }

    if (slides.length === 0) return { ok: false, error: "No slide frames captured." };

    const runId = makeRunId();
    const slidesPayload: SseSlidesData = {
      sourceUrl: first.data.url || args.tab.url || "",
      sourceId: runId,
      sourceKind: "browser-capture",
      slideRuntime: "browser",
      ocrAvailable: false,
      transcriptTimedText: args.transcriptTimedText?.trim() || null,
      slides,
    };
    const now = Date.now();
    pruneBrowserSlidesPayloads(now);
    browserSlidesByRunId.set(runId, {
      slides: slidesPayload,
      createdAt: now,
      expiresAt: now + BROWSER_SLIDE_PAYLOAD_TTL_MS,
    });
    pruneBrowserSlidesPayloads(now);
    return { ok: true, runId, slides: slidesPayload };
  } finally {
    if (captureMode === "seek") {
      await args.restoreFrame?.(tabId, restoreState).catch(() => null);
    }
  }
}
