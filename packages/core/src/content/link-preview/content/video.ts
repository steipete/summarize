import { parseHtmlDocument } from "../../html-document.js";
import { extractYouTubeVideoId, isLoomVideoUrl, isYouTubeUrl } from "../../url.js";
import type { EmbeddedVideoMode, MediaTranscriptMode, YoutubeTranscriptMode } from "./types.js";

export type DetectedVideo = {
  kind: "youtube" | "direct";
  url: string;
};

export type PrimaryVideoDetection = {
  video: DetectedVideo;
  source: "iframe" | "open-graph" | "video-tag";
  confidence: "high" | "medium";
};

export type EmbeddedYoutubeDecision = {
  detection: PrimaryVideoDetection | null;
  shouldUse: boolean;
  youtubeTranscriptMode: YoutubeTranscriptMode;
  mediaTranscriptMode: MediaTranscriptMode;
  notes: string | null;
};

const VIDEO_EXTENSIONS = new Set([".mp4", ".webm", ".mov", ".m4v", ".m3u8"]);

function resolveAbsoluteUrl(candidate: string, baseUrl: string): string | null {
  const trimmed = candidate.trim();
  if (trimmed.length === 0) return null;
  try {
    return new URL(trimmed, baseUrl).toString();
  } catch {
    return null;
  }
}

function isDirectVideoUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
    const lower = parsed.pathname.toLowerCase();
    for (const ext of VIDEO_EXTENSIONS) {
      if (lower.endsWith(ext)) return true;
    }
    return false;
  } catch {
    return false;
  }
}

function metaContent(
  document: Document,
  selectors: Array<{ attribute: "property" | "name"; value: string }>,
): string | null {
  for (const sel of selectors) {
    const meta = document.querySelector(`meta[${sel.attribute}="${sel.value}"]`);
    if (!meta) continue;
    const value = (meta.getAttribute("content") ?? meta.getAttribute("value") ?? "").trim();
    if (value) return value;
  }
  return null;
}

function toYoutubeVideo(raw: string, baseUrl: string): DetectedVideo | null {
  const resolved = resolveAbsoluteUrl(raw, baseUrl);
  const videoId = (() => {
    if (!resolved) return null;
    const standardId = extractYouTubeVideoId(resolved);
    if (standardId) return standardId;
    try {
      const parsed = new URL(resolved);
      const host = parsed.hostname.toLowerCase().replace(/^www\./, "");
      if (host !== "youtube-nocookie.com" && !host.endsWith(".youtube-nocookie.com")) {
        return null;
      }
      return parsed.pathname.match(/\/embed\/([a-zA-Z0-9_-]{11})/)?.[1] ?? null;
    } catch {
      return null;
    }
  })();
  return videoId ? { kind: "youtube", url: `https://www.youtube.com/watch?v=${videoId}` } : null;
}

export function detectPrimaryVideoDetailsFromHtml(
  html: string,
  url: string,
): PrimaryVideoDetection | null {
  if (isLoomVideoUrl(url)) return null;
  const parsed = parseHtmlDocument(html);
  const { document } = parsed;

  try {
    const ogVideo = metaContent(document, [
      { attribute: "property", value: "og:video" },
      { attribute: "property", value: "og:video:url" },
      { attribute: "property", value: "og:video:secure_url" },
      { attribute: "name", value: "og:video" },
      { attribute: "name", value: "og:video:url" },
      { attribute: "name", value: "og:video:secure_url" },
    ]);
    const ogYoutubeVideo = ogVideo ? toYoutubeVideo(ogVideo, url) : null;
    const iframeCandidates = Array.from(
      document.querySelectorAll(
        'iframe[src*="youtube.com/embed/"], iframe[src*="youtube-nocookie.com/embed/"], iframe[src*="youtu.be/"]',
      ),
    )
      .map((element) => {
        const src = element.getAttribute("src");
        const video = src ? toYoutubeVideo(src, url) : null;
        return video ? { element, video } : null;
      })
      .filter(
        (
          candidate,
        ): candidate is {
          element: Element;
          video: DetectedVideo;
        } => candidate !== null,
      );
    if (iframeCandidates.length > 0) {
      const uniqueUrls = new Set(iframeCandidates.map((candidate) => candidate.video.url));
      if (uniqueUrls.size === 1) {
        if (ogYoutubeVideo && !uniqueUrls.has(ogYoutubeVideo.url)) {
          return { video: iframeCandidates[0]!.video, source: "iframe", confidence: "medium" };
        }
        return { video: iframeCandidates[0]!.video, source: "iframe", confidence: "high" };
      }
      if (
        ogYoutubeVideo &&
        iframeCandidates.some((candidate) => candidate.video.url === ogYoutubeVideo.url)
      ) {
        return { video: ogYoutubeVideo, source: "open-graph", confidence: "high" };
      }
      const mainCandidates = iframeCandidates.filter((candidate) =>
        candidate.element.closest("article, main, [role=main]"),
      );
      const uniqueMainUrls = new Set(mainCandidates.map((candidate) => candidate.video.url));
      if (uniqueMainUrls.size === 1 && mainCandidates[0]) {
        return { video: mainCandidates[0].video, source: "iframe", confidence: "high" };
      }
      return { video: iframeCandidates[0]!.video, source: "iframe", confidence: "medium" };
    }

    if (ogVideo) {
      const resolved = resolveAbsoluteUrl(ogVideo, url);
      if (resolved && isDirectVideoUrl(resolved)) {
        return {
          video: { kind: "direct", url: resolved },
          source: "open-graph",
          confidence: "high",
        };
      }
      if (ogYoutubeVideo) {
        return { video: ogYoutubeVideo, source: "open-graph", confidence: "high" };
      }
    }

    const videoSrc =
      document.querySelector("video[src]")?.getAttribute("src") ??
      document.querySelector("video source[src]")?.getAttribute("src") ??
      null;
    if (videoSrc) {
      const resolved = resolveAbsoluteUrl(videoSrc, url);
      if (resolved && isDirectVideoUrl(resolved)) {
        return {
          video: { kind: "direct", url: resolved },
          source: "video-tag",
          confidence: "high",
        };
      }
    }

    return null;
  } finally {
    parsed.close();
  }
}

export function detectPrimaryVideoFromHtml(html: string, url: string): DetectedVideo | null {
  return detectPrimaryVideoDetailsFromHtml(html, url)?.video ?? null;
}

export function resolveEmbeddedYoutubeDecision({
  pageUrl,
  detection,
  mode,
  youtubeTranscriptMode,
  mediaTranscriptMode,
}: {
  pageUrl: string;
  detection: PrimaryVideoDetection | null;
  mode: EmbeddedVideoMode;
  youtubeTranscriptMode: YoutubeTranscriptMode;
  mediaTranscriptMode: MediaTranscriptMode;
}): EmbeddedYoutubeDecision {
  const embeddedDetection =
    !isYouTubeUrl(pageUrl) && detection?.video.kind === "youtube" ? detection : null;
  const shouldUse =
    embeddedDetection !== null &&
    mode !== "off" &&
    (mode !== "auto" || embeddedDetection.confidence === "high");
  const resolvedMediaTranscriptMode =
    embeddedDetection && mode === "off" ? "auto" : mediaTranscriptMode;
  const resolvedYoutubeTranscriptMode =
    shouldUse && resolvedMediaTranscriptMode !== "prefer" && youtubeTranscriptMode === "auto"
      ? "web"
      : youtubeTranscriptMode;
  const notes =
    embeddedDetection?.confidence === "medium" && mode === "auto"
      ? "Multiple embedded YouTube videos were ambiguous; automatic transcript use skipped"
      : shouldUse && resolvedYoutubeTranscriptMode === "web"
        ? "Automatic embedded YouTube use is captions-only"
        : null;
  return {
    detection: embeddedDetection,
    shouldUse,
    youtubeTranscriptMode: resolvedYoutubeTranscriptMode,
    mediaTranscriptMode: resolvedMediaTranscriptMode,
    notes,
  };
}
