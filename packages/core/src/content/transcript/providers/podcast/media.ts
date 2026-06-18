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
  url: string;
  filenameHint: string;
  durationSecondsHint: number | null;
};

export type TranscriptionResult = {
  text: string | null;
  provider: string | null;
  error: Error | null;
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
  const shouldTranscribeInMemory =
    !canChunk || (head.contentLength !== null && head.contentLength <= MAX_OPENAI_UPLOAD_BYTES);
  if (shouldTranscribeInMemory) {
    const bytes = await downloadCappedMediaBytes(fetchImpl, url, remoteMediaMaxBytes, totalBytes, {
      onProgress: (downloadedBytes) =>
        progress?.onProgress?.({
          kind: "transcript-media-download-progress",
          url: progress.url,
          service: progress.service,
          downloadedBytes,
          totalBytes,
          mediaKind: "audio",
        }),
    });
    progress?.onProgress?.({
      kind: "transcript-media-download-done",
      url: progress.url,
      service: progress.service,
      downloadedBytes: bytes.byteLength,
      totalBytes,
      mediaKind: "audio",
    });
    progress?.onProgress?.({
      kind: "transcript-whisper-start",
      url: progress.url,
      service: progress.service,
      providerHint,
      modelId,
      totalDurationSeconds: durationSecondsHint,
      parts: null,
    });
    if (!canChunk) {
      notes.push(`Transcribed first ${formatBytes(bytes.byteLength)} only (ffmpeg not available)`);
    }
    const transcript = await transcribeMediaWithWhisper({
      bytes,
      mediaType,
      filename,
      groqApiKey: effectiveTranscription.groqApiKey,
      assemblyaiApiKey: effectiveTranscription.assemblyaiApiKey,
      geminiApiKey: effectiveTranscription.geminiApiKey,
      openaiApiKey: effectiveTranscription.openaiApiKey,
      falApiKey: effectiveTranscription.falApiKey,
      totalDurationSeconds: durationSecondsHint,
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
    });
    if (transcript.notes.length > 0) notes.push(...transcript.notes);
    return { text: transcript.text, provider: transcript.provider, error: transcript.error };
  }

  const tmpFile = join(tmpdir(), `summarize-podcast-${randomUUID()}.bin`);
  try {
    const downloadedBytes = await downloadToFile(fetchImpl, url, tmpFile, {
      maxBytes: remoteMediaMaxBytes,
      totalBytes,
      onProgress: (nextDownloadedBytes) =>
        progress?.onProgress?.({
          kind: "transcript-media-download-progress",
          url: progress.url,
          service: progress.service,
          downloadedBytes: nextDownloadedBytes,
          totalBytes,
          mediaKind: "audio",
        }),
    });
    progress?.onProgress?.({
      kind: "transcript-media-download-done",
      url: progress.url,
      service: progress.service,
      downloadedBytes,
      totalBytes,
      mediaKind: "audio",
    });

    const probedDurationSeconds =
      durationSecondsHint ?? (await probeMediaDurationSecondsWithFfprobe(tmpFile));
    progress?.onProgress?.({
      kind: "transcript-whisper-start",
      url: progress.url,
      service: progress.service,
      providerHint,
      modelId,
      totalDurationSeconds: probedDurationSeconds,
      parts: null,
    });
    const transcript = await transcribeMediaFileWithWhisper({
      filePath: tmpFile,
      mediaType,
      filename,
      groqApiKey: effectiveTranscription.groqApiKey,
      assemblyaiApiKey: effectiveTranscription.assemblyaiApiKey,
      geminiApiKey: effectiveTranscription.geminiApiKey,
      openaiApiKey: effectiveTranscription.openaiApiKey,
      falApiKey: effectiveTranscription.falApiKey,
      totalDurationSeconds: probedDurationSeconds,
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
    });
    if (transcript.notes.length > 0) notes.push(...transcript.notes);
    return { text: transcript.text, provider: transcript.provider, error: transcript.error };
  } finally {
    await fs.unlink(tmpFile).catch(() => {});
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
