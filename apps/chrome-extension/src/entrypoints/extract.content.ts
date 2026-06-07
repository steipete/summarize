import { Readability } from "@mozilla/readability";
import { defineContentScript } from "wxt/utils/define-content-script";
import { META_SITE_EXCLUDE_MATCHES } from "../lib/content-script-matches";
import { resolveMediaDurationSecondsFromData } from "../lib/media-duration";
import { type SeekResponse, seekToSecondsInDocument } from "../lib/seek";

type ExtractRequest = { type: "extract"; maxChars: number; inputMode?: "page" | "video" };
type SeekRequest = { type: "seek"; seconds: number };
type SlideFrameRestoreSnapshot = {
  currentTime: number;
  paused: boolean;
  scrollX: number;
  scrollY: number;
  pageUrl?: string;
  mediaSrc?: string;
};
type BeginSlideFrameCaptureRequest = {
  type: "begin-slide-frame-capture";
  state?: SlideFrameRestoreSnapshot | null;
};
type PrepareSlideFrameRequest = { type: "prepare-slide-frame"; seconds: number };
type PrepareCurrentSlideFrameRequest = { type: "prepare-current-slide-frame" };
type RestoreSlideFrameRequest = { type: "restore-slide-frame" };
type ExtractResponse =
  | {
      ok: true;
      url: string;
      title: string | null;
      text: string;
      truncated: boolean;
      mediaDurationSeconds?: number | null;
      media?: {
        hasVideo: boolean;
        hasAudio: boolean;
        hasCaptions: boolean;
      };
    }
  | { ok: false; error: string };
type SlideFrameResponse =
  | {
      ok: true;
      url: string;
      title: string | null;
      durationSeconds: number | null;
      currentTimeSeconds?: number | null;
      rect: { x: number; y: number; width: number; height: number };
      devicePixelRatio: number;
    }
  | { ok: false; error: string };
type RestoreSlideFrameResponse = { ok: true; restored?: boolean } | { ok: false; error: string };
type SlideFrameRestoreState = {
  video: HTMLVideoElement;
  currentTime: number;
  paused: boolean;
  scrollX: number;
  scrollY: number;
  pageUrl: string;
  mediaSrc: string;
};

let slideFrameRestoreState: SlideFrameRestoreState | null = null;

function beginSlideFrameCapture(
  snapshot?: SlideFrameRestoreSnapshot | null,
): RestoreSlideFrameResponse {
  const video = findBestVideo();
  if (!video) return { ok: false, error: "No visible video found." };
  slideFrameRestoreState = {
    video,
    currentTime:
      typeof snapshot?.currentTime === "number" && Number.isFinite(snapshot.currentTime)
        ? snapshot.currentTime
        : video.currentTime,
    paused: typeof snapshot?.paused === "boolean" ? snapshot.paused : video.paused,
    scrollX:
      typeof snapshot?.scrollX === "number" && Number.isFinite(snapshot.scrollX)
        ? snapshot.scrollX
        : window.scrollX,
    scrollY:
      typeof snapshot?.scrollY === "number" && Number.isFinite(snapshot.scrollY)
        ? snapshot.scrollY
        : window.scrollY,
    pageUrl: location.href,
    mediaSrc: video.currentSrc || video.src || "",
  };
  return { ok: true };
}

type CaptionTrack = {
  baseUrl?: unknown;
  languageCode?: unknown;
  kind?: unknown;
  name?: { simpleText?: unknown; runs?: Array<{ text?: unknown }> };
};

type YouTubePlayerResponse = {
  captions?: {
    playerCaptionsTracklistRenderer?: {
      captionTracks?: CaptionTrack[];
    };
  };
  videoDetails?: {
    lengthSeconds?: unknown;
    videoId?: unknown;
  };
};

function clampText(text: string, maxChars: number): { text: string; truncated: boolean } {
  if (text.length <= maxChars) return { text, truncated: false };
  const sliced = text.slice(0, Math.max(0, maxChars - 24));
  return { text: `${sliced}\n\n[TRUNCATED]`, truncated: true };
}

function isYouTubeWatchPage() {
  return /(^|\.)youtube\.com$/i.test(location.hostname) && location.pathname === "/watch";
}

function findBalancedJsonAfter(source: string, marker: string): string | null {
  const markerIndex = source.indexOf(marker);
  if (markerIndex < 0) return null;
  const start = source.indexOf("{", markerIndex + marker.length);
  if (start < 0) return null;

  let depth = 0;
  let inString = false;
  let escape = false;
  for (let index = start; index < source.length; index += 1) {
    const char = source[index];
    if (inString) {
      if (escape) {
        escape = false;
      } else if (char === "\\") {
        escape = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }
    if (char === '"') {
      inString = true;
      continue;
    }
    if (char === "{") depth += 1;
    if (char === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(start, index + 1);
    }
  }
  return null;
}

function activeYouTubeVideoId(): string | null {
  try {
    const watchId = new URL(location.href).searchParams.get("v");
    return watchId || null;
  } catch {
    return null;
  }
}

function isCurrentYouTubePlayerResponse(
  playerResponse: YouTubePlayerResponse | null,
  requireVideoId: boolean,
): playerResponse is YouTubePlayerResponse {
  if (!playerResponse) return false;
  const activeVideo = activeYouTubeVideoId();
  if (!activeVideo) return true;
  const playerVideo = playerResponse.videoDetails?.videoId;
  if (typeof playerVideo === "string") return playerVideo === activeVideo;
  return !requireVideoId;
}

function hasYouTubeCaptionTracks(playerResponse: YouTubePlayerResponse | null): boolean {
  return Boolean(playerResponse?.captions?.playerCaptionsTracklistRenderer?.captionTracks?.length);
}

function asYouTubePlayerResponse(value: unknown): YouTubePlayerResponse | null {
  return value && typeof value === "object" ? (value as YouTubePlayerResponse) : null;
}

function parseYouTubePlayerResponse(): YouTubePlayerResponse | null {
  const flexy = document.querySelector("ytd-watch-flexy") as
    | (Element & { playerData?: unknown; playerResponse?: unknown })
    | null;
  const globalResponse = (globalThis as unknown as { ytInitialPlayerResponse?: unknown })
    .ytInitialPlayerResponse;
  const initialResponse = asYouTubePlayerResponse(globalResponse);
  const activeVideo = activeYouTubeVideoId();
  const candidates = [
    asYouTubePlayerResponse(flexy?.playerData),
    asYouTubePlayerResponse(flexy?.playerResponse),
    initialResponse,
  ];
  if (activeVideo) {
    const matching = candidates.find(
      (candidate) => candidate?.videoDetails?.videoId === activeVideo,
    );
    if (matching) return matching;
    const noIdWithTracks = candidates.find(
      (candidate) =>
        candidate &&
        typeof candidate.videoDetails?.videoId !== "string" &&
        hasYouTubeCaptionTracks(candidate),
    );
    if (noIdWithTracks) return noIdWithTracks;
  } else {
    const withTracks = candidates.find(hasYouTubeCaptionTracks);
    if (withTracks) return withTracks;
    const first = candidates.find((candidate): candidate is YouTubePlayerResponse =>
      Boolean(candidate),
    );
    if (first) return first;
  }

  for (const script of Array.from(document.querySelectorAll("script"))) {
    const text = script.textContent ?? "";
    if (!text.includes("ytInitialPlayerResponse")) continue;
    const raw = findBalancedJsonAfter(text, "ytInitialPlayerResponse");
    if (!raw) continue;
    try {
      const parsed = JSON.parse(raw) as YouTubePlayerResponse;
      if (isCurrentYouTubePlayerResponse(parsed, true)) return parsed;
    } catch {
      // Keep scanning; YouTube has several script shapes.
    }
  }
  return null;
}

function captionTrackLabel(track: CaptionTrack): string {
  const name = track.name;
  if (!name) return "";
  if (typeof name.simpleText === "string") return name.simpleText;
  if (Array.isArray(name.runs)) {
    return name.runs
      .map((run) => (typeof run.text === "string" ? run.text : ""))
      .join("")
      .trim();
  }
  return "";
}

function sortCaptionTracks(tracks: CaptionTrack[]): CaptionTrack[] {
  const candidates = tracks.filter((track) => typeof track.baseUrl === "string");
  const score = (track: CaptionTrack) => {
    const language = typeof track.languageCode === "string" ? track.languageCode.toLowerCase() : "";
    const label = captionTrackLabel(track).toLowerCase();
    const isAutomatic = track.kind === "asr" || label.includes("auto-generated");
    return [
      language === "en" || language.startsWith("en-") ? 0 : 10,
      isAutomatic ? 1 : 0,
      label.includes("english") ? 0 : 1,
    ].join(":");
  };
  return candidates.sort((left, right) => score(left).localeCompare(score(right)));
}

function formatTimestamp(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const two = (value: number) => String(value).padStart(2, "0");
  return hours > 0 ? `${hours}:${two(minutes)}:${two(seconds)}` : `${minutes}:${two(seconds)}`;
}

function normalizeCaptionText(text: string): string {
  return text
    .replace(/\s+/g, " ")
    .replace(/&nbsp;/g, " ")
    .trim();
}

function parseJson3Transcript(raw: string): Array<{ startMs: number | null; text: string }> {
  const data = JSON.parse(raw) as {
    events?: Array<{ tStartMs?: number; segs?: Array<{ utf8?: string }> }>;
  };
  return (data.events ?? [])
    .map((event) => ({
      startMs: typeof event.tStartMs === "number" ? event.tStartMs : null,
      text: normalizeCaptionText((event.segs ?? []).map((seg) => seg.utf8 ?? "").join("")),
    }))
    .filter((line) => line.text.length > 0);
}

function parseXmlTranscript(raw: string): Array<{ startMs: number | null; text: string }> {
  const doc = new DOMParser().parseFromString(raw, "text/xml");
  return Array.from(doc.querySelectorAll("text"))
    .map((node) => {
      const start = Number(node.getAttribute("start"));
      return {
        startMs: Number.isFinite(start) ? Math.round(start * 1000) : null,
        text: normalizeCaptionText(node.textContent ?? ""),
      };
    })
    .filter((line) => line.text.length > 0);
}

function parseVttTranscript(raw: string): Array<{ startMs: number | null; text: string }> {
  const lines: Array<{ startMs: number | null; text: string }> = [];
  let pendingStart: number | null = null;
  let pendingText: string[] = [];
  const flush = () => {
    const text = normalizeCaptionText(pendingText.join(" "));
    if (text) lines.push({ startMs: pendingStart, text });
    pendingStart = null;
    pendingText = [];
  };
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) {
      flush();
      continue;
    }
    const timing = trimmed.match(/^(\d{2}:)?(\d{2}):(\d{2})\.(\d{3})\s+-->/);
    if (timing) {
      flush();
      const parts = trimmed.split(/\s+-->\s+/)[0].split(":");
      const secondsPart = parts.pop() ?? "0";
      const minutes = Number(parts.pop() ?? "0");
      const hours = Number(parts.pop() ?? "0");
      const seconds = Number(secondsPart);
      pendingStart = Math.round(((hours * 60 + minutes) * 60 + seconds) * 1000);
      continue;
    }
    if (trimmed === "WEBVTT" || /^\d+$/.test(trimmed)) continue;
    pendingText.push(trimmed);
  }
  flush();
  return lines;
}

function captionUrls(baseUrl: string): string[] {
  const urls: string[] = [];
  const withFormat = (format: string) => {
    const url = new URL(baseUrl);
    url.searchParams.set("fmt", format);
    return url.toString();
  };
  urls.push(withFormat("json3"));
  urls.push(baseUrl);
  urls.push(withFormat("vtt"));
  return Array.from(new Set(urls));
}

async function fetchCaptionUrl(url: string, timeoutMs = 5000): Promise<Response> {
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { signal: controller.signal });
  } finally {
    window.clearTimeout(timer);
  }
}

async function fetchCaptionLines(
  track: CaptionTrack,
): Promise<Array<{ startMs: number | null; text: string }>> {
  if (typeof track.baseUrl !== "string") return [];
  for (const url of captionUrls(track.baseUrl)) {
    try {
      const res = await fetchCaptionUrl(url);
      if (!res.ok) continue;
      const raw = (await res.text()).trim();
      if (!raw) continue;
      const lines = raw.startsWith("{")
        ? parseJson3Transcript(raw)
        : raw.startsWith("WEBVTT")
          ? parseVttTranscript(raw)
          : parseXmlTranscript(raw);
      if (lines.length > 0) return lines;
    } catch {
      // Try the next track/format.
    }
  }
  return [];
}

async function fetchYouTubeTranscript(maxChars: number): Promise<{
  text: string;
  truncated: boolean;
  durationSeconds: number | null;
} | null> {
  const playerResponse = parseYouTubePlayerResponse();
  const tracks = playerResponse?.captions?.playerCaptionsTracklistRenderer?.captionTracks ?? [];
  let captionLines: Array<{ startMs: number | null; text: string }> | null = null;
  for (const track of sortCaptionTracks(tracks)) {
    const lines = await fetchCaptionLines(track);
    if (lines.length > 0) {
      captionLines = lines;
      break;
    }
  }
  if (!captionLines) return null;
  const lines = captionLines.map((line) =>
    typeof line.startMs === "number"
      ? `[${formatTimestamp(line.startMs)}] ${line.text}`
      : line.text,
  );
  const raw = lines.join("\n").trim();
  if (!raw) return null;
  const clamped = clampText(`Transcript:\n${raw}`, maxChars);
  const durationSeconds =
    typeof playerResponse?.videoDetails?.lengthSeconds === "string"
      ? Number(playerResponse.videoDetails.lengthSeconds)
      : null;
  return {
    text: clamped.text,
    truncated: clamped.truncated,
    durationSeconds: Number.isFinite(durationSeconds) ? durationSeconds : null,
  };
}

function resolveMediaDurationSeconds(): number | null {
  const metaDuration = document.querySelector('meta[itemprop="duration"]')?.getAttribute("content");
  const uiDuration = document.querySelector(".ytp-time-duration")?.textContent?.trim();
  const media = document.querySelector("video");
  const videoDuration =
    media && typeof (media as HTMLVideoElement).duration === "number"
      ? (media as HTMLVideoElement).duration
      : null;
  return resolveMediaDurationSecondsFromData({ metaDuration, uiDuration, videoDuration });
}

const VIDEO_IFRAME_PATTERNS = [
  /youtube\.com/i,
  /youtu\.be/i,
  /youtube-nocookie\.com/i,
  /player\.vimeo\.com/i,
  /vimeo\.com\/video/i,
  /player\.twitch\.tv/i,
  /fast\.wistia\.net/i,
  /wistia\.com/i,
];

const AUDIO_IFRAME_PATTERNS = [
  /open\.spotify\.com/i,
  /spotify\.com\/embed/i,
  /soundcloud\.com/i,
  /podcasts\.apple\.com/i,
  /overcast\.fm/i,
  /pca\.st/i,
  /anchor\.fm/i,
];

function hasMetaTag(selectors: string[]): boolean {
  return selectors.some((selector) => Boolean(document.querySelector(selector)));
}

function hasEmbeddedFrame(patterns: RegExp[]): boolean {
  const frames = Array.from(document.querySelectorAll("iframe[src]")) as HTMLIFrameElement[];
  return frames.some((frame) => patterns.some((pattern) => pattern.test(frame.src)));
}

function detectMediaInfo(): { hasVideo: boolean; hasAudio: boolean; hasCaptions: boolean } {
  const hasVideoTag = Boolean(document.querySelector("video"));
  const hasAudioTag = Boolean(document.querySelector("audio"));
  const hasCaptions = Boolean(
    document.querySelector('track[kind="captions"], track[kind="subtitles"]'),
  );
  const hasOgVideo = hasMetaTag([
    'meta[property="og:video"]',
    'meta[property="og:video:url"]',
    'meta[property="og:video:secure_url"]',
    'meta[name="og:video"]',
    'meta[name="og:video:url"]',
    'meta[name="og:video:secure_url"]',
    'meta[name="twitter:player"]',
  ]);
  const hasOgAudio = hasMetaTag([
    'meta[property="og:audio"]',
    'meta[property="og:audio:url"]',
    'meta[property="og:audio:secure_url"]',
    'meta[name="og:audio"]',
    'meta[name="og:audio:url"]',
    'meta[name="og:audio:secure_url"]',
  ]);
  const hasVideoEmbed = hasEmbeddedFrame(VIDEO_IFRAME_PATTERNS);
  const hasAudioEmbed = hasEmbeddedFrame(AUDIO_IFRAME_PATTERNS);
  const hasVideo = hasVideoTag || hasOgVideo || hasVideoEmbed;
  const hasAudio = hasAudioTag || hasOgAudio || hasAudioEmbed;
  return { hasVideo, hasAudio, hasCaptions };
}

async function extract(maxChars: number, inputMode?: "page" | "video"): Promise<ExtractResponse> {
  try {
    const url = location.href;
    const title = document.title || null;
    const mediaDurationSeconds = resolveMediaDurationSeconds();
    const media = detectMediaInfo();
    if (inputMode === "video" && isYouTubeWatchPage()) {
      const transcript = await fetchYouTubeTranscript(maxChars);
      if (transcript) {
        return {
          ok: true,
          url,
          title,
          text: transcript.text,
          truncated: transcript.truncated,
          mediaDurationSeconds: transcript.durationSeconds ?? mediaDurationSeconds,
          media: { ...media, hasCaptions: true },
        };
      }
    }
    const cloned = document.cloneNode(true) as Document;
    const reader = new Readability(cloned, { keepClasses: false });
    const parsed = reader.parse();
    const raw = parsed?.textContent?.trim() || document.body?.innerText?.trim() || "";
    if (!raw) {
      if (mediaDurationSeconds || media.hasVideo || media.hasAudio || media.hasCaptions) {
        return {
          ok: true,
          url,
          title,
          text: "",
          truncated: false,
          mediaDurationSeconds,
          media,
        };
      }
      return { ok: false, error: "No readable text found." };
    }
    const clamped = clampText(raw, maxChars);
    return {
      ok: true,
      url,
      title: parsed?.title?.trim() || title,
      text: clamped.text,
      truncated: clamped.truncated,
      mediaDurationSeconds,
      media,
    };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Extraction failed" };
  }
}

function seekToSeconds(seconds: number): SeekResponse {
  return seekToSecondsInDocument(document, seconds);
}

function findBestVideo(): HTMLVideoElement | null {
  const videos = Array.from(document.querySelectorAll("video")) as HTMLVideoElement[];
  let best: { video: HTMLVideoElement; area: number } | null = null;
  for (const video of videos) {
    const rect = video.getBoundingClientRect();
    const area = Math.max(0, rect.width) * Math.max(0, rect.height);
    if (area <= 0) continue;
    if (video.readyState <= HTMLMediaElement.HAVE_NOTHING && !Number.isFinite(video.duration)) {
      continue;
    }
    if (!best || area > best.area) best = { video, area };
  }
  return best?.video ?? null;
}

function waitForEventOrTimeout(target: EventTarget, eventName: string, timeoutMs: number) {
  return new Promise<void>((resolve) => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const cleanup = () => {
      if (timer) window.clearTimeout(timer);
      target.removeEventListener(eventName, onEvent);
      resolve();
    };
    const onEvent = () => cleanup();
    timer = window.setTimeout(cleanup, timeoutMs);
    target.addEventListener(eventName, onEvent, { once: true });
  });
}

function waitForVideoFrame(video: HTMLVideoElement, timeoutMs = 1200) {
  return new Promise<void>((resolve) => {
    const callback = (
      video as HTMLVideoElement & {
        requestVideoFrameCallback?: (callback: () => void) => number;
      }
    ).requestVideoFrameCallback;
    if (typeof callback !== "function") {
      window.setTimeout(resolve, 120);
      return;
    }
    const timer = window.setTimeout(resolve, timeoutMs);
    callback.call(video, () => {
      window.clearTimeout(timer);
      resolve();
    });
  });
}

async function prepareSlideFrame(seconds: number): Promise<SlideFrameResponse> {
  try {
    const video = findBestVideo();
    if (!video) return { ok: false, error: "No visible video found." };
    slideFrameRestoreState ??= {
      video,
      currentTime: video.currentTime,
      paused: video.paused,
      scrollX: window.scrollX,
      scrollY: window.scrollY,
      pageUrl: location.href,
      mediaSrc: video.currentSrc || video.src || "",
    };
    video.scrollIntoView({ block: "center", inline: "center" });
    await new Promise((resolve) => window.setTimeout(resolve, 80));

    const duration = Number.isFinite(video.duration) && video.duration > 0 ? video.duration : null;
    if (duration === null) return { ok: false, error: "Video duration is not available yet." };
    const targetSeconds = Math.min(Math.max(0, seconds), Math.max(0, duration - 0.1));
    video.pause();
    if (Math.abs(video.currentTime - targetSeconds) > 0.05) {
      const seekDone = waitForEventOrTimeout(video, "seeked", 1800);
      video.currentTime = targetSeconds;
      await seekDone;
    }
    await waitForVideoFrame(video);

    const rect = video.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) {
      return { ok: false, error: "Video is not visible." };
    }
    return {
      ok: true,
      url: location.href,
      title: document.title || null,
      durationSeconds: duration,
      currentTimeSeconds: targetSeconds,
      rect: {
        x: rect.left,
        y: rect.top,
        width: rect.width,
        height: rect.height,
      },
      devicePixelRatio: window.devicePixelRatio || 1,
    };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Frame capture failed" };
  }
}

async function prepareCurrentSlideFrame(): Promise<SlideFrameResponse> {
  try {
    const video = findBestVideo();
    if (!video) return { ok: false, error: "No visible video found." };
    await waitForVideoFrame(video, 350);
    const rect = video.getBoundingClientRect();
    const viewportWidth = window.innerWidth || document.documentElement.clientWidth || 0;
    const viewportHeight = window.innerHeight || document.documentElement.clientHeight || 0;
    const visible =
      rect.width > 0 &&
      rect.height > 0 &&
      rect.bottom > 0 &&
      rect.right > 0 &&
      rect.left < viewportWidth &&
      rect.top < viewportHeight;
    if (!visible) return { ok: false, error: "Video is not visible." };
    const duration = Number.isFinite(video.duration) && video.duration > 0 ? video.duration : null;
    return {
      ok: true,
      url: location.href,
      title: document.title || null,
      durationSeconds: duration,
      currentTimeSeconds: Number.isFinite(video.currentTime) ? video.currentTime : null,
      rect: {
        x: rect.left,
        y: rect.top,
        width: rect.width,
        height: rect.height,
      },
      devicePixelRatio: window.devicePixelRatio || 1,
    };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Frame capture failed" };
  }
}

async function restoreSlideFrame(): Promise<RestoreSlideFrameResponse> {
  const state = slideFrameRestoreState;
  slideFrameRestoreState = null;
  if (!state) return { ok: true, restored: false };
  try {
    const currentMediaSrc = state.video.currentSrc || state.video.src || "";
    if (location.href !== state.pageUrl || (state.mediaSrc && currentMediaSrc !== state.mediaSrc)) {
      return { ok: true, restored: false };
    }
    const targetSeconds = Math.max(0, state.currentTime);
    state.video.pause();
    if (Math.abs(state.video.currentTime - targetSeconds) > 0.05) {
      const seekDone = waitForEventOrTimeout(state.video, "seeked", 1800);
      state.video.currentTime = targetSeconds;
      await seekDone;
    }
    if (!state.paused) {
      await state.video.play().catch(() => undefined);
    }
    window.scrollTo(state.scrollX, state.scrollY);
    return { ok: true, restored: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Frame restore failed" };
  }
}

export default defineContentScript({
  matches: ["<all_urls>"],
  excludeMatches: META_SITE_EXCLUDE_MATCHES,
  runAt: "document_idle",
  main() {
    const flag = "__summarize_extract_installed__";
    if ((globalThis as unknown as Record<string, unknown>)[flag]) return;
    (globalThis as unknown as Record<string, unknown>)[flag] = true;

    chrome.runtime.onMessage.addListener(
      (
        message:
          | ExtractRequest
          | SeekRequest
          | BeginSlideFrameCaptureRequest
          | PrepareSlideFrameRequest
          | PrepareCurrentSlideFrameRequest
          | RestoreSlideFrameRequest,
        _sender,
        sendResponse: (
          response: ExtractResponse | SeekResponse | SlideFrameResponse | RestoreSlideFrameResponse,
        ) => void,
      ) => {
        if (message?.type === "extract") {
          void extract(message.maxChars, message.inputMode).then(sendResponse);
          return true;
        }
        if (message?.type === "seek") {
          sendResponse(seekToSeconds(message.seconds));
          return true;
        }
        if (message?.type === "begin-slide-frame-capture") {
          sendResponse(beginSlideFrameCapture(message.state));
          return true;
        }
        if (message?.type === "prepare-slide-frame") {
          void prepareSlideFrame(message.seconds).then(sendResponse);
          return true;
        }
        if (message?.type === "prepare-current-slide-frame") {
          void prepareCurrentSlideFrame().then(sendResponse);
          return true;
        }
        if (message?.type === "restore-slide-frame") {
          void restoreSlideFrame().then(sendResponse);
          return true;
        }
        return undefined;
      },
    );
  },
});
