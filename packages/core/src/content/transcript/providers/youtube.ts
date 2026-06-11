import { resolveTranscriptionConfig } from "../transcription-config.js";
import type { ProviderContext, ProviderFetchOptions, ProviderResult } from "../types.js";
import { resolveTranscriptProviderCapabilities } from "./transcription-capability.js";
import {
  buildUnavailableResult,
  loadYoutubeHtml,
  resolveDurationMetadata,
  resolveEffectiveVideoId,
  tryApifyTranscript,
  tryManualCaptionTranscript,
  tryWebTranscript,
  tryYtDlpTranscript,
} from "./youtube/provider-flow.js";

const YOUTUBE_URL_PATTERN = /youtube\.com|youtu\.be/i;

export const canHandle = ({ url }: ProviderContext): boolean => YOUTUBE_URL_PATTERN.test(url);

export const fetchTranscript = async (
  context: ProviderContext,
  options: ProviderFetchOptions,
): Promise<ProviderResult> => {
  const attemptedProviders: ProviderResult["attemptedProviders"] = [];
  const notes: string[] = [];
  const transcription = resolveTranscriptionConfig(options);
  const { url } = context;
  const html = await loadYoutubeHtml(context, options);
  const mode = options.youtubeTranscriptMode;
  const diarization = options.transcriptDiarization ?? null;
  const progress = typeof options.onProgress === "function" ? options.onProgress : null;
  const transcriptionCapabilities = await resolveTranscriptProviderCapabilities({
    transcription,
    ytDlpPath: options.ytDlpPath,
    diarization,
  });
  const canRunYtDlp = transcriptionCapabilities.canRunYtDlp;
  const pushHint = (hint: string) => {
    progress?.({ kind: "transcript-start", url, service: "youtube", hint });
  };

  if (mode === "yt-dlp" && !options.ytDlpPath) {
    throw new Error(
      "Missing yt-dlp binary for --youtube yt-dlp (set YT_DLP_PATH or install yt-dlp)",
    );
  }
  if (mode === "yt-dlp" && !transcriptionCapabilities.canTranscribe) {
    throw new Error(
      "Missing transcription provider for --youtube yt-dlp (install whisper-cpp or set GROQ_API_KEY/ASSEMBLYAI_API_KEY/GEMINI_API_KEY/OPENAI_API_KEY/FAL_KEY)",
    );
  }
  if (diarization && !options.ytDlpPath) {
    throw new Error(
      "Speaker diarization for YouTube requires yt-dlp (set YT_DLP_PATH or install yt-dlp)",
    );
  }
  if (diarization && !transcriptionCapabilities.canTranscribe) {
    throw new Error(transcriptionCapabilities.missingProviderNote);
  }

  const effectiveVideoId = resolveEffectiveVideoId(context);
  const canProceedWithoutWebContext =
    mode === "apify" ||
    (mode === "auto" && Boolean(options.apifyApiToken)) ||
    (canRunYtDlp &&
      (Boolean(diarization) || mode === "yt-dlp" || mode === "no-auto" || mode === "auto"));

  // yt-dlp and Apify fallbacks can run from the URL alone; web caption providers cannot.
  if (!html && !canProceedWithoutWebContext) {
    return { text: null, source: null, attemptedProviders };
  }
  const htmlText = html ?? "";
  if (!effectiveVideoId && !canProceedWithoutWebContext) {
    return { text: null, source: null, attemptedProviders };
  }
  const durationMetadata = await resolveDurationMetadata({
    htmlText,
    effectiveVideoId,
    url,
    options,
  });
  const flow = {
    context,
    options,
    transcription,
    htmlText,
    attemptedProviders,
    notes,
    effectiveVideoId,
    durationMetadata,
    canRunYtDlp,
    pushHint,
  };

  if (diarization) {
    const transcript = await tryYtDlpTranscript({ flow, mode: "yt-dlp" });
    if (transcript) return transcript;
    throw new Error("Speaker diarization returned no transcript");
  }

  // Try no-auto mode (skip auto-generated captions, fall back to yt-dlp)
  if (mode === "no-auto") {
    const manualTranscript = await tryManualCaptionTranscript(flow);
    if (manualTranscript) return manualTranscript;
    notes.push("No creator captions found, using yt-dlp transcription");
  }

  // Try web methods (youtubei, captionTracks) if mode is 'auto' or 'web'
  if (mode === "auto" || mode === "web") {
    const transcript = await tryWebTranscript(flow);
    if (transcript) return transcript;
  }

  // Try yt-dlp (audio download + Groq/AssemblyAI/Gemini/OpenAI/FAL transcription) if mode is 'auto', 'no-auto', or 'yt-dlp'
  if (mode === "yt-dlp" || mode === "no-auto" || (mode === "auto" && canRunYtDlp)) {
    const transcript = await tryYtDlpTranscript({ flow, mode });
    if (transcript) return transcript;

    // Auto mode: only try Apify after yt-dlp fails (last resort).
    if (mode === "auto") {
      const apifyResult = await tryApifyTranscript(
        flow,
        "YouTube: yt-dlp transcription failed; trying Apify",
      );
      if (apifyResult) return apifyResult;
    }
  }

  // Explicit apify mode: allow forcing it, but require a token.
  if (mode === "apify") {
    if (!options.apifyApiToken) {
      throw new Error("Missing APIFY_API_TOKEN for --youtube apify");
    }
    const apifyResult = await tryApifyTranscript(flow, "YouTube: fetching transcript (Apify)");
    if (apifyResult) return apifyResult;
  }

  // Auto mode: if yt-dlp cannot run (no binary/credentials), fall back to Apify last-last.
  if (mode === "auto" && !canRunYtDlp) {
    const apifyResult = await tryApifyTranscript(
      flow,
      "YouTube: captions unavailable; trying Apify",
    );
    if (apifyResult) return apifyResult;
  }

  return buildUnavailableResult(flow);
};
