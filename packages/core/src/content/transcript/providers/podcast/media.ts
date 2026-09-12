import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  isFfmpegAvailable,
  MAX_OPENAI_UPLOAD_BYTES,
  probeMediaDurationSecondsWithFfprobe,
  transcribeMediaFileWithWhisper,
  transcribeMediaWithWhisper,
  type TranscriptionSegment,
} from "../../../../transcription/whisper.js";
import {
  resolveTranscriptionConfig,
  type TranscriptionConfig,
} from "../../transcription-config.js";
import type { ProviderFetchOptions, TranscriptService } from "../../types.js";
import { resolveTranscriptionStartInfo } from "../transcription-start.js";
import { MAX_REMOTE_MEDIA_BYTES } from "./constants.js";
import {
  downloadCappedBytes,
  downloadToFile,
  filenameFromUrl,
  formatBytes,
  normalizeHeaderType,
  parseContentLength,
  parseContentRangeTotal,
  probeRemoteMedia,
  remoteMediaTooLargeError,
} from "./media-download.js";

export {
  downloadCappedBytes,
  downloadToFile,
  filenameFromUrl,
  formatBytes,
  normalizeHeaderType,
  parseContentLength,
  parseContentRangeTotal,
  probeRemoteMedia,
} from "./media-download.js";

export type TranscribeRequest = {
  fetchImpl?: typeof fetch;
  url: string;
  filenameHint: string;
  durationSecondsHint: number | null;
};

export type TranscriptionResult = {
  text: string | null;
  provider: string | null;
  error: Error | null;
  segments?: TranscriptionSegment[] | null;
};

export async function transcribeMediaUrl({
  fetchImpl,
  transcription,
  env,
  url,
  filenameHint,
  durationSecondsHint,
  groqApiKey,
  assemblyaiApiKey,
  geminiApiKey,
  openaiApiKey,
  falApiKey,
  deepgramApiKey,
  notes,
  progress,
}: {
  fetchImpl: typeof fetch;
  transcription?: Partial<TranscriptionConfig> | null;
  env?: Record<string, string | undefined>;
  url: string;
  filenameHint: string;
  durationSecondsHint: number | null;
  groqApiKey?: string | null;
  assemblyaiApiKey?: string | null;
  geminiApiKey?: string | null;
  openaiApiKey?: string | null;
  falApiKey?: string | null;
  deepgramApiKey?: string | null;
  notes: string[];
  progress: {
    url: string;
    service: TranscriptService;
    onProgress: ProviderFetchOptions["onProgress"] | null;
  } | null;
}): Promise<TranscriptionResult> {
  const canChunk = await isFfmpegAvailable();
  const effectiveTranscription = resolveTranscriptionConfig({
    env,
    transcription,
    groqApiKey,
    assemblyaiApiKey,
    geminiApiKey,
    openaiApiKey,
    falApiKey,
    deepgramApiKey,
  });
  const effectiveEnv = effectiveTranscription.env ?? process.env;
  const remoteMediaMaxBytes = effectiveTranscription.remoteMediaMaxBytes ?? MAX_REMOTE_MEDIA_BYTES;
  const startInfo = await resolveTranscriptionStartInfo({
    transcription: effectiveTranscription,
  });
  const providerHint = startInfo.providerHint;
  const modelId = startInfo.modelId;

  const head = await probeRemoteMedia(fetchImpl, url);
  if (head.contentLength !== null && head.contentLength > remoteMediaMaxBytes) {
    throw remoteMediaTooLargeError(head.contentLength, remoteMediaMaxBytes);
  }

  const mediaType = head.mediaType ?? "application/octet-stream";
  const filename = head.filename ?? filenameHint;
  const totalBytes = head.contentLength;

  progress?.onProgress?.({
    kind: "transcript-media-download-start",
    url: progress.url,
    service: progress.service,
    mediaUrl: url,
    mediaKind: "audio",
    totalBytes,
  });
  const shouldUseDeepgramFileUpload =
    Boolean(effectiveTranscription.deepgramApiKey) &&
    (head.contentLength === null || head.contentLength > MAX_OPENAI_UPLOAD_BYTES);
  const shouldTranscribeInMemory =
    !shouldUseDeepgramFileUpload &&
    (!canChunk || (head.contentLength !== null && head.contentLength <= MAX_OPENAI_UPLOAD_BYTES));
  const onDownloadProgress = (downloadedBytes: number) =>
    progress?.onProgress?.({
      kind: "transcript-media-download-progress",
      url: progress.url,
      service: progress.service,
      downloadedBytes,
      totalBytes,
      mediaKind: "audio",
    });
  const tmpFile = shouldTranscribeInMemory
    ? null
    : join(tmpdir(), `summarize-podcast-${randomUUID()}.bin`);
  try {
    const source: { bytes: Uint8Array } | { filePath: string } = tmpFile
      ? { filePath: tmpFile }
      : {
          bytes: await downloadCappedMediaBytes(fetchImpl, url, remoteMediaMaxBytes, totalBytes, {
            onProgress: onDownloadProgress,
          }),
        };
    const downloadedBytes =
      "bytes" in source
        ? source.bytes.byteLength
        : await downloadToFile(fetchImpl, url, source.filePath, {
            maxBytes: remoteMediaMaxBytes,
            totalBytes,
            onProgress: onDownloadProgress,
          });
    progress?.onProgress?.({
      kind: "transcript-media-download-done",
      url: progress.url,
      service: progress.service,
      downloadedBytes,
      totalBytes,
      mediaKind: "audio",
    });
    const totalDurationSeconds =
      "bytes" in source
        ? durationSecondsHint
        : (durationSecondsHint ?? (await probeMediaDurationSecondsWithFfprobe(source.filePath)));
    progress?.onProgress?.({
      kind: "transcript-whisper-start",
      url: progress.url,
      service: progress.service,
      providerHint,
      modelId,
      totalDurationSeconds,
      parts: null,
    });
    if ("bytes" in source && !canChunk) {
      notes.push(
        `Transcribed first ${formatBytes(source.bytes.byteLength)} only (ffmpeg not available)`,
      );
    }
    const transcriptionOptions = {
      mediaType,
      filename,
      groqApiKey: effectiveTranscription.groqApiKey,
      assemblyaiApiKey: effectiveTranscription.assemblyaiApiKey,
      geminiApiKey: effectiveTranscription.geminiApiKey,
      openaiApiKey: effectiveTranscription.openaiApiKey,
      falApiKey: effectiveTranscription.falApiKey,
      deepgramApiKey: effectiveTranscription.deepgramApiKey,
      totalDurationSeconds,
      env: effectiveEnv,
      onProgress: (event) => {
        progress?.onProgress?.({
          kind: "transcript-whisper-progress",
          url: progress.url,
          service: progress.service,
          processedDurationSeconds: event.processedDurationSeconds,
          totalDurationSeconds: event.totalDurationSeconds,
          partIndex: event.partIndex,
          parts: event.parts,
        });
      },
    } satisfies Omit<Parameters<typeof transcribeMediaWithWhisper>[0], "bytes">;
    const transcript =
      "bytes" in source
        ? await transcribeMediaWithWhisper({ ...transcriptionOptions, bytes: source.bytes })
        : await transcribeMediaFileWithWhisper({
            ...transcriptionOptions,
            filePath: source.filePath,
          });
    if (transcript.notes.length > 0) notes.push(...transcript.notes);
    return {
      text: transcript.text,
      provider: transcript.provider,
      error: transcript.error,
      segments: transcript.segments ?? null,
    };
  } finally {
    if (tmpFile) await fs.unlink(tmpFile).catch(() => {});
  }
}

async function downloadCappedMediaBytes(
  fetchImpl: typeof fetch,
  url: string,
  remoteMediaMaxBytes: number,
  totalBytes: number | null,
  options?: { onProgress?: ((downloadedBytes: number) => void) | null },
): Promise<Uint8Array> {
  return await downloadCappedBytes(fetchImpl, url, MAX_OPENAI_UPLOAD_BYTES, {
    rejectAboveBytes: remoteMediaMaxBytes,
    totalBytes,
    onProgress: options?.onProgress,
  });
}
