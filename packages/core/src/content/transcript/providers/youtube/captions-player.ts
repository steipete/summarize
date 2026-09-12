import { withBunCompressionHeaders } from "../../../bun.js";
import { fetchWithTimeout } from "../../../link-preview/fetch-with-timeout.js";
import { extractInitialPlayerResponse } from "../../utils.js";
import { extractYoutubeiBootstrap } from "./api.js";
import { INNERTUBE_API_KEY_REGEX, REQUEST_HEADERS, isObjectLike } from "./captions-shared.js";

function coerceDurationSeconds(value: unknown): number | null {
  const asNumber =
    typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
  if (!Number.isFinite(asNumber) || asNumber <= 0) return null;
  return asNumber;
}

function coerceCount(value: unknown): number | null {
  const asNumber =
    typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
  if (!Number.isSafeInteger(asNumber) || asNumber < 0) return null;
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

export type YoutubePlayerMetadata = {
  durationSeconds: number | null;
  viewCount: number | null;
};

function extractPlayerMetadata(payload: Record<string, unknown>): YoutubePlayerMetadata {
  return {
    durationSeconds: extractDurationSecondsFromPlayerPayload(payload),
    viewCount: extractViewCountFromPlayerPayload(payload),
  };
}

export function extractDurationSecondsFromPlayerPayload(
  payload: Record<string, unknown>,
): number | null {
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

export function extractViewCountFromPlayerPayload(payload: Record<string, unknown>): number | null {
  const videoDetails = payload.videoDetails;
  if (isObjectLike(videoDetails)) {
    const viewCount = coerceCount(videoDetails.viewCount);
    if (viewCount !== null) return viewCount;
  }

  const microformat = payload.microformat;
  if (isObjectLike(microformat)) {
    const renderer = microformat.playerMicroformatRenderer;
    if (isObjectLike(renderer)) {
      const viewCount = coerceCount(renderer.viewCount);
      if (viewCount !== null) return viewCount;
    }
  }

  return null;
}

export function extractYoutubeDurationSeconds(html: string): number | null {
  return (
    extractYoutubePlayerMetadata(html)?.durationSeconds ?? extractDurationSecondsFromHtml(html)
  );
}

export function extractYoutubePlayerMetadata(html: string): YoutubePlayerMetadata | null {
  const playerResponse = extractInitialPlayerResponse(html);
  return playerResponse ? extractPlayerMetadata(playerResponse) : null;
}

export function extractYoutubeViewCount(html: string): number | null {
  return extractYoutubePlayerMetadata(html)?.viewCount ?? null;
}

export function extractInnertubeApiKey(html: string): string | null {
  const match = html.match(INNERTUBE_API_KEY_REGEX);
  const key = match?.[1] ?? match?.[2] ?? null;
  return typeof key === "string" && key.trim().length > 0 ? key.trim() : null;
}

export async function fetchYoutubePlayerPayload(
  fetchImpl: typeof fetch,
  { html, videoId, timeoutMs }: { html: string; videoId: string; timeoutMs?: number },
): Promise<Record<string, unknown> | null> {
  const bootstrap = extractYoutubeiBootstrap(html);
  const apiKey = bootstrap?.apiKey ?? extractInnertubeApiKey(html);
  if (!apiKey) return null;

  const context = bootstrap?.context;
  const clientContext =
    isObjectLike(context) && isObjectLike(context.client) ? context.client : null;

  const requestBody: Record<string, unknown> = {
    context:
      clientContext && isObjectLike(context)
        ? context
        : {
            client: {
              clientName: "ANDROID",
              clientVersion: "20.10.38",
            },
          },
    videoId,
  };

  try {
    const userAgent =
      REQUEST_HEADERS["User-Agent"] ??
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36";

    return await fetchWithTimeout(
      fetchImpl,
      `https://www.youtube.com/youtubei/v1/player?key=${apiKey}`,
      {
        method: "POST",
        headers: withBunCompressionHeaders({
          "Content-Type": "application/json",
          "User-Agent": userAgent,
          "Accept-Language": REQUEST_HEADERS["Accept-Language"] ?? "en-US,en;q=0.9",
          Accept: "application/json",
        }),
        body: JSON.stringify(requestBody),
      },
      timeoutMs,
      async (response) => {
        if (!response.ok) return null;
        const parsed: unknown = await response.json();
        return isObjectLike(parsed) ? parsed : null;
      },
    );
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

export async function fetchYoutubePlayerMetadata(
  fetchImpl: typeof fetch,
  { html, videoId, timeoutMs }: { html: string; videoId: string; timeoutMs?: number },
): Promise<YoutubePlayerMetadata | null> {
  const payload = await fetchYoutubePlayerPayload(fetchImpl, { html, videoId, timeoutMs });
  return payload ? extractPlayerMetadata(payload) : null;
}
