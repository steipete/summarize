import { parseHtmlDocument } from "../../../html-document.js";
import { fetchHtmlDocument } from "../../../link-preview/content/fetcher.js";
import { extractXiaoyuzhouEpisodeId } from "../../../link-preview/content/podcast-utils.js";
import type { ProviderResult } from "../../types.js";
import { MAX_REMOTE_MEDIA_BYTES, TRANSCRIPTION_TIMEOUT_MS } from "./constants.js";
import type { PodcastFlowContext } from "./flow-context.js";
import {
  filenameFromUrl,
  normalizeHeaderType,
  parseContentLength,
  remoteMediaTooLargeError,
} from "./media-download.js";
import { buildWhisperResult } from "./results.js";

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const MAX_AUDIO_REDIRECTS = 10;
const XIAOYUZHOU_AUDIO_HOST = "media.xyzcdn.net";

export async function fetchXiaoyuzhouTranscript(
  flow: PodcastFlowContext,
): Promise<ProviderResult | null> {
  const episodeId = extractXiaoyuzhouEpisodeId(flow.context.url);
  if (!episodeId) return null;

  const missing = flow.ensureTranscriptionProvider();
  if (missing) return missing;

  let audioUrl: string | null = null;
  try {
    const page = await fetchHtmlDocument(flow.options.fetch, flow.context.url, {
      timeoutMs: flow.options.timeoutMs,
      onProgress: flow.options.onProgress,
      rejectNonHtmlText: true,
    });
    if (extractXiaoyuzhouEpisodeId(page.finalUrl) !== episodeId) {
      throw new Error("Xiaoyuzhou episode page redirected outside its canonical URL");
    }

    audioUrl = extractXiaoyuzhouOgAudioUrl(page.html);
    if (!audioUrl) {
      throw new Error("Xiaoyuzhou episode page is missing a valid HTTPS og:audio URL");
    }

    const audioFetch = createSameHostAudioFetch(flow.options.fetch, audioUrl);
    await validateAudioResponse({
      fetchImpl: audioFetch,
      url: audioUrl,
      maxBytes: flow.transcription.remoteMediaMaxBytes ?? MAX_REMOTE_MEDIA_BYTES,
    });

    flow.pushOnce("whisper");
    const result = await flow.transcribe({
      fetchImpl: audioFetch,
      url: audioUrl,
      filenameHint: filenameFromUrl(audioUrl) ?? "episode.m4a",
      durationSecondsHint: null,
    });
    if (result.text) flow.notes.push("Resolved Xiaoyuzhou episode via validated og:audio");

    return buildWhisperResult({
      attemptedProviders: flow.attemptedProviders,
      notes: flow.notes,
      outcome: result,
      includeProviderOnFailure: true,
      metadata: {
        provider: "podcast",
        kind: "xiaoyuzhou_og_audio",
        episodeId,
        audioUrl,
      },
    });
  } catch (error) {
    return {
      text: null,
      source: null,
      attemptedProviders: flow.attemptedProviders,
      notes: `Xiaoyuzhou episode resolution failed: ${error instanceof Error ? error.message : String(error)}`,
      metadata: {
        provider: "podcast",
        kind: "xiaoyuzhou_og_audio",
        episodeId,
        ...(audioUrl ? { audioUrl } : {}),
      },
    };
  }
}

export function extractXiaoyuzhouOgAudioUrl(html: string): string | null {
  const parsed = parseHtmlDocument(html);
  try {
    const meta = parsed.document.querySelector('meta[property="og:audio"]');
    const candidate = (meta?.getAttribute("content") ?? "").trim();
    if (!candidate) return null;
    const url = new URL(candidate);
    if (
      url.protocol !== "https:" ||
      url.hostname.toLowerCase() !== XIAOYUZHOU_AUDIO_HOST ||
      url.port !== "" ||
      url.username !== "" ||
      url.password !== ""
    ) {
      return null;
    }
    return url.href;
  } catch {
    return null;
  } finally {
    parsed.close();
  }
}

function createSameHostAudioFetch(fetchImpl: typeof fetch, audioUrl: string): typeof fetch {
  const allowedHost = new URL(audioUrl).host.toLowerCase();

  const sameHostFetch = async (
    input: Parameters<typeof fetch>[0],
    init?: Parameters<typeof fetch>[1],
  ): Promise<Response> => {
    let currentInput = input;
    let currentInit = { ...init, redirect: "manual" as const };

    for (let redirects = 0; redirects <= MAX_AUDIO_REDIRECTS; redirects += 1) {
      const currentUrl = inputUrl(currentInput);
      const currentParsed = new URL(currentUrl);
      if (currentParsed.protocol !== "https:" || currentParsed.host.toLowerCase() !== allowedHost) {
        throw new Error("Xiaoyuzhou audio request changed host");
      }
      const response = await fetchImpl(currentInput, currentInit);
      if (!REDIRECT_STATUSES.has(response.status)) return response;

      const location = response.headers.get("location");
      if (!location) return response;
      if (redirects === MAX_AUDIO_REDIRECTS) {
        throw new Error("Xiaoyuzhou audio redirected too many times");
      }

      const nextUrl = new URL(location, response.url || currentUrl);
      if (nextUrl.protocol !== "https:" || nextUrl.host.toLowerCase() !== allowedHost) {
        throw new Error("Xiaoyuzhou audio redirected to another host");
      }

      await response.body?.cancel().catch(() => {});
      currentInput = nextUrl.href;
      currentInit = { ...currentInit, body: null };
    }

    throw new Error("Xiaoyuzhou audio redirected too many times");
  };

  return sameHostFetch as typeof fetch;
}

async function validateAudioResponse({
  fetchImpl,
  url,
  maxBytes,
}: {
  fetchImpl: typeof fetch;
  url: string;
  maxBytes: number;
}): Promise<void> {
  const response = await fetchImpl(url, {
    method: "HEAD",
    redirect: "follow",
    signal: AbortSignal.timeout(TRANSCRIPTION_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`Xiaoyuzhou audio probe failed (${response.status})`);

  const mediaType = normalizeHeaderType(response.headers.get("content-type"));
  if (!mediaType?.startsWith("audio/")) {
    throw new Error(`Xiaoyuzhou og:audio returned non-audio content (${mediaType ?? "missing"})`);
  }

  const contentLength = parseContentLength(response.headers.get("content-length"));
  if (contentLength !== null && contentLength > maxBytes) {
    throw remoteMediaTooLargeError(contentLength, maxBytes);
  }
}

function inputUrl(input: Parameters<typeof fetch>[0]): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.href;
  return input.url;
}
