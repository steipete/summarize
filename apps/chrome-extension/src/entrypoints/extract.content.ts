import { Readability } from "@mozilla/readability";
import { defineContentScript } from "wxt/utils/define-content-script";
import { deniedSiteError, isDeniedHost } from "../lib/denylist";
import { resolveMediaDurationSecondsFromData } from "../lib/media-duration";
import { type SeekResponse, seekToSecondsInDocument } from "../lib/seek";

type ExtractRequest = { type: "extract"; maxChars: number };
type SeekRequest = { type: "seek"; seconds: number };
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

function clampText(text: string, maxChars: number): { text: string; truncated: boolean } {
  if (text.length <= maxChars) return { text, truncated: false };
  const sliced = text.slice(0, Math.max(0, maxChars - 24));
  return { text: `${sliced}\n\n[TRUNCATED]`, truncated: true };
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

function extract(maxChars: number): ExtractResponse {
  try {
    const url = location.href;
    const title = document.title || null;
    const mediaDurationSeconds = resolveMediaDurationSeconds();
    const media = detectMediaInfo();
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

export default defineContentScript({
  matches: ["<all_urls>"],
  runAt: "document_idle",
  main() {
    const flag = "__summarize_extract_installed__";
    if ((globalThis as unknown as Record<string, unknown>)[flag]) return;
    (globalThis as unknown as Record<string, unknown>)[flag] = true;

    const denied = isDeniedHost(location.hostname);

    chrome.runtime.onMessage.addListener(
      (
        message: ExtractRequest | SeekRequest,
        _sender,
        sendResponse: (response: ExtractResponse | SeekResponse) => void,
      ) => {
        if (message?.type === "extract") {
          sendResponse(
            denied
              ? { ok: false, error: deniedSiteError(location.hostname) }
              : extract(message.maxChars),
          );
          return true;
        }
        if (message?.type === "seek") {
          sendResponse(
            denied
              ? { ok: false, error: deniedSiteError(location.hostname) }
              : seekToSeconds(message.seconds),
          );
          return true;
        }
        return undefined;
      },
    );
  },
});
