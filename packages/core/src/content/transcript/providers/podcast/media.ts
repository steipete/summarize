import { randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  isFfmpegAvailable,
  isWhisperCppReady,
  MAX_OPENAI_UPLOAD_BYTES,
  probeMediaDurationSecondsWithFfprobe,
  resolveWhisperCppModelNameForDisplay,
  transcribeMediaFileWithWhisper,
  transcribeMediaWithWhisper,
} from '../../../../transcription/whisper.js'
import { resolveOnnxCommand } from '../../../../transcription/onnx-cli.js'
import type { ProviderFetchOptions } from '../../types.js'
import { MAX_REMOTE_MEDIA_BYTES, TRANSCRIPTION_TIMEOUT_MS } from './constants.js'

export type TranscribeRequest = {
  url: string
  filenameHint: string
  durationSecondsHint: number | null
}

export type TranscriptionResult = {
  text: string | null
  provider: string | null
  error: Error | null
}

export async function transcribeMediaUrl({
  fetchImpl,
  url,
  filenameHint,
  durationSecondsHint,
  openaiApiKey,
  falApiKey,
  notes,
  progress,
}: {
  fetchImpl: typeof fetch
  url: string
  filenameHint: string
  durationSecondsHint: number | null
  openaiApiKey: string | null
  falApiKey: string | null
  notes: string[]
  progress: {
    url: string
    service: 'podcast'
    onProgress: ProviderFetchOptions['onProgress'] | null
  } | null
}): Promise<TranscriptionResult> {
  const canChunk = await isFfmpegAvailable()
  const preferredTranscriber = process.env.SUMMARIZE_TRANSCRIBER?.trim().toLowerCase()
  const wantsOnnx = preferredTranscriber === 'parakeet' || preferredTranscriber === 'canary'
  const onnxReady = wantsOnnx && resolveOnnxCommand(preferredTranscriber as 'parakeet' | 'canary')
  const providerHint: 'cpp' | 'onnx' | 'openai' | 'fal' | 'openai->fal' | 'unknown' = onnxReady
    ? 'onnx'
    : (await isWhisperCppReady())
      ? 'cpp'
      : openaiApiKey && falApiKey
        ? 'openai->fal'
        : openaiApiKey
          ? 'openai'
          : falApiKey
            ? 'fal'
            : 'unknown'

  const head = await probeRemoteMedia(fetchImpl, url)
  if (head.contentLength !== null && head.contentLength > MAX_REMOTE_MEDIA_BYTES) {
    throw new Error(
      `Remote media too large (${formatBytes(head.contentLength)}). Limit is ${formatBytes(MAX_REMOTE_MEDIA_BYTES)}.`
    )
  }

  const mediaType = head.mediaType ?? 'application/octet-stream'
  const filename = head.filename ?? filenameHint
  const totalBytes = head.contentLength

  progress?.onProgress?.({
    kind: 'transcript-media-download-start',
    url: progress.url,
    service: progress.service,
    mediaUrl: url,
    totalBytes,
  })

  const modelId =
    providerHint === 'cpp'
      ? ((await resolveWhisperCppModelNameForDisplay()) ?? 'whisper.cpp')
      : openaiApiKey && falApiKey
        ? 'whisper-1->fal-ai/wizper'
        : openaiApiKey
          ? 'whisper-1'
          : falApiKey
            ? 'fal-ai/wizper'
            : null
  if (!canChunk) {
    const bytes = await downloadCappedBytes(fetchImpl, url, MAX_OPENAI_UPLOAD_BYTES, {
      totalBytes,
      onProgress: (downloadedBytes) =>
        progress?.onProgress?.({
          kind: 'transcript-media-download-progress',
          url: progress.url,
          service: progress.service,
          downloadedBytes,
          totalBytes,
        }),
    })
    progress?.onProgress?.({
      kind: 'transcript-media-download-done',
      url: progress.url,
      service: progress.service,
      downloadedBytes: bytes.byteLength,
      totalBytes,
    })
    progress?.onProgress?.({
      kind: 'transcript-whisper-start',
      url: progress.url,
      service: progress.service,
      providerHint,
      modelId,
      totalDurationSeconds: durationSecondsHint,
      parts: null,
    })
    notes.push(`Transcribed first ${formatBytes(bytes.byteLength)} only (ffmpeg not available)`)
    const transcript = await transcribeMediaWithWhisper({
      bytes,
      mediaType,
      filename,
      openaiApiKey,
      falApiKey,
      totalDurationSeconds: durationSecondsHint,
      onProgress: (event) => {
        progress?.onProgress?.({
          kind: 'transcript-whisper-progress',
          url: progress.url,
          service: progress.service,
          processedDurationSeconds: event.processedDurationSeconds,
          totalDurationSeconds: event.totalDurationSeconds,
          partIndex: event.partIndex,
          parts: event.parts,
        })
      },
    })
    if (transcript.notes.length > 0) notes.push(...transcript.notes)
    return { text: transcript.text, provider: transcript.provider, error: transcript.error }
  }

  if (head.contentLength !== null && head.contentLength <= MAX_OPENAI_UPLOAD_BYTES) {
    const bytes = await downloadCappedBytes(fetchImpl, url, MAX_OPENAI_UPLOAD_BYTES, {
      totalBytes,
      onProgress: (downloadedBytes) =>
        progress?.onProgress?.({
          kind: 'transcript-media-download-progress',
          url: progress.url,
          service: progress.service,
          downloadedBytes,
          totalBytes,
        }),
    })
    progress?.onProgress?.({
      kind: 'transcript-media-download-done',
      url: progress.url,
      service: progress.service,
      downloadedBytes: bytes.byteLength,
      totalBytes,
    })
    progress?.onProgress?.({
      kind: 'transcript-whisper-start',
      url: progress.url,
      service: progress.service,
      providerHint,
      modelId,
      totalDurationSeconds: durationSecondsHint,
      parts: null,
    })
    const transcript = await transcribeMediaWithWhisper({
      bytes,
      mediaType,
      filename,
      openaiApiKey,
      falApiKey,
      totalDurationSeconds: durationSecondsHint,
      onProgress: (event) => {
        progress?.onProgress?.({
          kind: 'transcript-whisper-progress',
          url: progress.url,
          service: progress.service,
          processedDurationSeconds: event.processedDurationSeconds,
          totalDurationSeconds: event.totalDurationSeconds,
          partIndex: event.partIndex,
          parts: event.parts,
        })
      },
    })
    if (transcript.notes.length > 0) notes.push(...transcript.notes)
    return { text: transcript.text, provider: transcript.provider, error: transcript.error }
  }

  const tmpFile = join(tmpdir(), `summarize-podcast-${randomUUID()}.bin`)
  try {
    const downloadedBytes = await downloadToFile(fetchImpl, url, tmpFile, {
      totalBytes,
      onProgress: (nextDownloadedBytes) =>
        progress?.onProgress?.({
          kind: 'transcript-media-download-progress',
          url: progress.url,
          service: progress.service,
          downloadedBytes: nextDownloadedBytes,
          totalBytes,
        }),
    })
    progress?.onProgress?.({
      kind: 'transcript-media-download-done',
      url: progress.url,
      service: progress.service,
      downloadedBytes,
      totalBytes,
    })

    const probedDurationSeconds =
      durationSecondsHint ?? (await probeMediaDurationSecondsWithFfprobe(tmpFile))
    progress?.onProgress?.({
      kind: 'transcript-whisper-start',
      url: progress.url,
      service: progress.service,
      providerHint,
      modelId,
      totalDurationSeconds: probedDurationSeconds,
      parts: null,
    })
    const transcript = await transcribeMediaFileWithWhisper({
      filePath: tmpFile,
      mediaType,
      filename,
      openaiApiKey,
      falApiKey,
      totalDurationSeconds: probedDurationSeconds,
      onProgress: (event) => {
        progress?.onProgress?.({
          kind: 'transcript-whisper-progress',
          url: progress.url,
          service: progress.service,
          processedDurationSeconds: event.processedDurationSeconds,
          totalDurationSeconds: event.totalDurationSeconds,
          partIndex: event.partIndex,
          parts: event.parts,
        })
      },
    })
    if (transcript.notes.length > 0) notes.push(...transcript.notes)
    return { text: transcript.text, provider: transcript.provider, error: transcript.error }
  } finally {
    await fs.unlink(tmpFile).catch(() => {})
  }
}

export async function probeRemoteMedia(
  fetchImpl: typeof fetch,
  url: string
): Promise<{ contentLength: number | null; mediaType: string | null; filename: string | null }> {
  try {
    const res = await fetchImpl(url, {
      method: 'HEAD',
      redirect: 'follow',
      signal: AbortSignal.timeout(TRANSCRIPTION_TIMEOUT_MS),
    })
    if (!res.ok) throw new Error('head failed')
    const contentLength = parseContentLength(res.headers.get('content-length'))
    const mediaType = normalizeHeaderType(res.headers.get('content-type'))
    const filename = filenameFromUrl(url)
    return { contentLength, mediaType, filename }
  } catch {
    return { contentLength: null, mediaType: null, filename: filenameFromUrl(url) }
  }
}

export async function downloadCappedBytes(
  fetchImpl: typeof fetch,
  url: string,
  maxBytes: number,
  options?: { totalBytes: number | null; onProgress?: ((downloadedBytes: number) => void) | null }
): Promise<Uint8Array> {
  const res = await fetchImpl(url, {
    redirect: 'follow',
    headers: { Range: `bytes=0-${maxBytes - 1}` },
    signal: AbortSignal.timeout(TRANSCRIPTION_TIMEOUT_MS),
  })
  if (!res.ok) {
    throw new Error(`Download failed (${res.status})`)
  }
  const body = res.body
  if (!body) {
    const arrayBuffer = await res.arrayBuffer()
    return new Uint8Array(arrayBuffer.slice(0, maxBytes))
  }

  const reader = body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  let lastReported = 0
  try {
    while (total < maxBytes) {
      const { value, done } = await reader.read()
      if (done) break
      if (!value) continue
      const remaining = maxBytes - total
      const next = value.byteLength > remaining ? value.slice(0, remaining) : value
      chunks.push(next)
      total += next.byteLength
      if (total - lastReported >= 64 * 1024) {
        lastReported = total
        options?.onProgress?.(total)
      }
      if (total >= maxBytes) break
    }
  } finally {
    await reader.cancel().catch(() => {})
  }
  options?.onProgress?.(total)

  const out = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    out.set(chunk, offset)
    offset += chunk.byteLength
  }
  return out
}

export async function downloadToFile(
  fetchImpl: typeof fetch,
  url: string,
  filePath: string,
  options?: { totalBytes: number | null; onProgress?: ((downloadedBytes: number) => void) | null }
): Promise<number> {
  const res = await fetchImpl(url, {
    redirect: 'follow',
    signal: AbortSignal.timeout(TRANSCRIPTION_TIMEOUT_MS),
  })
  if (!res.ok) {
    throw new Error(`Download failed (${res.status})`)
  }
  const body = res.body
  if (!body) {
    const bytes = new Uint8Array(await res.arrayBuffer())
    await fs.writeFile(filePath, bytes)
    options?.onProgress?.(bytes.byteLength)
    return bytes.byteLength
  }

  const handle = await fs.open(filePath, 'w')
  let downloadedBytes = 0
  let lastReported = 0
  try {
    const reader = body.getReader()
    try {
      while (true) {
        const { value, done } = await reader.read()
        if (done) break
        if (!value) continue
        await handle.write(value)
        downloadedBytes += value.byteLength
        if (downloadedBytes - lastReported >= 128 * 1024) {
          lastReported = downloadedBytes
          options?.onProgress?.(downloadedBytes)
        }
      }
      options?.onProgress?.(downloadedBytes)
    } finally {
      await reader.cancel().catch(() => {})
    }
  } finally {
    await handle.close().catch(() => {})
  }
  return downloadedBytes
}

export function normalizeHeaderType(value: string | null): string | null {
  if (!value) return null
  const trimmed = value.trim()
  if (!trimmed) return null
  return trimmed.split(';')[0]?.trim().toLowerCase() ?? null
}

export function parseContentLength(value: string | null): number | null {
  if (!value) return null
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : null
}

export function filenameFromUrl(url: string): string | null {
  try {
    const parsed = new URL(url)
    const base = parsed.pathname.split('/').pop() ?? ''
    return base.trim().length > 0 ? base : null
  } catch {
    return null
  }
}

export function formatBytes(bytes: number): string {
  const units = ['B', 'KB', 'MB', 'GB']
  let value = bytes
  let idx = 0
  while (value >= 1024 && idx < units.length - 1) {
    value /= 1024
    idx += 1
  }
  const decimals = value >= 10 || idx === 0 ? 0 : 1
  return `${value.toFixed(decimals)}${units[idx]}`
}
