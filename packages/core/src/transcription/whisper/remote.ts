import { promises as fs } from "node:fs";
import {
  cloudProviderLabel,
  formatCloudFallbackTargets,
  resolveCloudProviderOrder,
  type CloudProvider,
} from "./cloud-providers.js";
import { DEFAULT_SEGMENT_SECONDS, MAX_OPENAI_UPLOAD_BYTES } from "./constants.js";
import { isFfmpegAvailable } from "./ffmpeg.js";
import { buildMissingTranscriptionProviderMessage } from "./provider-setup.js";
import { attemptRemoteProvider } from "./remote-provider-attempts.js";
import {
  emitInitialProgress,
  type TranscriptionChunking,
  type TranscriptionRun,
} from "./request.js";
import type { WhisperTranscriptionResult } from "./types.js";
import { formatBytes, readFirstBytes } from "./utils.js";

function withMergedNotes(
  result: WhisperTranscriptionResult,
  notes: string[],
): WhisperTranscriptionResult {
  return { ...result, notes: result.notes.length ? [...notes, ...result.notes] : notes };
}

function noProvider({ options, groqError, notes }: TranscriptionRun): WhisperTranscriptionResult {
  return options.groqApiKey
    ? {
        text: null,
        provider: "groq",
        error: groqError ?? new Error("No transcription providers available"),
        notes,
      }
    : {
        text: null,
        provider: null,
        error: new Error(buildMissingTranscriptionProviderMessage()),
        notes,
      };
}

export async function transcribeWithRemoteFallbacks(
  run: TranscriptionRun,
  chunking: TranscriptionChunking,
): Promise<WhisperTranscriptionResult> {
  const { options, notes } = run;
  const providers = resolveCloudProviderOrder(options);
  if (!providers.length) return noProvider(run);
  const allowByteChunking = run.source.kind === "bytes";
  const fileSize = run.source.kind === "file" ? (await fs.stat(run.source.filePath)).size : null;
  if (run.source.kind === "file") emitInitialProgress(run);
  let lastFailure: { provider: CloudProvider; error: Error } | null = null;

  for (const [index, provider] of providers.entries()) {
    const remaining = providers.slice(index + 1);
    if (run.source.kind === "file" && (provider === "openai" || provider === "fal")) {
      const source = run.source;
      let partialRead = false;
      if (provider === "openai" && fileSize! > MAX_OPENAI_UPLOAD_BYTES) {
        if (await isFfmpegAvailable()) {
          return withMergedNotes(
            await chunking.file(
              source.filePath,
              DEFAULT_SEGMENT_SECONDS,
              Boolean(options.groqApiKey),
            ),
            notes,
          );
        }
        notes.push(
          `Media too large for Whisper upload (${formatBytes(fileSize!)}); install ffmpeg to enable chunked transcription`,
        );
        if (remaining.includes("deepgram")) {
          notes.push(
            `Falling back to ${formatCloudFallbackTargets(remaining)} without truncating the media`,
          );
          continue;
        }
        partialRead = true;
      }
      run.source = {
        kind: "bytes",
        bytes: partialRead
          ? await readFirstBytes(source.filePath, MAX_OPENAI_UPLOAD_BYTES)
          : new Uint8Array(await fs.readFile(source.filePath)),
        mediaType: source.mediaType,
        filename: source.filename,
      };
      lastFailure = null;
    }

    const attempt = await attemptRemoteProvider(
      provider,
      run,
      allowByteChunking ? chunking.bytes : undefined,
    );
    if (attempt.kind === "result") return withMergedNotes(attempt.result, notes);
    if (attempt.kind === "skip") continue;
    lastFailure = { provider, error: attempt.error };
    const fallbacks = remaining.filter(
      (candidate) =>
        run.source.kind === "file" ||
        candidate !== "fal" ||
        run.source.mediaType.toLowerCase().startsWith("audio/"),
    );
    if (fallbacks.length) {
      notes.push(
        `${cloudProviderLabel(provider, false)} transcription failed; falling back to ${formatCloudFallbackTargets(fallbacks)}: ${attempt.error.message}`,
      );
    }
  }
  return lastFailure
    ? { text: null, provider: lastFailure.provider, error: lastFailure.error, notes }
    : noProvider(run);
}
