import { promises as fs } from 'node:fs'

export function wrapError(prefix: string, error: unknown): Error {
  if (error instanceof Error) {
    return new Error(`${prefix}: ${error.message}`, { cause: error })
  }
  return new Error(`${prefix}: ${String(error)}`)
}

export function toArrayBuffer(view: Uint8Array): ArrayBuffer {
  const buffer = view.buffer as ArrayBuffer
  return buffer.slice(view.byteOffset, view.byteOffset + view.byteLength)
}

export function ensureWhisperFilenameExtension(name: string, mediaType: string): string {
  const trimmed = name.trim()
  const base = trimmed.length > 0 ? trimmed : 'media'
  const hasExtension = (() => {
    const dot = base.lastIndexOf('.')
    if (dot <= 0) return false
    if (dot === base.length - 1) return false
    return true
  })()
  if (hasExtension) return base

  const type = mediaType.toLowerCase().split(';')[0]?.trim() ?? ''
  const ext =
    type === 'audio/mpeg' || type === 'audio/mp3' || type === 'audio/mpga'
      ? 'mp3'
      : type === 'video/mp4' || type === 'audio/mp4' || type === 'application/mp4'
        ? 'mp4'
        : type === 'audio/x-wav' || type === 'audio/wav'
          ? 'wav'
          : type === 'audio/flac'
            ? 'flac'
            : type === 'audio/webm' || type === 'video/webm'
              ? 'webm'
              : type === 'audio/ogg' || type === 'audio/oga' || type === 'application/ogg'
                ? 'ogg'
                : 'mp3'

  return `${base}.${ext}`
}

export async function readFirstBytes(filePath: string, maxBytes: number): Promise<Uint8Array> {
  const handle = await fs.open(filePath, 'r')
  try {
    const buffer = Buffer.allocUnsafe(maxBytes)
    const read = await handle.read(buffer, 0, maxBytes, 0)
    return new Uint8Array(buffer.slice(0, read.bytesRead))
  } finally {
    await handle.close().catch(() => {})
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
