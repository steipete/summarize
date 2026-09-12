import type { ProviderResult } from "../../types.js";
import { fetchTranscriptWithYtDlp } from "../youtube/yt-dlp.js";
import { fetchFeedTranscript } from "./feed-flow.js";
import type { PodcastFlowContext } from "./flow-context.js";
import { buildWhisperResult, joinNotes } from "./results.js";
import { decodeXmlEntities, extractEnclosureFromFeed } from "./rss.js";

export async function tryPodcastTranscriptFromFeed(
  flow: PodcastFlowContext,
): Promise<ProviderResult | null> {
  return flow.feedHtml
    ? fetchFeedTranscript(flow, flow.feedHtml, null, { kind: "rss_podcast_transcript" })
    : null;
}

export async function tryFeedEnclosureTranscript(
  flow: PodcastFlowContext,
): Promise<ProviderResult | null> {
  if (!flow.feedHtml) return null;

  const feedEnclosure = extractEnclosureFromFeed(flow.feedHtml);
  if (!feedEnclosure) return null;

  const resolvedUrl = decodeXmlEntities(feedEnclosure.enclosureUrl);
  const durationSeconds = feedEnclosure.durationSeconds;

  try {
    const missing = flow.ensureTranscriptionProvider();
    if (missing) return missing;

    flow.pushOnce("whisper");
    const transcript = await flow.transcribe({
      url: resolvedUrl,
      filenameHint: "episode.mp3",
      durationSecondsHint: durationSeconds,
    });

    return buildWhisperResult({
      attemptedProviders: flow.attemptedProviders,
      notes: flow.notes,
      outcome: transcript,
      includeProviderOnFailure: true,
      metadata: {
        provider: "podcast",
        kind: "rss_enclosure",
        enclosureUrl: resolvedUrl,
        durationSeconds,
      },
    });
  } catch (error) {
    return {
      text: null,
      source: null,
      attemptedProviders: flow.attemptedProviders,
      notes: `Podcast enclosure download failed: ${error instanceof Error ? error.message : String(error)}`,
      metadata: { provider: "podcast", kind: "rss_enclosure", enclosureUrl: resolvedUrl },
    };
  }
}

export async function tryOgAudioTranscript(
  flow: PodcastFlowContext,
): Promise<ProviderResult | null> {
  if (!flow.feedHtml) return null;

  const ogAudioUrl = extractOgAudioUrl(flow.feedHtml);
  if (!ogAudioUrl) return null;

  flow.attemptedProviders.push("whisper");
  const result = await flow.transcribe({
    url: ogAudioUrl,
    filenameHint: "audio.mp3",
    durationSecondsHint: null,
  });
  if (result.text) {
    flow.notes.push("Used og:audio media (may be a preview clip, not the full episode)");
  }
  return buildWhisperResult({
    attemptedProviders: flow.attemptedProviders,
    notes: flow.notes,
    outcome: result,
    metadata: { provider: "podcast", kind: "og_audio", ogAudioUrl },
  });
}

export async function tryPodcastYtDlpTranscript(
  flow: PodcastFlowContext,
): Promise<ProviderResult | null> {
  if (!flow.options.ytDlpPath) return null;

  flow.attemptedProviders.push("yt-dlp");
  try {
    const result = await fetchTranscriptWithYtDlp({
      ytDlpPath: flow.options.ytDlpPath,
      transcription: flow.transcription,
      mediaCache: flow.options.mediaCache ?? null,
      url: flow.context.url,
      service: "podcast",
      mediaKind: "audio",
    });
    if (result.notes.length > 0) flow.notes.push(...result.notes);

    return {
      text: result.text,
      source: result.text ? "yt-dlp" : null,
      segments: result.segments ?? null,
      attemptedProviders: flow.attemptedProviders,
      notes: joinNotes(flow.notes),
      metadata: { provider: "podcast", kind: "yt_dlp", transcriptionProvider: result.provider },
    };
  } catch (error) {
    return {
      text: null,
      source: null,
      attemptedProviders: flow.attemptedProviders,
      notes: `yt-dlp transcription failed: ${error instanceof Error ? error.message : String(error)}`,
      metadata: { provider: "podcast", kind: "yt_dlp" },
    };
  }
}

export function buildNoTranscriptResult(flow: PodcastFlowContext): ProviderResult {
  const missing = flow.ensureTranscriptionProvider();
  if (missing) return missing;

  return {
    text: null,
    source: null,
    attemptedProviders: flow.attemptedProviders,
    metadata: { provider: "podcast", reason: "no_enclosure_and_no_yt_dlp" },
  };
}

function extractOgAudioUrl(html: string): string | null {
  const match = html.match(/<meta\s+property=['"]og:audio['"]\s+content=['"]([^'"]+)['"][^>]*>/i);
  if (!match?.[1]) return null;
  const candidate = match[1].trim();
  if (!candidate) return null;
  return /^https?:\/\//i.test(candidate) ? candidate : null;
}
