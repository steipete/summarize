import type { TranscriptProgressStage } from "../../../link-preview/deps.js";
import { normalizeTranscriptText } from "../../normalize.js";
import type { TranscriptionConfig } from "../../transcription-config.js";
import type {
  ProviderContext,
  ProviderFetchOptions,
  ProviderResult,
  TranscriptSource,
} from "../../types.js";
import { extractYouTubeVideoId } from "../../utils.js";
import { extractYoutubeiTranscriptConfig, fetchTranscriptFromTranscriptEndpoint } from "./api.js";
import { fetchTranscriptWithApify } from "./apify.js";
import {
  extractYoutubeDurationSeconds,
  extractYoutubePlayerMetadata,
  fetchTranscriptFromCaptionTracks,
  fetchYoutubePlayerMetadata,
} from "./captions.js";
import { fetchMediaMetadataWithYtDlp, fetchTranscriptWithYtDlp } from "./yt-dlp.js";

/**
 * Check if a transcript is suspiciously short relative to the video duration.
 * Returns true if the transcript appears truncated (less than 1 word per 3 seconds
 * for videos longer than 3 minutes). This causes the provider flow to fall through
 * to the next provider (e.g. yt-dlp audio transcription) instead of accepting
 * a broken/truncated caption track.
 */
function isTranscriptTruncated(text: string, durationMetadata: DurationMetadata): boolean {
  const durationSeconds = durationMetadata.durationSeconds;
  if (!durationSeconds) return false;
  if (durationSeconds < 180) return false;
  const wordCount = text.split(/\s+/).filter(Boolean).length;
  const expectedMinWords = durationSeconds / 3;
  return wordCount < expectedMinWords;
}

const YOUTUBE_BOOTSTRAP_PATTERN = /ytcfg\.set|ytInitialPlayerResponse/;
const WATCH_PAGE_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0 Safari/537.36",
  Accept: "text/html,application/xhtml+xml",
};

type DurationMetadata = {
  durationSeconds?: number;
  sourceMetrics?: {
    platform: "youtube";
    videoId: string;
    viewCount: number | null;
    observedAt: string;
  };
};

export type YouTubeProviderFlow = {
  context: ProviderContext;
  options: ProviderFetchOptions;
  transcription: TranscriptionConfig;
  htmlText: string;
  attemptedProviders: TranscriptSource[];
  notes: string[];
  effectiveVideoId: string | null;
  durationMetadata: DurationMetadata;
  canTranscribe: boolean;
  canRunYtDlp: boolean;
  pushHint: (hint: string, stage: TranscriptProgressStage) => void;
};

export async function loadYoutubeHtml(
  context: ProviderContext,
  options: ProviderFetchOptions,
): Promise<string | null> {
  const { html: initialHtml, url } = context;
  if (typeof initialHtml === "string" && YOUTUBE_BOOTSTRAP_PATTERN.test(initialHtml)) {
    return initialHtml;
  }

  try {
    const response = await options.fetch(url, { headers: WATCH_PAGE_HEADERS });
    if (response.ok) return await response.text();
  } catch {
    // Ignore and fall back to the caller-provided HTML.
  }

  return initialHtml;
}

export function resolveEffectiveVideoId(context: ProviderContext): string | null {
  const candidate = context.resourceKey ?? extractYouTubeVideoId(context.url);
  return typeof candidate === "string" && candidate.trim().length > 0 ? candidate.trim() : null;
}

export async function resolveDurationMetadata(args: {
  htmlText: string;
  effectiveVideoId: string | null;
  url: string;
  options: ProviderFetchOptions;
}): Promise<DurationMetadata> {
  const { htmlText, effectiveVideoId, url, options } = args;
  const startedAt = Date.now();
  const remainingTimeoutMs = () =>
    options.timeoutMs == null
      ? undefined
      : Math.max(1, options.timeoutMs - (Date.now() - startedAt));

  const initialPlayerMetadata = extractYoutubePlayerMetadata(htmlText);
  let durationSeconds = extractYoutubeDurationSeconds(htmlText);
  let sourceMetrics =
    effectiveVideoId && initialPlayerMetadata
      ? {
          platform: "youtube" as const,
          videoId: effectiveVideoId,
          viewCount: initialPlayerMetadata.viewCount,
          observedAt: new Date().toISOString(),
        }
      : null;
  if (!durationSeconds && effectiveVideoId) {
    const playerMetadata = await fetchYoutubePlayerMetadata(options.fetch, {
      html: htmlText,
      videoId: effectiveVideoId,
      timeoutMs: remainingTimeoutMs(),
    });
    durationSeconds ??= playerMetadata?.durationSeconds ?? null;
    if (playerMetadata) {
      sourceMetrics = {
        platform: "youtube",
        videoId: effectiveVideoId,
        viewCount: playerMetadata.viewCount,
        observedAt: new Date().toISOString(),
      };
    }
  }
  if (!durationSeconds && options.ytDlpPath) {
    const ytDlpMetadata = await fetchMediaMetadataWithYtDlp({
      ytDlpPath: options.ytDlpPath,
      url,
      timeoutMs: remainingTimeoutMs(),
    });
    durationSeconds ??= ytDlpMetadata?.durationSeconds ?? null;
    if (effectiveVideoId && ytDlpMetadata) {
      sourceMetrics = {
        platform: "youtube",
        videoId: effectiveVideoId,
        viewCount: ytDlpMetadata.viewCount ?? sourceMetrics?.viewCount ?? null,
        observedAt: new Date().toISOString(),
      };
    }
  }

  return {
    ...(typeof durationSeconds === "number" &&
    Number.isFinite(durationSeconds) &&
    durationSeconds > 0
      ? { durationSeconds }
      : {}),
    ...(sourceMetrics ? { sourceMetrics } : {}),
  };
}

export async function tryApifyTranscript(
  flow: YouTubeProviderFlow,
  hint: string,
): Promise<ProviderResult | null> {
  if (!flow.options.apifyApiToken) return null;

  flow.pushHint(hint, "apify");
  flow.attemptedProviders.push("apify");

  const transcript = await fetchTranscriptWithApify(
    flow.options.fetch,
    flow.options.apifyApiToken,
    flow.context.url,
  );
  if (!transcript) return null;

  return {
    text: normalizeTranscriptText(transcript),
    source: "apify",
    metadata: { provider: "apify", ...(flow.durationMetadata ?? {}) },
    attemptedProviders: flow.attemptedProviders,
  };
}

export async function tryManualCaptionTranscript(
  flow: YouTubeProviderFlow,
): Promise<ProviderResult | null> {
  if (!flow.effectiveVideoId) {
    return { text: null, source: null, attemptedProviders: flow.attemptedProviders };
  }

  flow.pushHint(
    "YouTube: checking creator captions only (skipping auto-generated)",
    "creatorCaptions",
  );
  flow.attemptedProviders.push("captionTracks");

  const transcript = await fetchTranscriptFromCaptionTracks(flow.options.fetch, {
    html: flow.htmlText,
    originalUrl: flow.context.url,
    videoId: flow.effectiveVideoId,
    skipAutoGenerated: true,
  });
  if (!transcript?.text) return null;

  return {
    text: normalizeTranscriptText(transcript.text),
    source: "captionTracks",
    segments: flow.options.transcriptTimestamps ? (transcript.segments ?? null) : null,
    metadata: { provider: "captionTracks", manualOnly: true, ...(flow.durationMetadata ?? {}) },
    attemptedProviders: flow.attemptedProviders,
  };
}

export async function tryWebTranscript(flow: YouTubeProviderFlow): Promise<ProviderResult | null> {
  if (!flow.effectiveVideoId) {
    return { text: null, source: null, attemptedProviders: flow.attemptedProviders };
  }

  flow.pushHint("YouTube: checking captions (youtubei)", "captions");
  const config = extractYoutubeiTranscriptConfig(flow.htmlText);
  if (config) {
    flow.attemptedProviders.push("youtubei");
    const transcript = await fetchTranscriptFromTranscriptEndpoint(flow.options.fetch, {
      config,
      originalUrl: flow.context.url,
    });
    if (transcript?.text) {
      const normalized = normalizeTranscriptText(transcript.text);
      if (isTranscriptTruncated(normalized, flow.durationMetadata)) {
        flow.notes.push("youtubei transcript appears truncated; falling through to next provider");
      } else {
        return {
          text: normalized,
          source: "youtubei",
          segments: flow.options.transcriptTimestamps ? (transcript.segments ?? null) : null,
          metadata: { provider: "youtubei", ...(flow.durationMetadata ?? {}) },
          attemptedProviders: flow.attemptedProviders,
        };
      }
    }
  }

  flow.pushHint(
    config
      ? "YouTube: youtubei empty; checking caption tracks"
      : "YouTube: youtubei unavailable; checking caption tracks",
    config ? "captionTracksEmpty" : "captionTracksUnavailable",
  );
  flow.attemptedProviders.push("captionTracks");

  const transcript = await fetchTranscriptFromCaptionTracks(flow.options.fetch, {
    html: flow.htmlText,
    originalUrl: flow.context.url,
    videoId: flow.effectiveVideoId,
  });
  if (!transcript?.text) return null;

  const normalized = normalizeTranscriptText(transcript.text);
  if (isTranscriptTruncated(normalized, flow.durationMetadata)) {
    flow.notes.push("captionTracks transcript appears truncated; falling through to next provider");
    return null;
  }

  return {
    text: normalized,
    source: "captionTracks",
    segments: flow.options.transcriptTimestamps ? (transcript.segments ?? null) : null,
    metadata: { provider: "captionTracks", ...(flow.durationMetadata ?? {}) },
    attemptedProviders: flow.attemptedProviders,
  };
}

export async function tryYtDlpTranscript(args: {
  flow: YouTubeProviderFlow;
  mode: ProviderFetchOptions["youtubeTranscriptMode"];
}): Promise<ProviderResult | null> {
  const { flow, mode } = args;

  if (mode === "auto") {
    flow.pushHint("YouTube: captions unavailable; falling back to yt-dlp audio", "fallbackAudio");
  } else if (mode === "no-auto") {
    flow.pushHint("YouTube: no creator captions; falling back to yt-dlp audio", "noCreatorAudio");
  } else {
    flow.pushHint("YouTube: downloading audio (yt-dlp)", "downloadAudio");
  }

  flow.attemptedProviders.push("yt-dlp");
  const ytdlpResult = await fetchTranscriptWithYtDlp({
    ytDlpPath: flow.options.ytDlpPath,
    transcription: flow.transcription,
    groqApiKey: flow.options.groqApiKey,
    assemblyaiApiKey: flow.options.assemblyaiApiKey,
    elevenlabsApiKey: flow.options.elevenlabsApiKey,
    geminiApiKey: flow.options.geminiApiKey,
    openaiApiKey: flow.options.openaiApiKey,
    falApiKey: flow.options.falApiKey,
    deepgramApiKey: flow.options.deepgramApiKey,
    diarization: flow.options.transcriptDiarization ?? null,
    downloadVideo: flow.options.transcriptVideoDownload ?? false,
    mediaCache: flow.options.mediaCache ?? null,
    url: flow.context.url,
    onProgress: flow.options.onProgress ?? null,
    mediaKind: "video",
  });
  if (ytdlpResult.notes.length > 0) flow.notes.push(...ytdlpResult.notes);
  if (ytdlpResult.error)
    flow.notes.push(`yt-dlp transcription failed: ${ytdlpResult.error.message}`);

  if (ytdlpResult.text) {
    return {
      text: normalizeTranscriptText(ytdlpResult.text),
      source: "yt-dlp",
      segments: ytdlpResult.segments ?? null,
      metadata: {
        provider: "yt-dlp",
        transcriptionProvider: ytdlpResult.provider,
        ...(flow.options.transcriptDiarization
          ? {
              speakerLabels: true,
              diarizationProvider: ytdlpResult.provider,
            }
          : {}),
        ...(flow.durationMetadata ?? {}),
      },
      attemptedProviders: flow.attemptedProviders,
      notes: joinNotes(flow.notes),
    };
  }

  if (mode === "yt-dlp" && ytdlpResult.error) throw ytdlpResult.error;
  return null;
}

export function buildUnavailableResult(flow: YouTubeProviderFlow): ProviderResult {
  flow.attemptedProviders.push("unavailable");
  return {
    text: null,
    source: "unavailable",
    metadata: {
      provider: "youtube",
      reason: "no_transcript_available",
      ...(flow.durationMetadata ?? {}),
    },
    attemptedProviders: flow.attemptedProviders,
    notes: joinNotes(flow.notes),
  };
}

function joinNotes(notes: string[]): string | null {
  return notes.length > 0 ? notes.join("; ") : null;
}
