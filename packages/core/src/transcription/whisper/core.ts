import { promises as fs } from "node:fs";
import { transcribeChunkedFile } from "./chunking.js";
import { DEFAULT_SEGMENT_SECONDS, MAX_OPENAI_UPLOAD_BYTES } from "./constants.js";
import {
  transcribeMediaBytesWithDiarization,
  transcribeMediaFileWithDiarization,
} from "./diarization.js";
import { isFfmpegAvailable, transcodeBytesToMp3 } from "./ffmpeg.js";
import { shouldRetryGroqViaFfmpeg, transcribeWithGroq } from "./groq.js";
import {
  transcribeWithLocalOnnx,
  transcribeWithLocalOnnxFile,
  transcribeWithLocalWhisperBytes,
  transcribeWithLocalWhisperFile,
} from "./local.js";
import {
  transcribeBytesWithRemoteFallbacks,
  transcribeFileWithRemoteFallbacks,
  transcribeOversizedBytesViaTempFile,
} from "./remote.js";
import type {
  DiarizationPreference,
  WhisperProgressEvent,
  WhisperTranscriptionResult,
} from "./types.js";
import { formatBytes, wrapError } from "./utils.js";

type Env = Record<string, string | undefined>;

type MediaRequest = {
  groqApiKey: string | null;
  assemblyaiApiKey?: string | null;
  elevenlabsApiKey?: string | null;
  geminiApiKey?: string | null;
  openaiApiKey: string | null;
  falApiKey: string | null;
  diarization?: DiarizationPreference | null;
  totalDurationSeconds?: number | null;
  onProgress?: ((event: WhisperProgressEvent) => void) | null;
  env?: Env;
};

export async function transcribeMediaWithWhisper({
  bytes,
  mediaType,
  filename,
  groqApiKey,
  skipGroq = false,
  assemblyaiApiKey = null,
  elevenlabsApiKey = null,
  geminiApiKey = null,
  openaiApiKey,
  falApiKey,
  diarization = null,
  totalDurationSeconds = null,
  onProgress,
  env = process.env,
}: {
  bytes: Uint8Array;
  mediaType: string;
  filename: string | null;
  skipGroq?: boolean;
} & MediaRequest): Promise<WhisperTranscriptionResult> {
  if (diarization) {
    return await transcribeMediaBytesWithDiarization({
      bytes,
      mediaType,
      filename,
      preference: diarization,
      elevenlabsApiKey,
      openaiApiKey,
      env,
      totalDurationSeconds,
      onProgress,
    });
  }

  const notes: string[] = [];

  let groqError: Error | null = null;
  if (groqApiKey && !skipGroq) {
    const groqResult = await transcribeWithGroqFirst({
      bytes,
      mediaType,
      filename,
      groqApiKey,
      notes,
    });
    bytes = groqResult.bytes;
    mediaType = groqResult.mediaType;
    filename = groqResult.filename;
    if (groqResult.text) {
      return { text: groqResult.text, provider: "groq", error: null, notes };
    }
    groqError = groqResult.error;
  }

  if (groqError) {
    notes.push(
      `Groq transcription failed; falling back to local/AssemblyAI/Gemini/OpenAI: ${groqError.message}`,
    );
  }

  const onnx = await transcribeWithLocalOnnx({
    bytes,
    mediaType,
    filename,
    totalDurationSeconds,
    onProgress,
    env,
    notes,
  });
  if (onnx) return onnx;

  const local = await transcribeWithLocalWhisperBytes({
    bytes,
    mediaType,
    filename,
    totalDurationSeconds,
    onProgress,
    env,
    notes,
  });
  if (local) return local;

  return await transcribeBytesWithRemoteFallbacks({
    bytes,
    mediaType,
    filename,
    notes,
    groqApiKey,
    groqError,
    assemblyaiApiKey,
    geminiApiKey,
    openaiApiKey,
    falApiKey,
    env,
    onProgress,
    transcribeOversizedBytesWithChunking: ({ bytes, mediaType, filename, onProgress }) =>
      transcribeOversizedBytesViaTempFile({
        bytes,
        mediaType,
        filename,
        onProgress,
        transcribeFile: ({ filePath, mediaType, filename, onProgress }) =>
          transcribeMediaFileWithWhisper({
            filePath,
            mediaType,
            filename,
            groqApiKey,
            assemblyaiApiKey,
            geminiApiKey,
            openaiApiKey,
            falApiKey,
            segmentSeconds: DEFAULT_SEGMENT_SECONDS,
            onProgress,
            env,
          }),
      }),
  });
}

export async function transcribeMediaFileWithWhisper({
  filePath,
  mediaType,
  filename,
  groqApiKey,
  assemblyaiApiKey = null,
  elevenlabsApiKey = null,
  geminiApiKey = null,
  openaiApiKey,
  falApiKey,
  diarization = null,
  segmentSeconds = DEFAULT_SEGMENT_SECONDS,
  totalDurationSeconds = null,
  onProgress = null,
  env = process.env,
}: {
  filePath: string;
  mediaType: string;
  filename: string | null;
  segmentSeconds?: number;
} & MediaRequest): Promise<WhisperTranscriptionResult> {
  if (diarization) {
    return await transcribeMediaFileWithDiarization({
      filePath,
      mediaType,
      filename,
      preference: diarization,
      elevenlabsApiKey,
      openaiApiKey,
      env,
      totalDurationSeconds,
      onProgress,
    });
  }

  const notes: string[] = [];

  let skipGroqInNestedCalls = false;
  let groqError: Error | null = null;
  if (groqApiKey) {
    skipGroqInNestedCalls = true;
    const groqResult = await transcribeGroqFileFirst({
      filePath,
      mediaType,
      filename,
      groqApiKey,
      assemblyaiApiKey,
      geminiApiKey,
      openaiApiKey,
      falApiKey,
      segmentSeconds,
      totalDurationSeconds,
      onProgress,
      env,
      notes,
    });
    if (groqResult.text) return groqResult;
    groqError = groqResult.error;
  }

  const onnx = await transcribeWithLocalOnnxFile({
    filePath,
    mediaType,
    totalDurationSeconds,
    onProgress,
    env,
    notes,
  });
  if (onnx) return onnx;

  const local = await transcribeWithLocalWhisperFile({
    filePath,
    mediaType,
    totalDurationSeconds,
    onProgress,
    env,
    notes,
  });
  if (local) return local;

  return await transcribeFileWithRemoteFallbacks({
    filePath,
    mediaType,
    filename,
    notes,
    groqApiKey,
    groqError,
    assemblyaiApiKey,
    geminiApiKey,
    openaiApiKey,
    falApiKey,
    env,
    totalDurationSeconds,
    onProgress,
    transcribeChunkedFile: ({ filePath, segmentSeconds, totalDurationSeconds, onProgress }) =>
      transcribeChunkedFile({
        filePath,
        segmentSeconds,
        totalDurationSeconds,
        onProgress,
        transcribeSegment: ({ bytes, filename }) =>
          transcribeMediaWithWhisper({
            bytes,
            mediaType: "audio/mpeg",
            filename,
            groqApiKey,
            skipGroq: skipGroqInNestedCalls,
            assemblyaiApiKey,
            geminiApiKey,
            openaiApiKey,
            falApiKey,
            env,
          }),
      }),
  });
}

async function transcribeWithGroqFirst({
  bytes,
  mediaType,
  filename,
  groqApiKey,
  notes,
}: {
  bytes: Uint8Array;
  mediaType: string;
  filename: string | null;
  groqApiKey: string;
  notes: string[];
}): Promise<{
  text: string | null;
  error: Error | null;
  bytes: Uint8Array;
  mediaType: string;
  filename: string | null;
}> {
  let groqError: Error | null = null;
  try {
    const text = await transcribeWithGroq(bytes, mediaType, filename, groqApiKey);
    if (text) return { text, error: null, bytes, mediaType, filename };
    groqError = new Error("Groq transcription returned empty text");
  } catch (error) {
    groqError = wrapError("Groq transcription failed", error);
  }

  if (groqError && shouldRetryGroqViaFfmpeg(groqError)) {
    const canTranscode = await isFfmpegAvailable();
    if (canTranscode) {
      try {
        notes.push("Groq could not decode media; transcoding via ffmpeg and retrying");
        const mp3Bytes = await transcodeBytesToMp3(bytes);
        const retried = await transcribeWithGroq(mp3Bytes, "audio/mpeg", "audio.mp3", groqApiKey);
        if (retried) {
          return {
            text: retried,
            error: null,
            bytes: mp3Bytes,
            mediaType: "audio/mpeg",
            filename: "audio.mp3",
          };
        }
        groqError = new Error("Groq transcription returned empty text after ffmpeg transcode");
        bytes = mp3Bytes;
        mediaType = "audio/mpeg";
        filename = "audio.mp3";
      } catch (error) {
        notes.push(
          `ffmpeg transcode failed; cannot retry Groq decode error: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    } else {
      notes.push("Groq could not decode media; install ffmpeg to enable transcoding retry");
    }
  }

  return { text: null, error: groqError, bytes, mediaType, filename };
}

async function transcribeGroqFileFirst({
  filePath,
  mediaType,
  filename,
  groqApiKey,
  assemblyaiApiKey,
  geminiApiKey,
  openaiApiKey,
  falApiKey,
  segmentSeconds,
  totalDurationSeconds,
  onProgress,
  env,
  notes,
}: {
  filePath: string;
  mediaType: string;
  filename: string | null;
  groqApiKey: string;
  assemblyaiApiKey: string | null;
  geminiApiKey: string | null;
  openaiApiKey: string | null;
  falApiKey: string | null;
  segmentSeconds: number;
  totalDurationSeconds: number | null;
  onProgress?: ((event: WhisperProgressEvent) => void) | null;
  env: Env;
  notes: string[];
}): Promise<WhisperTranscriptionResult> {
  const stat = await fs.stat(filePath);
  if (stat.size <= MAX_OPENAI_UPLOAD_BYTES) {
    const fileBytes = new Uint8Array(await fs.readFile(filePath));
    try {
      const text = await transcribeWithGroq(fileBytes, mediaType, filename, groqApiKey);
      if (text) return { text, provider: "groq", error: null, notes };
      const error = new Error("Groq transcription returned empty text");
      notes.push(
        "Groq transcription returned empty text; falling back to local/AssemblyAI/Gemini/OpenAI",
      );
      return { text: null, provider: "groq", error, notes };
    } catch (error) {
      const wrapped = wrapError("Groq transcription failed", error);
      notes.push(
        `Groq transcription failed; falling back to local/AssemblyAI/Gemini/OpenAI: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return { text: null, provider: "groq", error: wrapped, notes };
    }
  }

  const canChunk = await isFfmpegAvailable();
  if (!canChunk) {
    const error = new Error(
      `File too large for Groq upload (${formatBytes(stat.size)}); trying local providers`,
    );
    notes.push(error.message);
    return { text: null, provider: "groq", error, notes };
  }

  const chunked = await transcribeChunkedFile({
    filePath,
    segmentSeconds,
    totalDurationSeconds,
    onProgress,
    transcribeSegment: ({ bytes, filename }) =>
      transcribeMediaWithWhisper({
        bytes,
        mediaType: "audio/mpeg",
        filename,
        groqApiKey,
        assemblyaiApiKey,
        geminiApiKey,
        openaiApiKey,
        falApiKey,
        env,
      }),
  });
  if (chunked.notes.length > 0) notes.push(...chunked.notes);
  if (chunked.text) return { ...chunked, notes };
  const error = chunked.error ?? new Error("Groq chunked transcription failed");
  notes.push(
    `Groq chunked transcription failed; falling back to local/AssemblyAI/Gemini/OpenAI: ${error.message}`,
  );
  return { text: null, provider: "groq", error, notes };
}
