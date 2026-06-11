import { extractYoutubePlayerBootstrap, resolveYoutubeAudio } from "../../../youtube.js";
import { normalizeTranscriptText } from "../../normalize.js";
import type { ProviderResult } from "../../types.js";
import { transcribeMediaUrl } from "../podcast/media.js";
import type { YouTubeProviderFlow } from "./provider-flow.js";

export async function tryNativeYoutubeMediaTranscript(
  flow: YouTubeProviderFlow,
): Promise<ProviderResult | null> {
  if (!flow.canTranscribe || !flow.effectiveVideoId || !flow.htmlText) return null;

  const bootstrap = extractYoutubePlayerBootstrap(flow.htmlText);
  if (!bootstrap) {
    flow.notes.push("YouTube native media fallback could not find player bootstrap data");
    return null;
  }

  flow.pushHint("YouTube: resolving audio without yt-dlp");
  flow.attemptedProviders.push("youtube-media");
  try {
    const media = await resolveYoutubeAudio({
      fetchImpl: flow.options.fetch,
      videoId: flow.effectiveVideoId,
      apiKey: bootstrap.apiKey,
      visitorData: bootstrap.visitorData,
      originalUrl: flow.context.url,
      watchHtml: flow.htmlText,
    });
    const result = await transcribeMediaUrl({
      fetchImpl: flow.options.fetch,
      transcription: flow.transcription,
      url: media.url,
      filenameHint: media.filename,
      durationSecondsHint: media.durationSeconds ?? flow.durationMetadata?.durationSeconds ?? null,
      notes: flow.notes,
      progress: {
        url: flow.context.url,
        service: "youtube",
        onProgress: flow.options.onProgress ?? null,
      },
    });
    if (result.error) {
      flow.notes.push(`YouTube native media transcription failed: ${result.error.message}`);
    }
    if (!result.text) return null;

    return {
      text: normalizeTranscriptText(result.text),
      source: "youtube-media",
      metadata: {
        provider: "youtube-media",
        resolver: media.resolver,
        transcriptionProvider: result.provider,
        ...(flow.durationMetadata ??
          (media.durationSeconds ? { durationSeconds: media.durationSeconds } : {})),
      },
      attemptedProviders: flow.attemptedProviders,
      notes: joinNotes(flow.notes),
    };
  } catch (error) {
    flow.notes.push(
      `YouTube native media fallback failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    return null;
  }
}

function joinNotes(notes: string[]): string | null {
  return notes.length > 0 ? notes.join("; ") : null;
}
