import { parseHtmlDocument } from "../../html-document.js";
import type { TranscriptSegment } from "../../link-preview/types.js";
import { isDirectMediaUrl } from "../../url.js";
import {
  jsonTranscriptToPlainText,
  jsonTranscriptToSegments,
  vttToPlainText,
  vttToSegments,
} from "../parse.js";
import { readTranscriptTextWithLimit } from "./response-size-limit.js";

export type EmbeddedTrack = {
  url: string;
  type: string | null;
  language: string | null;
};

export type EmbeddedMedia = {
  kind: "video" | "audio";
  mediaUrl: string | null;
  track: EmbeddedTrack | null;
};

export function detectEmbeddedMedia(html: string, baseUrl: string): EmbeddedMedia | null {
  const parsed = parseHtmlDocument(html);
  const { document } = parsed;

  try {
    const trackCandidates: EmbeddedTrack[] = [];
    for (const element of document.querySelectorAll(
      'track[kind="captions"], track[kind="subtitles"]',
    )) {
      const src = element.getAttribute("src")?.trim();
      if (!src) continue;
      const url = resolveAbsoluteUrl(src, baseUrl);
      if (!url) continue;
      const type = element.getAttribute("type")?.trim() ?? null;
      const language =
        element.getAttribute("srclang")?.trim() ?? element.getAttribute("lang")?.trim() ?? null;
      trackCandidates.push({ url, type, language });
    }

    const track = selectPreferredTrack(trackCandidates);
    const videoUrl = resolveFirstMediaUrl(document, baseUrl, "video");
    const audioUrl = resolveFirstMediaUrl(document, baseUrl, "audio");
    const ogVideo = resolveOgMediaUrl(document, baseUrl, "video");
    const ogAudio = resolveOgMediaUrl(document, baseUrl, "audio");

    if (videoUrl || ogVideo) {
      return { kind: "video", mediaUrl: pickMediaUrl([videoUrl, ogVideo]), track };
    }
    if (audioUrl || ogAudio) {
      return { kind: "audio", mediaUrl: pickMediaUrl([audioUrl, ogAudio]), track };
    }

    const hasVideoTag = document.querySelector("video") !== null;
    const hasAudioTag = !hasVideoTag && document.querySelector("audio") !== null;
    if (track || hasVideoTag || hasAudioTag) {
      return { kind: hasAudioTag ? "audio" : "video", mediaUrl: null, track };
    }
    return null;
  } finally {
    parsed.close();
  }
}

export async function fetchCaptionTrack(
  fetchImpl: typeof fetch,
  track: EmbeddedTrack,
  notes: string[],
  includeSegments: boolean,
): Promise<{ text: string; segments: TranscriptSegment[] | null } | null> {
  try {
    const res = await fetchImpl(track.url, {
      headers: { accept: "text/vtt,text/plain,application/json;q=0.9,*/*;q=0.8" },
    });
    if (!res.ok) {
      notes.push(`Embedded captions fetch failed (${res.status})`);
      return null;
    }
    const body = await readTranscriptTextWithLimit(res);
    const contentType = res.headers.get("content-type")?.toLowerCase() ?? "";
    const type = track.type?.toLowerCase() ?? "";

    if (type.includes("application/json") || contentType.includes("application/json")) {
      try {
        const parsed = JSON.parse(body);
        const text = jsonTranscriptToPlainText(parsed);
        if (!text) return null;
        const segments = includeSegments ? jsonTranscriptToSegments(parsed) : null;
        return { text, segments };
      } catch {
        notes.push("Embedded captions JSON parse failed");
        return null;
      }
    }

    if (
      type.includes("text/vtt") ||
      contentType.includes("text/vtt") ||
      track.url.toLowerCase().endsWith(".vtt")
    ) {
      const plain = vttToPlainText(body);
      if (plain.length === 0) return null;
      const segments = includeSegments ? vttToSegments(body) : null;
      return { text: plain, segments };
    }

    const trimmed = body.trim();
    return trimmed.length > 0 ? { text: trimmed, segments: null } : null;
  } catch (error) {
    notes.push(`Embedded captions fetch failed: ${error instanceof Error ? error.message : error}`);
    return null;
  }
}

function selectPreferredTrack(tracks: EmbeddedTrack[]): EmbeddedTrack | null {
  if (tracks.length === 0) return null;
  const normalized = tracks.map((track) => ({
    ...track,
    language: track.language?.toLowerCase() ?? null,
  }));
  const english = normalized.find((track) => track.language?.startsWith("en"));
  return english ?? normalized[0] ?? null;
}

function resolveFirstMediaUrl(
  document: Document,
  baseUrl: string,
  tag: "video" | "audio",
): string | null {
  const direct =
    document.querySelector(`${tag}[src]`)?.getAttribute("src") ??
    document.querySelector(`${tag} source[src]`)?.getAttribute("src") ??
    null;
  if (!direct) return null;
  return resolveAbsoluteUrl(direct, baseUrl);
}

function resolveOgMediaUrl(
  document: Document,
  baseUrl: string,
  kind: "video" | "audio",
): string | null {
  const meta = document
    .querySelector(
      `meta[property="og:${kind}"], meta[property="og:${kind}:url"], meta[property="og:${kind}:secure_url"], meta[name="og:${kind}"], meta[name="og:${kind}:url"], meta[name="og:${kind}:secure_url"]`,
    )
    ?.getAttribute("content");
  if (!meta) return null;
  return resolveAbsoluteUrl(meta, baseUrl);
}

function resolveAbsoluteUrl(candidate: string, baseUrl: string): string | null {
  const trimmed = candidate.trim();
  if (trimmed.length === 0) return null;
  try {
    return new URL(trimmed, baseUrl).toString();
  } catch {
    return null;
  }
}

function pickMediaUrl(candidates: Array<string | null>): string | null {
  let fallback: string | null = null;
  for (const candidate of candidates) {
    if (!candidate) continue;
    if (isDirectMediaUrl(candidate)) return candidate;
    if (!fallback) fallback = candidate;
  }
  return fallback;
}
