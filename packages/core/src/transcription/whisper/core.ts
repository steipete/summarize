import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { transcribeChunkedFile } from "./chunking.js";
import { DEFAULT_SEGMENT_SECONDS, MAX_OPENAI_UPLOAD_BYTES } from "./constants.js";
import { transcribeWithDecodeRetry } from "./decode-retry.js";
import {
  transcribeMediaBytesWithDiarization,
  transcribeMediaFileWithDiarization,
} from "./diarization.js";
import { isFfmpegAvailable } from "./ffmpeg.js";
import { shouldRetryGroqViaFfmpeg, transcribeWithGroq } from "./groq.js";
import { transcribeWithLocalOnnx, transcribeWithLocalWhisper } from "./local.js";
import { transcribeWithRemoteFallbacks } from "./remote.js";
import {
  createTranscriptionRun,
  type TranscriptionChunking,
  type TranscriptionFile,
  type TranscriptionOptions,
  type TranscriptionRun,
  type TranscriptionSource,
} from "./request.js";
import type { WhisperTranscriptionResult } from "./types.js";
import { formatBytes, wrapError } from "./utils.js";

export function transcribeMediaWithWhisper({
  bytes,
  mediaType,
  filename,
  skipGroq = false,
  ...options
}: {
  bytes: Uint8Array;
  mediaType: string;
  filename: string | null;
  skipGroq?: boolean;
} & TranscriptionOptions): Promise<WhisperTranscriptionResult> {
  return transcribe({ kind: "bytes", bytes, mediaType, filename }, options, skipGroq);
}

export function transcribeMediaFileWithWhisper({
  filePath,
  mediaType,
  filename,
  onProgress = null,
  ...options
}: {
  filePath: string;
  mediaType: string;
  filename: string | null;
} & TranscriptionOptions): Promise<WhisperTranscriptionResult> {
  return transcribe({ kind: "file", filePath, mediaType, filename }, { ...options, onProgress });
}

async function transcribe(
  source: TranscriptionSource,
  options: TranscriptionOptions,
  skipGroq = false,
): Promise<WhisperTranscriptionResult> {
  const run = createTranscriptionRun(source, options);
  const settings = run.options;
  if (settings.diarization) {
    const request = {
      mediaType: source.mediaType,
      filename: source.filename,
      preference: settings.diarization,
      elevenlabsApiKey: settings.elevenlabsApiKey ?? null,
      openaiApiKey: settings.openaiApiKey,
      env: settings.env,
      totalDurationSeconds: settings.totalDurationSeconds,
      onProgress: settings.onProgress,
    };
    return source.kind === "bytes"
      ? transcribeMediaBytesWithDiarization({ ...request, bytes: source.bytes })
      : transcribeMediaFileWithDiarization({ ...request, filePath: source.filePath });
  }

  const chunking: TranscriptionChunking = {
    file: (filePath, segmentSeconds, skipGroq) =>
      transcribeChunkedFile({
        filePath,
        segmentSeconds,
        totalDurationSeconds: settings.totalDurationSeconds,
        onProgress: settings.onProgress,
        transcribeSegment: ({ bytes, filename }) =>
          transcribeMediaWithWhisper({
            ...settings,
            bytes,
            mediaType: "audio/mpeg",
            filename,
            skipGroq,
            diarization: null,
            totalDurationSeconds: null,
            onProgress: undefined,
          }),
      }),
    bytes: async (input) => {
      const filePath = join(tmpdir(), `summarize-whisper-${randomUUID()}`);
      try {
        await fs.writeFile(filePath, input.bytes);
        return await transcribeMediaFileWithWhisper({
          ...settings,
          filePath,
          mediaType: input.mediaType,
          filename: input.filename,
          segmentSeconds: DEFAULT_SEGMENT_SECONDS,
          diarization: null,
          totalDurationSeconds: null,
        });
      } finally {
        await fs.unlink(filePath).catch(() => {});
      }
    },
  };

  if (settings.groqApiKey && !skipGroq) {
    if (source.kind === "file") {
      const result = await transcribeGroqFileFirst(source, run, chunking);
      if (result.text) return result;
      run.groqError = result.error;
    } else {
      const attempt = await transcribeWithDecodeRetry({
        source,
        provider: "groq",
        notes: run.notes,
        transcribe: (input) =>
          transcribeWithGroq(input.bytes, input.mediaType, input.filename, settings.groqApiKey!),
        shouldRetry: shouldRetryGroqViaFfmpeg,
      });
      run.source = attempt.source;
      if (attempt.kind === "result") return { ...attempt.result, notes: run.notes };
      run.groqError = attempt.error;
      run.notes.push(
        `Groq transcription failed; falling back to local/AssemblyAI/Gemini/OpenAI/FAL/Deepgram: ${attempt.error.message}`,
      );
    }
  }

  return (
    (await transcribeWithLocalOnnx(run)) ??
    (await transcribeWithLocalWhisper(run)) ??
    transcribeWithRemoteFallbacks(run, chunking)
  );
}

async function transcribeGroqFileFirst(
  source: TranscriptionFile,
  { options, notes }: TranscriptionRun,
  chunking: TranscriptionChunking,
): Promise<WhisperTranscriptionResult> {
  const stat = await fs.stat(source.filePath);
  if (stat.size <= MAX_OPENAI_UPLOAD_BYTES) {
    const bytes = new Uint8Array(await fs.readFile(source.filePath));
    try {
      const text = await transcribeWithGroq(
        bytes,
        source.mediaType,
        source.filename,
        options.groqApiKey!,
      );
      if (text) return { text, provider: "groq", error: null, notes };
      const error = new Error("Groq transcription returned empty text");
      notes.push(
        "Groq transcription returned empty text; falling back to local/AssemblyAI/Gemini/OpenAI/FAL/Deepgram",
      );
      return { text: null, provider: "groq", error, notes };
    } catch (error) {
      notes.push(
        `Groq transcription failed; falling back to local/AssemblyAI/Gemini/OpenAI/FAL/Deepgram: ${error instanceof Error ? error.message : String(error)}`,
      );
      return {
        text: null,
        provider: "groq",
        error: wrapError("Groq transcription failed", error),
        notes,
      };
    }
  }

  if (!(await isFfmpegAvailable())) {
    const error = new Error(
      `File too large for Groq upload (${formatBytes(stat.size)}); trying local providers`,
    );
    notes.push(error.message);
    return { text: null, provider: "groq", error, notes };
  }

  const chunked = await chunking.file(source.filePath, options.segmentSeconds, false);
  notes.push(...chunked.notes);
  if (chunked.text) return { ...chunked, notes };
  const error = chunked.error ?? new Error("Groq chunked transcription failed");
  notes.push(
    `Groq chunked transcription failed; falling back to local/AssemblyAI/Gemini/OpenAI/FAL/Deepgram: ${error.message}`,
  );
  return { text: null, provider: "groq", error, notes };
}
