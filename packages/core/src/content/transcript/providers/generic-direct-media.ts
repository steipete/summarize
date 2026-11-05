import type { DirectMediaKind } from "../../direct-media.js";
import { resolveLocalDirectMediaSource } from "../../local-file.js";
import { normalizeTranscriptText } from "../normalize.js";
import type { TranscriptionConfig } from "../transcription-config.js";
import type { ProviderFetchOptions, ProviderResult } from "../types.js";
import { resolveTranscriptProviderCapabilities } from "./transcription-capability.js";

export async function fetchDirectMediaTranscript({
  url,
  options,
  transcription,
  notes,
  attemptedProviders,
  kind,
  extraArgs,
}: {
  url: string;
  options: ProviderFetchOptions;
  transcription: TranscriptionConfig;
  notes: string[];
  attemptedProviders: ProviderResult["attemptedProviders"];
  kind: DirectMediaKind | null;
  extraArgs?: string[];
}): Promise<ProviderResult | null> {
  const mediaKind = kind ?? options.mediaKindHint ?? null;
  const localMedia = resolveLocalDirectMediaSource(url, mediaKind);
  if (!options.ytDlpPath && !localMedia) {
    notes.push("yt-dlp is not configured (set YT_DLP_PATH or ensure yt-dlp is on PATH)");
    return null;
  }

  const transcriptionCapabilities = await resolveTranscriptProviderCapabilities({
    transcription,
    ytDlpPath: options.ytDlpPath,
    diarization: options.transcriptDiarization ?? null,
  });
  if (!transcriptionCapabilities.canTranscribe) {
    notes.push(transcriptionCapabilities.missingProviderNote);
    return null;
  }

  attemptedProviders.push("yt-dlp");

  const mod = await import("./youtube/yt-dlp.js");
  const ytdlpResult = await mod.fetchTranscriptWithYtDlp({
    ytDlpPath: options.ytDlpPath,
    transcription,
    mediaCache: options.mediaCache ?? null,
    url,
    onProgress: options.onProgress ?? null,
    service: "generic",
    extraArgs,
    mediaKind,
    diarization: options.transcriptDiarization ?? null,
  });
  if (ytdlpResult.notes.length > 0) notes.push(...ytdlpResult.notes);

  if (ytdlpResult.text) {
    return {
      text: normalizeTranscriptText(ytdlpResult.text),
      source: "yt-dlp",
      attemptedProviders,
      segments: ytdlpResult.segments ?? null,
      metadata: {
        provider: "generic",
        kind: kind ?? "media",
        transcriptionProvider: ytdlpResult.provider,
        ...(options.transcriptDiarization
          ? {
              speakerLabels: true,
              diarizationProvider: ytdlpResult.provider,
            }
          : {}),
      },
      notes: notes.length > 0 ? notes.join("; ") : null,
    };
  }

  if (ytdlpResult.error) {
    notes.push(`yt-dlp transcription failed: ${ytdlpResult.error.message}`);
  }
  return null;
}
