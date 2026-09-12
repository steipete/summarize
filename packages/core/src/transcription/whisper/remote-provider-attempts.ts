import { transcribeWithAssemblyAi, transcribeFileWithAssemblyAi } from "./assemblyai.js";
import { cloudProviderLabel, type CloudProvider } from "./cloud-providers.js";
import { MAX_OPENAI_UPLOAD_BYTES } from "./constants.js";
import { transcribeWithDecodeRetry } from "./decode-retry.js";
import {
  transcribeFileWithDeepgram,
  transcribeWithDeepgram,
  type DeepgramTranscriptionResult,
} from "./deepgram.js";
import { transcribeWithFal } from "./fal.js";
import { isFfmpegAvailable } from "./ffmpeg.js";
import { transcribeFileWithGemini, transcribeWithGemini } from "./gemini.js";
import { shouldRetryOpenAiViaFfmpeg, transcribeWithOpenAi } from "./openai.js";
import type {
  ProviderResult,
  TranscriptionBytes,
  TranscriptionChunking,
  TranscriptionRun,
} from "./request.js";
import { formatBytes, wrapError } from "./utils.js";

export async function attemptRemoteProvider(
  provider: CloudProvider,
  run: TranscriptionRun,
  chunkBytes?: TranscriptionChunking["bytes"],
): Promise<ProviderResult | { kind: "skip" }> {
  const { source, options, notes } = run;
  if (provider === "openai") {
    if (source.kind !== "bytes") throw new Error("OpenAI transcription requires prepared bytes");
    return attemptOpenAi(source, run, chunkBytes);
  }
  if (provider === "fal" && !source.mediaType.toLowerCase().startsWith("audio/")) {
    notes.push(`Skipping FAL transcription: unsupported mediaType ${source.mediaType}`);
    return { kind: "skip" };
  }
  return callProvider(provider, async () => {
    switch (provider) {
      case "assemblyai":
        return source.kind === "file"
          ? transcribeFileWithAssemblyAi({
              filePath: source.filePath,
              mediaType: source.mediaType,
              apiKey: options.assemblyaiApiKey!,
            })
          : transcribeWithAssemblyAi(source.bytes, source.mediaType, options.assemblyaiApiKey!);
      case "gemini":
        return source.kind === "file"
          ? transcribeFileWithGemini({
              filePath: source.filePath,
              mediaType: source.mediaType,
              filename: source.filename,
              apiKey: options.geminiApiKey!,
              env: options.env,
            })
          : transcribeWithGemini(
              source.bytes,
              source.mediaType,
              source.filename,
              options.geminiApiKey!,
              { env: options.env },
            );
      case "deepgram":
        return source.kind === "file"
          ? transcribeFileWithDeepgram({
              filePath: source.filePath,
              mediaType: source.mediaType,
              apiKey: options.deepgramApiKey!,
              env: options.env,
            })
          : transcribeWithDeepgram(source.bytes, source.mediaType, options.deepgramApiKey!, {
              env: options.env,
            });
      case "fal":
        if (source.kind !== "bytes") throw new Error("FAL transcription requires prepared bytes");
        return transcribeWithFal(source.bytes, source.mediaType, options.falApiKey!);
    }
  });
}

async function callProvider(
  provider: Exclude<CloudProvider, "openai">,
  transcribe: () => Promise<string | null | DeepgramTranscriptionResult>,
): Promise<ProviderResult> {
  const label = cloudProviderLabel(provider, true);
  try {
    const output = await transcribe();
    const text = typeof output === "string" ? output : output?.text;
    if (!text)
      return { kind: "error", error: new Error(`${label} transcription returned empty text`) };
    return {
      kind: "result",
      result: {
        text,
        provider,
        error: null,
        notes: [],
        ...(output && typeof output === "object" ? { segments: output.segments } : {}),
      },
    };
  } catch (error) {
    return {
      kind: "error",
      error:
        (provider === "assemblyai" || provider === "deepgram") && error instanceof Error
          ? error
          : wrapError(`${label} transcription failed`, error),
    };
  }
}

async function attemptOpenAi(
  source: TranscriptionBytes,
  run: TranscriptionRun,
  chunkBytes?: TranscriptionChunking["bytes"],
): Promise<ProviderResult> {
  const { options, notes } = run;
  let input = source;
  let truncated = false;
  if (source.bytes.byteLength > MAX_OPENAI_UPLOAD_BYTES && chunkBytes && options.openaiApiKey) {
    if (await isFfmpegAvailable()) return { kind: "result", result: await chunkBytes(source) };
    notes.push(
      `Media too large for Whisper upload (${formatBytes(source.bytes.byteLength)}); transcribing first ${formatBytes(MAX_OPENAI_UPLOAD_BYTES)} only (install ffmpeg for full transcription)`,
    );
    input = { ...source, bytes: source.bytes.slice(0, MAX_OPENAI_UPLOAD_BYTES) };
    truncated = true;
  }
  const attempt = await transcribeWithDecodeRetry({
    source: input,
    provider: "openai",
    notes,
    transcribe: (input) =>
      transcribeWithOpenAi(input.bytes, input.mediaType, input.filename, options.openaiApiKey!, {
        env: options.env,
      }),
    shouldRetry: shouldRetryOpenAiViaFfmpeg,
  });
  run.source = truncated && attempt.kind === "error" ? source : attempt.source;
  return attempt;
}
