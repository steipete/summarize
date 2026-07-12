import {
  isTwitterBroadcastUrl,
  isTwitterStatusUrl,
} from "../../link-preview/content/twitter-utils.js";
import { inferDirectMediaKind, isDirectMediaUrl, isLoomVideoUrl } from "../../url.js";
import { normalizeTranscriptText } from "../normalize.js";
import { resolveTranscriptionConfig } from "../transcription-config.js";
import type { ProviderContext, ProviderFetchOptions, ProviderResult } from "../types.js";
import { fetchDirectMediaTranscript } from "./generic-direct-media.js";
import { detectEmbeddedMedia, fetchCaptionTrack } from "./generic-embedded.js";
import { fetchTwitterMediaTranscript } from "./generic-twitter.js";

export const canHandle = (): boolean => true;

export const fetchTranscript = async (
  context: ProviderContext,
  options: ProviderFetchOptions,
): Promise<ProviderResult> => {
  const attemptedProviders: ProviderResult["attemptedProviders"] = [];
  const notes: string[] = [];
  const transcription = resolveTranscriptionConfig(options);

  const embedded = context.html ? detectEmbeddedMedia(context.html, context.url) : null;
  const twitterStatus = isTwitterStatusUrl(context.url);
  const twitterMedia = twitterStatus || isTwitterBroadcastUrl(context.url);
  const loomVideo = isLoomVideoUrl(context.url);
  const hasEmbeddedMedia = Boolean(embedded?.mediaUrl || embedded?.kind);
  const mediaKindHint =
    options.mediaKindHint ?? embedded?.kind ?? inferDirectMediaKind(context.url) ?? null;
  if (embedded?.track) {
    attemptedProviders.push("embedded");
    const caption = await fetchCaptionTrack(
      options.fetch,
      embedded.track,
      notes,
      Boolean(options.transcriptTimestamps),
    );
    if (caption?.text) {
      return {
        text: normalizeTranscriptText(caption.text),
        source: "embedded",
        segments: options.transcriptTimestamps ? (caption.segments ?? null) : null,
        attemptedProviders,
        metadata: {
          provider: "embedded",
          kind: embedded.kind,
          trackUrl: embedded.track.url,
          trackType: embedded.track.type,
          trackLanguage: embedded.track.language,
        },
        notes: notes.length > 0 ? notes.join("; ") : null,
      };
    }
  }

  const shouldAttemptMediaTranscript =
    options.mediaTranscriptMode === "prefer" || (twitterStatus && hasEmbeddedMedia) || loomVideo;
  const mediaUrl = shouldAttemptMediaTranscript
    ? loomVideo
      ? context.url
      : (embedded?.mediaUrl ?? (isDirectMediaUrl(context.url) ? context.url : null))
    : null;

  if (
    shouldAttemptMediaTranscript &&
    (mediaUrl || embedded?.kind || isDirectMediaUrl(context.url) || loomVideo)
  ) {
    const result = await fetchDirectMediaTranscript({
      url: mediaUrl ?? context.url,
      options,
      transcription,
      notes,
      attemptedProviders,
      kind: loomVideo
        ? "video"
        : (embedded?.kind ?? inferDirectMediaKind(mediaUrl ?? context.url) ?? null),
    });
    if (result) return result;
  }

  if (twitterStatus && options.mediaTranscriptMode !== "prefer" && !hasEmbeddedMedia) {
    return {
      text: null,
      source: null,
      attemptedProviders,
      metadata: { provider: "generic", kind: "twitter", reason: "media_mode_auto" },
      notes:
        "Twitter transcript skipped (media transcript mode is auto; enable --video-mode transcript to force audio).",
    };
  }

  if (!twitterMedia) {
    return {
      text: null,
      source: null,
      attemptedProviders,
      metadata: { provider: "generic", reason: "not_implemented" },
      notes: notes.length > 0 ? notes.join("; ") : null,
    };
  }
  return fetchTwitterMediaTranscript({
    context,
    options,
    transcription,
    attemptedProviders,
    notes,
    mediaKindHint,
  });
};
