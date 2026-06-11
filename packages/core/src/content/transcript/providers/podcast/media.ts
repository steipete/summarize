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
import type { ProviderFetchOptions } from "../../types.js";
import { resolveTranscriptionStartInfo } from "../transcription-start.js";
import { MAX_REMOTE_MEDIA_BYTES, TRANSCRIPTION_TIMEOUT_MS } from "./constants.js";

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
    service: "podcast";
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
  if (!canChunk) {
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
    notes.push(`Transcribed first ${formatBytes(bytes.byteLength)} only (ffmpeg not available)`);
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

  if (head.contentLength !== null && head.contentLength <= MAX_OPENAI_UPLOAD_BYTES) {
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

export async function probeRemoteMedia(
  fetchImpl: typeof fetch,
  url: string,
): Promise<{ contentLength: number | null; mediaType: string | null; filename: string | null }> {
  try {
    const res = await fetchImpl(url, {
      method: "HEAD",
      redirect: "follow",
      signal: AbortSignal.timeout(TRANSCRIPTION_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error("head failed");
    const contentLength = parseContentLength(res.headers.get("content-length"));
    const mediaType = normalizeHeaderType(res.headers.get("content-type"));
    const filename = filenameFromUrl(url);
    return { contentLength, mediaType, filename };
  } catch {
    return { contentLength: null, mediaType: null, filename: filenameFromUrl(url) };
  }
}

export async function downloadCappedBytes(
  fetchImpl: typeof fetch,
  url: string,
  maxBytes: number,
  options?: {
    rejectAboveBytes?: number;
    totalBytes: number | null;
    onProgress?: ((downloadedBytes: number) => void) | null;
  } | null,
): Promise<Uint8Array> {
  const rejectAboveBytes = options?.rejectAboveBytes ?? null;
  const retainBytes = Math.min(maxBytes, rejectAboveBytes ?? maxBytes);
  const res = await fetchImpl(url, {
    redirect: "follow",
    headers: { Range: `bytes=0-${retainBytes - 1}` },
    signal: AbortSignal.timeout(TRANSCRIPTION_TIMEOUT_MS),
  });
  if (!res.ok) {
    throw new Error(`Download failed (${res.status})`);
  }
  const contentRange = parseContentRange(res.headers.get("content-range"));
  const contentRangeTotal = contentRange?.total ?? null;
  const contentLength =
    res.status === 206 ? null : parseContentLength(res.headers.get("content-length"));
  const getBoundedTotalBytes = contentRangeTotal ?? contentLength ?? null;
  const declaredTotalBytes = options?.totalBytes ?? null;
  const boundedTotalBytes = getBoundedTotalBytes ?? declaredTotalBytes;
  if (
    rejectAboveBytes !== null &&
    boundedTotalBytes !== null &&
    boundedTotalBytes > rejectAboveBytes
  ) {
    throw remoteMediaTooLargeError(boundedTotalBytes, rejectAboveBytes);
  }
  const declaredBodyBytes =
    res.status === 206 && contentRange !== null ? contentRange.end - contentRange.start + 1 : null;
  const verifyOverflowByReading =
    rejectAboveBytes !== null &&
    (boundedTotalBytes === null ||
      (declaredBodyBytes !== null && declaredBodyBytes <= retainBytes) ||
      (contentLength !== null && contentLength <= retainBytes) ||
      (getBoundedTotalBytes === null &&
        declaredTotalBytes !== null &&
        declaredTotalBytes <= retainBytes) ||
      (rejectAboveBytes <= maxBytes && boundedTotalBytes <= rejectAboveBytes));
  const body = res.body;
  if (!body) {
    const arrayBuffer = await res.arrayBuffer();
    if (verifyOverflowByReading && arrayBuffer.byteLength > rejectAboveBytes) {
      throw remoteMediaTooLargeError(arrayBuffer.byteLength, rejectAboveBytes);
    }
    return new Uint8Array(arrayBuffer.slice(0, retainBytes));
  }

  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let retained = 0;
  let totalRead = 0;
  let lastReported = 0;
  try {
    while (retained < retainBytes || verifyOverflowByReading) {
      const { value, done } = await reader.read();
      if (done) break;
      if (!value || value.byteLength === 0) continue;
      const nextTotalRead = totalRead + value.byteLength;
      if (declaredBodyBytes !== null && nextTotalRead > declaredBodyBytes) {
        throw new Error("Download failed (range response exceeded declared length)");
      }
      if (verifyOverflowByReading && nextTotalRead > rejectAboveBytes) {
        throw remoteMediaTooLargeError(nextTotalRead, rejectAboveBytes);
      }
      if (retained < retainBytes) {
        const remaining = retainBytes - retained;
        const next = value.byteLength > remaining ? value.slice(0, remaining) : value;
        chunks.push(next);
        retained += next.byteLength;
        if (retained - lastReported >= 64 * 1024) {
          lastReported = retained;
          options?.onProgress?.(retained);
        }
      }
      totalRead = nextTotalRead;
      if (retained >= retainBytes && !verifyOverflowByReading) break;
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  options?.onProgress?.(retained);

  const out = new Uint8Array(retained);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
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

export async function downloadToFile(
  fetchImpl: typeof fetch,
  url: string,
  filePath: string,
  options?: {
    maxBytes?: number;
    totalBytes: number | null;
    onProgress?: ((downloadedBytes: number) => void) | null;
  },
): Promise<number> {
  const res = await fetchImpl(url, {
    redirect: "follow",
    signal: AbortSignal.timeout(TRANSCRIPTION_TIMEOUT_MS),
  });
  if (!res.ok) {
    throw new Error(`Download failed (${res.status})`);
  }
  const maxBytes = options?.maxBytes ?? Number.POSITIVE_INFINITY;
  const body = res.body;
  if (!body) {
    const bytes = new Uint8Array(await res.arrayBuffer());
    if (bytes.byteLength > maxBytes) {
      throw remoteMediaTooLargeError(bytes.byteLength, maxBytes);
    }
    await fs.writeFile(filePath, bytes);
    options?.onProgress?.(bytes.byteLength);
    return bytes.byteLength;
  }

  const handle = await fs.open(filePath, "w");
  let downloadedBytes = 0;
  let lastReported = 0;
  try {
    const reader = body.getReader();
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        if (!value) continue;
        const nextDownloadedBytes = downloadedBytes + value.byteLength;
        if (nextDownloadedBytes > maxBytes) {
          throw remoteMediaTooLargeError(nextDownloadedBytes, maxBytes);
        }
        await handle.write(value);
        downloadedBytes = nextDownloadedBytes;
        if (downloadedBytes - lastReported >= 128 * 1024) {
          lastReported = downloadedBytes;
          options?.onProgress?.(downloadedBytes);
        }
      }
      options?.onProgress?.(downloadedBytes);
    } finally {
      await reader.cancel().catch(() => {});
    }
  } finally {
    await handle.close().catch(() => {});
  }
  return downloadedBytes;
}

function remoteMediaTooLargeError(bytes: number, maxBytes: number): Error {
  return new Error(
    `Remote media too large (${formatBytes(bytes)}). Limit is ${formatBytes(maxBytes)}.`,
  );
}

export function normalizeHeaderType(value: string | null): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.split(";")[0]?.trim().toLowerCase() ?? null;
}

export function parseContentLength(value: string | null): number | null {
  if (!value) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : null;
}

export function parseContentRangeTotal(value: string | null): number | null {
  return parseContentRange(value)?.total ?? null;
}

function parseContentRange(
  value: string | null,
): { start: number; end: number; total: number } | null {
  if (!value) return null;
  const match = value.trim().match(/^bytes\s+(\d+)-(\d+)\/(\d+)$/i);
  if (!match?.[1] || !match[2] || !match[3]) return null;
  const start = Number(match[1]);
  const end = Number(match[2]);
  const total = Number(match[3]);
  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(end) ||
    !Number.isSafeInteger(total) ||
    start < 0 ||
    end < start ||
    total <= end
  ) {
    return null;
  }
  return { start, end, total };
}

export function filenameFromUrl(url: string): string | null {
  try {
    const parsed = new URL(url);
    const base = parsed.pathname.split("/").pop() ?? "";
    return base.trim().length > 0 ? base : null;
  } catch {
    return null;
  }
}

export function formatBytes(bytes: number): string {
  const units = ["B", "KB", "MB", "GB"];
  let value = bytes;
  let idx = 0;
  while (value >= 1024 && idx < units.length - 1) {
    value /= 1024;
    idx += 1;
  }
  const decimals = value >= 10 || idx === 0 ? 0 : 1;
  return `${value.toFixed(decimals)}${units[idx]}`;
}
