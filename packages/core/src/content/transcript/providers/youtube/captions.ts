import type { TranscriptSegment } from "../../../link-preview/types.js";
import { fetchWithTimeout } from "../../../link-preview/fetch-with-timeout.js";
import { parseTimestampToMs } from "../../timestamps.js";
import { decodeHtmlEntities, sanitizeYoutubeJsonResponse } from "../../utils.js";
import { extractYoutubeiBootstrap } from "./api.js";

interface YoutubeTranscriptContext {
  html: string;
  originalUrl: string;
  videoId: string;
}

type TranscriptPayload = {
  text: string;
  segments: TranscriptSegment[] | null;
};

const REQUEST_HEADERS: Record<string, string> = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36",
  "Accept-Encoding": "gzip, deflate",
  "Accept-Language": "en-US,en;q=0.9",
};

const YT_INITIAL_PLAYER_RESPONSE_TOKEN = "ytInitialPlayerResponse";
const INNERTUBE_API_KEY_REGEX =
  /"INNERTUBE_API_KEY":"([^"]+)"|INNERTUBE_API_KEY\\":\\"([^\\"]+)\\"/;

function extractBalancedJsonObject(source: string, startAt: number): string | null {
  // Lightweight "balanced braces" extractor for `... = { ... }` blobs in HTML.
  // We intentionally avoid a JS parser/DOM here: the watch page can be huge, and we only need the
  // JSON object text. Handles strings + escaping so braces inside strings don't break depth.
  const start = source.indexOf("{", startAt);
  if (start < 0) {
    return null;
  }

  let depth = 0;
  let inString = false;
  let quote: '"' | "'" | null = null;
  let escaping = false;

  for (let i = start; i < source.length; i += 1) {
    const ch = source[i];
    if (!ch) {
      continue;
    }

    if (inString) {
      if (escaping) {
        escaping = false;
        continue;
      }
      if (ch === "\\") {
        escaping = true;
        continue;
      }
      if (quote && ch === quote) {
        inString = false;
        quote = null;
      }
      continue;
    }

    if (ch === '"' || ch === "'") {
      inString = true;
      quote = ch;
      continue;
    }

    if (ch === "{") {
      depth += 1;
      continue;
    }
    if (ch === "}") {
      depth -= 1;
      if (depth === 0) {
        return source.slice(start, i + 1);
      }
    }
  }

  return null;
}

function extractInitialPlayerResponse(html: string): Record<string, unknown> | null {
  // YouTube embeds `ytInitialPlayerResponse = {...};` on the watch page. We grab that payload
  // because it often includes caption track metadata (manual + automatic tracks).
  const tokenIndex = html.indexOf(YT_INITIAL_PLAYER_RESPONSE_TOKEN);
  if (tokenIndex < 0) {
    return null;
  }
  const assignmentIndex = html.indexOf("=", tokenIndex);
  if (assignmentIndex < 0) {
    return null;
  }
  const objectText = extractBalancedJsonObject(html, assignmentIndex);
  if (!objectText) {
    return null;
  }

  try {
    const parsed: unknown = JSON.parse(objectText);
    return isObjectLike(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

const isObjectLike = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

function coerceDurationSeconds(value: unknown): number | null {
  const asNumber =
    typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
  if (!Number.isFinite(asNumber) || asNumber <= 0) return null;
  return asNumber;
}

function extractDurationSecondsFromHtml(html: string): number | null {
  const candidates = [
    /"lengthSeconds":"(\d+)"/,
    /"lengthSeconds":(\d+)/,
    /"durationSeconds":"(\d+)"/,
    /"durationSeconds":(\d+)/,
  ];
  for (const pattern of candidates) {
    const match = html.match(pattern);
    if (!match?.[1]) continue;
    const value = Number(match[1]);
    if (Number.isFinite(value) && value > 0) return value;
  }
  return null;
}

export function extractYoutubeDurationSeconds(html: string): number | null {
  const playerResponse = extractInitialPlayerResponse(html);
  if (playerResponse) {
    const duration = extractDurationSecondsFromPlayerPayload(playerResponse);
    if (duration) return duration;
  }

  return extractDurationSecondsFromHtml(html);
}

function extractInnertubeApiKey(html: string): string | null {
  const match = html.match(INNERTUBE_API_KEY_REGEX);
  const key = match?.[1] ?? match?.[2] ?? null;
  return typeof key === "string" && key.trim().length > 0 ? key.trim() : null;
}

type YoutubePlayerContext = Record<string, unknown> & { client?: unknown };
type CaptionsPayload = Record<string, unknown> & {
  captions?: unknown;
  playerCaptionsTracklistRenderer?: unknown;
};
type CaptionListRenderer = Record<string, unknown> & {
  captionTracks?: unknown;
  automaticCaptions?: unknown;
};
type CaptionTrackRecord = Record<string, unknown> & {
  languageCode?: unknown;
  kind?: unknown;
  baseUrl?: unknown;
  url?: unknown;
};
type CaptionEventRecord = Record<string, unknown> & {
  segs?: unknown;
  tStartMs?: unknown;
  dDurationMs?: unknown;
};
type CaptionSegmentRecord = Record<string, unknown> & { utf8?: unknown };

function extractDurationSecondsFromPlayerPayload(payload: Record<string, unknown>): number | null {
  const videoDetails = payload.videoDetails;
  if (isObjectLike(videoDetails)) {
    const duration = coerceDurationSeconds(videoDetails.lengthSeconds);
    if (duration) return duration;
  }

  const microformat = payload.microformat;
  if (isObjectLike(microformat)) {
    const renderer = microformat.playerMicroformatRenderer;
    if (isObjectLike(renderer)) {
      const duration = coerceDurationSeconds(renderer.lengthSeconds);
      if (duration) return duration;
    }
  }

  return null;
}

async function fetchYoutubePlayerPayload(
  fetchImpl: typeof fetch,
  { html, videoId }: { html: string; videoId: string },
): Promise<Record<string, unknown> | null> {
  const apiKey = extractInnertubeApiKey(html);
  if (!apiKey) return null;

  try {
    const userAgent =
      REQUEST_HEADERS["User-Agent"] ??
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36";

    const response = await fetchWithTimeout(
      fetchImpl,
      `https://www.youtube.com/youtubei/v1/player?key=${apiKey}`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "User-Agent": userAgent,
          "Accept-Language": REQUEST_HEADERS["Accept-Language"] ?? "en-US,en;q=0.9",
          Accept: "application/json",
        },
        body: JSON.stringify({
          context: {
            client: {
              clientName: "ANDROID",
              clientVersion: "20.10.38",
            },
          },
          videoId,
        }),
      },
    );

    if (!response.ok) return null;
    const parsed: unknown = await response.json();
    return isObjectLike(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export async function fetchYoutubeDurationSecondsViaPlayer(
  fetchImpl: typeof fetch,
  { html, videoId }: { html: string; videoId: string },
): Promise<number | null> {
  const payload = await fetchYoutubePlayerPayload(fetchImpl, { html, videoId });
  if (!payload) return null;
  return extractDurationSecondsFromPlayerPayload(payload);
}

async function fetchTranscriptViaAndroidPlayer(
  fetchImpl: typeof fetch,
  {
    html,
    videoId,
    skipAutoGenerated,
  }: { html: string; videoId: string; skipAutoGenerated?: boolean },
): Promise<TranscriptPayload | null> {
  // Fallback path: request the player payload via an "ANDROID" client.
  // This often works when the web bootstrap is missing/obfuscated, but may skew towards auto
  // captions; we pass skipAutoGenerated through to keep "no-auto" strict.
  const apiKey = extractInnertubeApiKey(html);
  if (!apiKey) {
    return null;
  }

  try {
    const userAgent =
      REQUEST_HEADERS["User-Agent"] ??
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36";

    const response = await fetchWithTimeout(
      fetchImpl,
      `https://www.youtube.com/youtubei/v1/player?key=${apiKey}`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "User-Agent": userAgent,
          "Accept-Language": REQUEST_HEADERS["Accept-Language"] ?? "en-US,en;q=0.9",
          Accept: "application/json",
        },
        body: JSON.stringify({
          context: {
            client: {
              clientName: "ANDROID",
              clientVersion: "20.10.38",
            },
          },
          videoId,
        }),
      },
    );

    if (!response.ok) {
      return null;
    }

    const parsed: unknown = await response.json();
    if (!isObjectLike(parsed)) {
      return null;
    }

    return await extractTranscriptFromPlayerPayload(fetchImpl, parsed, skipAutoGenerated);
  } catch {
    return null;
  }
}

export const fetchTranscriptFromCaptionTracks = async (
  fetchImpl: typeof fetch,
  {
    html,
    originalUrl,
    videoId,
    skipAutoGenerated,
  }: YoutubeTranscriptContext & { skipAutoGenerated?: boolean },
): Promise<TranscriptPayload | null> => {
  const initialPlayerResponse = extractInitialPlayerResponse(html);
  if (initialPlayerResponse) {
    const transcript = await extractTranscriptFromPlayerPayload(
      fetchImpl,
      initialPlayerResponse,
      skipAutoGenerated,
    );
    if (transcript) {
      return transcript;
    }
  }

  const bootstrap = extractYoutubeiBootstrap(html);
  if (!bootstrap) {
    return await fetchTranscriptViaAndroidPlayer(fetchImpl, { html, videoId, skipAutoGenerated });
  }

  const { apiKey, clientName, clientVersion, context, pageCl, pageLabel, visitorData, xsrfToken } =
    bootstrap;
  if (!apiKey) {
    return await fetchTranscriptViaAndroidPlayer(fetchImpl, { html, videoId, skipAutoGenerated });
  }

  const contextRecord = context as YoutubePlayerContext;
  const clientContext = isObjectLike(contextRecord.client)
    ? (contextRecord.client as Record<string, unknown>)
    : {};
  const requestBody: Record<string, unknown> = {
    context: {
      ...contextRecord,
      client: {
        ...clientContext,
        originalUrl,
      },
    },
    videoId,
    playbackContext: {
      contentPlaybackContext: {
        html5Preference: "HTML5_PREF_WANTS",
      },
    },
    contentCheckOk: true,
    racyCheckOk: true,
  };

  try {
    const userAgent =
      REQUEST_HEADERS["User-Agent"] ??
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36";
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "User-Agent": userAgent,
      Accept: "application/json",
      Origin: "https://www.youtube.com",
      Referer: originalUrl,
      "X-Goog-AuthUser": "0",
      "X-Youtube-Bootstrap-Logged-In": "false",
    };

    if (clientName) {
      headers["X-Youtube-Client-Name"] = clientName;
    }
    if (clientVersion) {
      headers["X-Youtube-Client-Version"] = clientVersion;
    }
    if (visitorData) {
      headers["X-Goog-Visitor-Id"] = visitorData;
    }
    if (typeof pageCl === "number" && Number.isFinite(pageCl)) {
      headers["X-Youtube-Page-CL"] = String(pageCl);
    }
    if (pageLabel) {
      headers["X-Youtube-Page-Label"] = pageLabel;
    }
    if (xsrfToken) {
      headers["X-Youtube-Identity-Token"] = xsrfToken;
    }

    const response = await fetchWithTimeout(
      fetchImpl,
      `https://www.youtube.com/youtubei/v1/player?key=${apiKey}`,
      {
        method: "POST",
        headers,
        body: JSON.stringify(requestBody),
      },
    );

    if (!response.ok) {
      return await fetchTranscriptViaAndroidPlayer(fetchImpl, { html, videoId, skipAutoGenerated });
    }

    const raw = await response.text();
    // YouTube sometimes wraps JSON in XSSI guards / odd escaping; sanitize before parsing.
    const sanitized = sanitizeYoutubeJsonResponse(raw);
    const parsed: unknown = JSON.parse(sanitized);
    if (!isObjectLike(parsed)) {
      return await fetchTranscriptViaAndroidPlayer(fetchImpl, { html, videoId, skipAutoGenerated });
    }

    const transcript = await extractTranscriptFromPlayerPayload(
      fetchImpl,
      parsed,
      skipAutoGenerated,
    );
    if (transcript) {
      return transcript;
    }

    return await fetchTranscriptViaAndroidPlayer(fetchImpl, { html, videoId, skipAutoGenerated });
  } catch {
    return await fetchTranscriptViaAndroidPlayer(fetchImpl, { html, videoId, skipAutoGenerated });
  }
};

const extractTranscriptFromPlayerPayload = async (
  fetchImpl: typeof fetch,
  payload: Record<string, unknown>,
  skipAutoGenerated?: boolean,
): Promise<TranscriptPayload | null> => {
  const payloadRecord = payload as CaptionsPayload;

  const captionsCandidate = payloadRecord.captions;
  const captions = isObjectLike(captionsCandidate) ? (captionsCandidate as CaptionsPayload) : null;

  const rendererCandidate =
    (captions ? (captions as CaptionsPayload).playerCaptionsTracklistRenderer : null) ??
    payloadRecord.playerCaptionsTracklistRenderer;

  const renderer = isObjectLike(rendererCandidate)
    ? (rendererCandidate as CaptionListRenderer)
    : null;
  const captionTracks = Array.isArray(renderer?.captionTracks)
    ? (renderer?.captionTracks as unknown[])
    : null;
  const automaticTracks = Array.isArray(renderer?.automaticCaptions)
    ? (renderer?.automaticCaptions as unknown[])
    : null;

  const orderedTracks: Record<string, unknown>[] = [];
  if (captionTracks) {
    orderedTracks.push(
      ...captionTracks.filter((track): track is Record<string, unknown> => isObjectLike(track)),
    );
  }
  if (!skipAutoGenerated && automaticTracks) {
    // In "no-auto" mode, we *exclude* `automaticCaptions` entirely (not just kind==="asr") so
    // "creator captions only" stays true even when YouTube mixes track types.
    orderedTracks.push(
      ...automaticTracks.filter((track): track is Record<string, unknown> => isObjectLike(track)),
    );
  }
  const filteredTracks = orderedTracks.filter((track): track is Record<string, unknown> =>
    isObjectLike(track),
  );

  const sortedTracks = [...filteredTracks].toSorted((a, b) => {
    const aTrack = a as CaptionTrackRecord;
    const bTrack = b as CaptionTrackRecord;
    const aKind = typeof aTrack.kind === "string" ? aTrack.kind : "";
    const bKind = typeof bTrack.kind === "string" ? bTrack.kind : "";
    // Prefer manual captions over auto-generated (ASR).
    if (aKind === "asr" && bKind !== "asr") {
      return 1;
    }
    if (bKind === "asr" && aKind !== "asr") {
      return -1;
    }
    const aLang = typeof aTrack.languageCode === "string" ? aTrack.languageCode : "";
    const bLang = typeof bTrack.languageCode === "string" ? bTrack.languageCode : "";
    const aIsEnglish = aLang === "en" || aLang.startsWith("en-");
    const bIsEnglish = bLang === "en" || bLang.startsWith("en-");
    if (aIsEnglish && !bIsEnglish) {
      return -1;
    }
    if (bIsEnglish && !aIsEnglish) {
      return 1;
    }
    return 0;
  });

  // De-dupe after sorting so manual/English wins within each language.
  const seenLanguages = new Set<string>();
  const normalizedTracks: Record<string, unknown>[] = [];
  for (const candidate of sortedTracks) {
    const trackRecord = candidate as CaptionTrackRecord;
    const languageCandidate = trackRecord.languageCode;
    const lang = typeof languageCandidate === "string" ? languageCandidate.toLowerCase() : "";
    if (lang && seenLanguages.has(lang)) {
      continue;
    }
    if (lang) {
      seenLanguages.add(lang);
    }
    normalizedTracks.push(candidate);
  }

  // Filter out auto-generated tracks if skipAutoGenerated is true
  const tracksToUse = skipAutoGenerated
    ? normalizedTracks.filter((track) => {
        const t = track as CaptionTrackRecord;
        return t.kind !== "asr";
      })
    : normalizedTracks;

  if (tracksToUse.length === 0) {
    return null;
  }

  return await findFirstTranscript(fetchImpl, tracksToUse, 0);
};

const findFirstTranscript = async (
  fetchImpl: typeof fetch,
  tracks: readonly Record<string, unknown>[],
  index: number,
): Promise<TranscriptPayload | null> => {
  if (index >= tracks.length) {
    return null;
  }
  const candidate = await downloadCaptionTrack(fetchImpl, tracks[index] ?? {});
  if (candidate) {
    return candidate;
  }
  return findFirstTranscript(fetchImpl, tracks, index + 1);
};

const downloadCaptionTrack = async (
  fetchImpl: typeof fetch,
  track: Record<string, unknown>,
): Promise<TranscriptPayload | null> => {
  const trackRecord = track as CaptionTrackRecord;
  const baseUrl =
    typeof trackRecord.baseUrl === "string"
      ? trackRecord.baseUrl
      : typeof trackRecord.url === "string"
        ? trackRecord.url
        : null;
  if (!baseUrl) {
    return null;
  }

  const json3Url = (() => {
    try {
      const parsed = new URL(baseUrl);
      parsed.searchParams.set("fmt", "json3");
      parsed.searchParams.set("alt", "json");
      return parsed.toString();
    } catch {
      const separator = baseUrl.includes("?") ? "&" : "?";
      return `${baseUrl}${separator}fmt=json3&alt=json`;
    }
  })();

  try {
    const response = await fetchWithTimeout(fetchImpl, json3Url, {
      headers: REQUEST_HEADERS,
    });
    if (!response.ok) {
      return await downloadXmlTranscript(fetchImpl, baseUrl);
    }

    const text = await response.text();
    if (text.length === 0) {
      return await downloadXmlTranscript(fetchImpl, baseUrl);
    }
    const jsonResult = parseJsonTranscript(text);
    if (jsonResult) {
      return jsonResult;
    }
    const xmlFallback = parseXmlTranscript(text);
    if (xmlFallback) {
      return xmlFallback;
    }
    return await downloadXmlTranscript(fetchImpl, baseUrl);
  } catch {
    return await downloadXmlTranscript(fetchImpl, baseUrl);
  }
};

const downloadXmlTranscript = async (
  fetchImpl: typeof fetch,
  baseUrl: string,
): Promise<TranscriptPayload | null> => {
  const xmlUrl = baseUrl.replaceAll(/&fmt=[^&]+/g, "");
  try {
    const response = await fetchWithTimeout(fetchImpl, xmlUrl, { headers: REQUEST_HEADERS });
    if (!response.ok) {
      return null;
    }
    const text = await response.text();
    const jsonResult = parseJsonTranscript(text);
    if (jsonResult) {
      return jsonResult;
    }
    return parseXmlTranscript(text);
  } catch {
    return null;
  }
};

type CaptionPayload = { events?: unknown };

const parseJsonTranscript = (raw: string): TranscriptPayload | null => {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!isObjectLike(parsed)) {
      return null;
    }
    const payloadRecord = parsed as CaptionPayload;
    const eventsUnknown = payloadRecord.events;
    if (!Array.isArray(eventsUnknown)) {
      return null;
    }
    const events = eventsUnknown;
    const lines: string[] = [];
    const segments: TranscriptSegment[] = [];
    for (const event of events) {
      if (!isObjectLike(event)) {
        continue;
      }
      const eventRecord = event as CaptionEventRecord;
      const segs = Array.isArray(eventRecord.segs) ? (eventRecord.segs as unknown[]) : null;
      if (!segs) {
        continue;
      }
      const text = segs
        .map((seg) => {
          if (!isObjectLike(seg)) {
            return "";
          }
          const segRecord = seg as CaptionSegmentRecord;
          return typeof segRecord.utf8 === "string" ? segRecord.utf8 : "";
        })
        .join("")
        .trim();
      if (text.length > 0) {
        lines.push(text);
        const startMs = parseTimestampToMs(eventRecord.tStartMs, false);
        const durationMs = parseTimestampToMs(eventRecord.dDurationMs, false);
        if (startMs != null) {
          segments.push({
            startMs,
            endMs: durationMs != null ? startMs + durationMs : null,
            text: text.replace(/\s+/g, " ").trim(),
          });
        }
      }
    }
    const transcript = lines.join("\n").trim();
    if (transcript.length === 0) {
      return null;
    }
    return {
      text: transcript,
      segments: segments.length > 0 ? segments : null,
    };
  } catch {
    return null;
  }
};

const parseXmlTranscript = (xml: string): TranscriptPayload | null => {
  const pattern = /<text[^>]*>([\s\S]*?)<\/text>/gi;
  const lines: string[] = [];
  const segments: TranscriptSegment[] = [];
  let match: RegExpExecArray | null = pattern.exec(xml);
  while (match) {
    const content = match[1] ?? "";
    const decoded = decodeHtmlEntities(content).replaceAll(/\s+/g, " ").trim();
    if (decoded.length > 0) {
      lines.push(decoded);
      const tag = match[0] ?? "";
      const startMatch = tag.match(/\bstart\s*=\s*(['"])([^'"]+)\1/i);
      const durMatch = tag.match(/\bdur\s*=\s*(['"])([^'"]+)\1/i);
      const startMs = startMatch?.[2] ? parseTimestampToMs(startMatch[2], true) : null;
      const durationMs = durMatch?.[2] ? parseTimestampToMs(durMatch[2], true) : null;
      if (startMs != null) {
        segments.push({
          startMs,
          endMs: durationMs != null ? startMs + durationMs : null,
          text: decoded.replace(/\s+/g, " ").trim(),
        });
      }
    }
    match = pattern.exec(xml);
  }
  const transcript = lines.join("\n").trim();
  if (transcript.length === 0) {
    return null;
  }
  return {
    text: transcript,
    segments: segments.length > 0 ? segments : null,
  };
};
