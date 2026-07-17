import { extractXiaoyuzhouEpisodeId } from "../../link-preview/content/podcast-utils.js";
import { isDirectMediaUrl } from "../../url.js";
import { resolveTranscriptionConfig } from "../transcription-config.js";
import type { ProviderContext, ProviderFetchOptions, ProviderResult } from "../types.js";
import {
  fetchAppleTranscriptFromEmbeddedHtml,
  fetchAppleTranscriptFromItunesLookup,
} from "./podcast/apple-flow.js";
import { FEED_HINT_URL_PATTERN, PODCAST_PLATFORM_HOST_PATTERN } from "./podcast/constants.js";
import type { PodcastFlowContext } from "./podcast/flow-context.js";
import { resolvePodcastFeedUrlFromItunesSearch } from "./podcast/itunes.js";
import {
  downloadCappedBytes,
  downloadToFile,
  filenameFromUrl,
  formatBytes,
  normalizeHeaderType,
  parseContentRangeTotal,
  parseContentLength,
  probeRemoteMedia,
  type TranscribeRequest,
  type TranscriptionResult,
  transcribeMediaUrl,
} from "./podcast/media.js";
import {
  buildNoTranscriptResult,
  tryFeedEnclosureTranscript,
  tryOgAudioTranscript,
  tryPodcastTranscriptFromFeed,
  tryPodcastYtDlpTranscript,
} from "./podcast/provider-flow.js";
import {
  extractEnclosureForEpisode,
  extractItemDurationSeconds,
  looksLikeRssOrAtomFeed,
} from "./podcast/rss.js";
import { fetchSpotifyTranscript } from "./podcast/spotify-flow.js";
import { looksLikeBlockedHtml } from "./podcast/spotify.js";
import { fetchXiaoyuzhouTranscript } from "./podcast/xiaoyuzhou.js";
import {
  buildMissingTranscriptionProviderResult,
  resolveTranscriptProviderCapabilities,
} from "./transcription-capability.js";

export const canHandle = ({ url, html }: ProviderContext): boolean => {
  // Direct media URLs (e.g., .mp3, .wav) should be handled by the generic provider
  // even if the URL contains "podcast" in the path (like "rt_podcast996.mp3")
  if (isDirectMediaUrl(url)) return false;
  if (typeof html === "string" && looksLikeRssOrAtomFeed(html)) return true;
  if (extractXiaoyuzhouEpisodeId(url)) return true;
  if (PODCAST_PLATFORM_HOST_PATTERN.test(url)) return true;
  return FEED_HINT_URL_PATTERN.test(url);
};

export const fetchTranscript = async (
  context: ProviderContext,
  options: ProviderFetchOptions,
): Promise<ProviderResult> => {
  const attemptedProviders: ProviderResult["attemptedProviders"] = [];
  const notes: string[] = [];
  const transcription = resolveTranscriptionConfig(options);

  const pushOnce = (provider: ProviderResult["attemptedProviders"][number]) => {
    if (!attemptedProviders.includes(provider)) attemptedProviders.push(provider);
  };

  const transcriptionCapabilities = await resolveTranscriptProviderCapabilities({
    transcription,
    ytDlpPath: options.ytDlpPath,
  });

  const ensureTranscriptionProvider = (): ProviderResult | null => {
    return !transcriptionCapabilities.canTranscribe
      ? buildMissingTranscriptionProviderResult({
          attemptedProviders,
          metadata: { provider: "podcast", reason: "missing_transcription_keys" },
        })
      : null;
  };

  const progress = {
    url: context.url,
    service: "podcast" as const,
    onProgress: options.onProgress ?? null,
  };

  const transcribe = ({
    fetchImpl = options.fetch,
    ...request
  }: TranscribeRequest): Promise<TranscriptionResult> =>
    transcribeMediaUrl({
      fetchImpl,
      transcription,
      notes,
      progress,
      ...request,
    });

  const flow: PodcastFlowContext = {
    context,
    options,
    transcription,
    feedHtml: typeof context.html === "string" ? context.html : null,
    attemptedProviders,
    notes,
    pushOnce,
    ensureTranscriptionProvider,
    transcribe,
  };

  const directResult = await tryPodcastTranscriptFromFeed(flow);
  if (directResult) return directResult;

  const xiaoyuzhouResult = await fetchXiaoyuzhouTranscript(flow);
  if (xiaoyuzhouResult) return xiaoyuzhouResult;

  const spotifyResult = await fetchSpotifyTranscript(flow);
  if (spotifyResult) return spotifyResult;

  const appleLookupResult = await fetchAppleTranscriptFromItunesLookup(flow);
  if (appleLookupResult) return appleLookupResult;

  const appleEmbeddedResult = await fetchAppleTranscriptFromEmbeddedHtml(flow);
  if (appleEmbeddedResult) return appleEmbeddedResult;

  const enclosureResult = await tryFeedEnclosureTranscript(flow);
  if (enclosureResult) return enclosureResult;

  const ogAudioResult = await tryOgAudioTranscript(flow);
  if (ogAudioResult) return ogAudioResult;

  const ytDlpResult = await tryPodcastYtDlpTranscript(flow);
  if (ytDlpResult) return ytDlpResult;

  return buildNoTranscriptResult(flow);
};

// Test-only exports (not part of the public API; may change without notice).
export const __test__ = {
  probeRemoteMedia,
  downloadCappedBytes,
  downloadToFile,
  normalizeHeaderType,
  parseContentRangeTotal,
  parseContentLength,
  filenameFromUrl,
  looksLikeBlockedHtml,
  extractItemDurationSeconds,
  extractEnclosureForEpisode,
  resolvePodcastFeedUrlFromItunesSearch,
  formatBytes,
};
