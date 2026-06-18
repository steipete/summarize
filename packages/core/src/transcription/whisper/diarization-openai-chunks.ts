import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { formatDiarizedTranscript } from "./diarization-format.js";
import { isFfmpegAvailable, runFfmpegSegment } from "./ffmpeg.js";
import { OpenAiTranscriptionHttpError, transcribeFileWithOpenAiDiarization } from "./openai.js";
import type {
  TranscriptionSegment,
  WhisperProgressEvent,
  WhisperTranscriptionResult,
} from "./types.js";

export const OPENAI_DIARIZATION_CHUNK_SECONDS = 8 * 60;
const OPENAI_DIARIZATION_CHUNK_CONCURRENCY = 1;
const OPENAI_DIARIZATION_CHUNK_ATTEMPTS = 3;

export async function transcribeOpenAiMediaFileInChunks({
  filePath,
  apiKey,
  env,
  totalDurationSeconds,
  onProgress,
}: {
  filePath: string;
  apiKey: string;
  env: Record<string, string | undefined>;
  totalDurationSeconds: number | null;
  onProgress?: ((event: WhisperProgressEvent) => void) | null;
}): Promise<WhisperTranscriptionResult> {
  if (!(await isFfmpegAvailable())) {
    throw new Error("OpenAI diarization of long media requires ffmpeg to split it");
  }

  const chunkRoot = await fs.mkdtemp(join(tmpdir(), "summarize-diarize-openai-chunks-"));
  const chunkDurationSeconds =
    totalDurationSeconds === null
      ? OPENAI_DIARIZATION_CHUNK_SECONDS
      : resolveOpenAiDiarizationChunkSeconds(totalDurationSeconds);
  try {
    await runFfmpegSegment({
      inputPath: filePath,
      outputPattern: join(chunkRoot, "chunk-%05d.mp3"),
      segmentSeconds: chunkDurationSeconds,
    });
    const chunkPaths = (await fs.readdir(chunkRoot))
      .filter((name) => name.endsWith(".mp3"))
      .sort()
      .map((name) => join(chunkRoot, name));
    if (chunkPaths.length === 0) throw new Error("ffmpeg produced no OpenAI diarization chunks");
    let completedChunks = 0;
    const chunkResults = await mapWithConcurrency(
      chunkPaths,
      OPENAI_DIARIZATION_CHUNK_CONCURRENCY,
      async (chunkPath, chunkIndex) => {
        const result = await transcribeOpenAiChunkWithRetry({ chunkPath, apiKey, env });
        completedChunks += 1;
        onProgress?.({
          partIndex: completedChunks,
          parts: chunkPaths.length,
          processedDurationSeconds:
            totalDurationSeconds === null
              ? null
              : Math.min(completedChunks * chunkDurationSeconds, totalDurationSeconds),
          totalDurationSeconds,
        });
        return { chunkIndex, result };
      },
    );

    const segments = chunkResults
      .flatMap(({ chunkIndex, result }) =>
        namespaceOpenAiChunkSegments(result.segments ?? [], chunkIndex, chunkDurationSeconds),
      )
      .sort((left, right) => left.startMs - right.startMs);
    const text = formatDiarizedTranscript(segments);
    if (!text) throw new Error("OpenAI transcription returned no speaker-labelled segments");
    return {
      text,
      provider: "openai",
      error: null,
      notes: [
        `OpenAI diarization: split long media into ${chunkPaths.length} chunks of up to 8 minutes`,
      ],
      segments,
    };
  } finally {
    await fs.rm(chunkRoot, { recursive: true, force: true }).catch(() => {});
  }
}

async function transcribeOpenAiChunkWithRetry({
  chunkPath,
  apiKey,
  env,
}: {
  chunkPath: string;
  apiKey: string;
  env: Record<string, string | undefined>;
}): Promise<WhisperTranscriptionResult> {
  let lastError: unknown = null;
  for (let attempt = 1; attempt <= OPENAI_DIARIZATION_CHUNK_ATTEMPTS; attempt += 1) {
    try {
      return await transcribeFileWithOpenAiDiarization({
        filePath: chunkPath,
        mediaType: "audio/mpeg",
        filename: basename(chunkPath),
        apiKey,
        options: { env, allowEmpty: true },
      });
    } catch (error) {
      lastError = error;
      if (attempt === OPENAI_DIARIZATION_CHUNK_ATTEMPTS || !isRetryableOpenAiError(error)) {
        throw error;
      }
      const retryAfterMs =
        error instanceof OpenAiTranscriptionHttpError ? error.retryAfterMs : null;
      const delayMs = (retryAfterMs ?? attempt * 10_000) + Math.floor(Math.random() * 1_000);
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
  throw lastError;
}

export function isRetryableOpenAiError(error: unknown): boolean {
  if (error instanceof OpenAiTranscriptionHttpError) {
    return (
      error.status === 408 || error.status === 409 || error.status === 429 || error.status >= 500
    );
  }
  if (error instanceof DOMException) {
    return ["AbortError", "NetworkError", "TimeoutError"].includes(error.name);
  }
  if (!(error instanceof TypeError)) return false;
  if (/fetch|network|socket|connection|terminated/i.test(error.message)) return true;
  const causeCode =
    error.cause && typeof error.cause === "object" && "code" in error.cause
      ? String(error.cause.code)
      : "";
  return new Set([
    "EAI_AGAIN",
    "ECONNRESET",
    "ENETUNREACH",
    "ENOTFOUND",
    "EPIPE",
    "ETIMEDOUT",
    "UND_ERR_CONNECT_TIMEOUT",
    "UND_ERR_HEADERS_TIMEOUT",
    "UND_ERR_SOCKET",
  ]).has(causeCode);
}

export function resolveOpenAiDiarizationChunkSeconds(totalDurationSeconds: number): number {
  const chunkCount = Math.ceil(totalDurationSeconds / OPENAI_DIARIZATION_CHUNK_SECONDS);
  return Math.ceil(totalDurationSeconds / Math.max(1, chunkCount));
}

function namespaceOpenAiChunkSegments(
  segments: TranscriptionSegment[],
  chunkIndex: number,
  chunkDurationSeconds: number,
): TranscriptionSegment[] {
  const speakerOrdinals = new Map<string, number>();
  const offsetMs = chunkIndex * chunkDurationSeconds * 1_000;
  return segments.map((segment) => {
    if (!segment.speaker) throw new Error("OpenAI diarization segment has no speaker label");
    let ordinal = speakerOrdinals.get(segment.speaker);
    if (ordinal === undefined) {
      ordinal = speakerOrdinals.size + 1;
      speakerOrdinals.set(segment.speaker, ordinal);
    }
    return {
      ...segment,
      startMs: segment.startMs + offsetMs,
      endMs: segment.endMs == null ? null : segment.endMs + offsetMs,
      speaker: `Speaker ${chunkIndex * 1_000 + ordinal}`,
    };
  });
}

async function mapWithConcurrency<T, R>(
  values: T[],
  concurrency: number,
  callback: (value: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(values.length);
  let nextIndex = 0;
  let firstError: unknown = null;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, values.length) }, async () => {
      while (nextIndex < values.length && firstError === null) {
        const index = nextIndex;
        nextIndex += 1;
        try {
          results[index] = await callback(values[index]!, index);
        } catch (error) {
          firstError ??= error;
        }
      }
    }),
  );
  if (firstError !== null) throw firstError;
  return results;
}
