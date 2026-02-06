import { existsSync } from 'node:fs'
import fs from 'node:fs/promises'
import path from 'node:path'
import type { Message } from '@mariozechner/pi-ai'
import { fileTypeFromBuffer } from 'file-type'
import mime from 'mime'

import { userTextAndImageMessage } from '../llm/prompt.js'

export type InputTarget =
  | { kind: 'url'; url: string }
  | { kind: 'file'; filePath: string }
  | { kind: 'stdin' }

export type UrlKind = { kind: 'website' } | { kind: 'asset' }

export type AssetAttachment = {
  mediaType: string
  filename: string | null
  kind: 'image' | 'file'
  bytes: Uint8Array
}

const MAX_ASSET_BYTES_DEFAULT = 50 * 1024 * 1024

function normalizeUrlInput(raw: string): string {
  return (
    raw
      // Common shell copy/paste mistakes: `\?` / `\=` / `\&` inside quotes.
      .replaceAll(/\\([?&=])/g, '$1')
      // Sometimes backslashes get percent-encoded (`%5C`) and end up right before separators.
      .replaceAll(/%5c(?=[?&=])/gi, '')
  )
}

function trimLikelyUrlPunctuation(raw: string): string {
  let value = raw.trim()
  const hasUnbalancedClosing = (input: string, open: string, close: string): boolean => {
    let openCount = 0
    let closeCount = 0
    for (const char of input) {
      if (char === open) openCount += 1
      else if (char === close) closeCount += 1
    }
    return closeCount > openCount
  }
  while (value.length > 0 && /[)\].,;:'">}”’»]/.test(value[value.length - 1] ?? '')) {
    const last = value[value.length - 1] ?? ''
    if (last === ')' && !hasUnbalancedClosing(value, '(', ')')) break
    if (last === ']' && !hasUnbalancedClosing(value, '[', ']')) break
    if (last === '}' && !hasUnbalancedClosing(value, '{', '}')) break
    value = value.slice(0, -1)
  }
  while (value.length > 0 && /^[('"<{[\]“‘«]/.test(value[0] ?? '')) {
    value = value.slice(1)
  }
  return value
}

function extractHttpUrlsFromText(raw: string): string[] {
  return [...raw.matchAll(/https?:\/\/\S+/g)]
    .map((match) => trimLikelyUrlPunctuation(match[0] ?? ''))
    .filter((candidate) => candidate.length > 0)
}

function normalizeHeaderMediaType(value: string | null): string | null {
  if (!value) return null
  const trimmed = value.trim()
  if (!trimmed) return null
  return trimmed.split(';')[0]?.trim().toLowerCase() ?? null
}

function isHtmlMediaType(mediaType: string | null): boolean {
  if (!mediaType) return false
  return mediaType === 'text/html' || mediaType === 'application/xhtml+xml'
}

function isLikelyAssetMediaType(mediaType: string | null): boolean {
  if (!mediaType) return false
  if (isHtmlMediaType(mediaType)) return false
  return true
}

function parseContentDispositionFilename(header: string | null): string | null {
  if (!header) return null
  const match = /filename\*\s*=\s*([^;]+)/i.exec(header) ?? /filename\s*=\s*([^;]+)/i.exec(header)
  if (!match?.[1]) return null
  let value = match[1].trim()
  if (value.toLowerCase().startsWith("utf-8''")) {
    value = value.slice(7)
  }
  value = value.replace(/^"|"$/g, '')
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

function looksLikeHtml(bytes: Uint8Array): boolean {
  const head = new TextDecoder().decode(bytes.slice(0, 256)).trimStart().toLowerCase()
  return head.startsWith('<!doctype html') || head.startsWith('<html') || head.startsWith('<head')
}

function isLikelyAssetPathname(pathname: string): boolean {
  const ext = path.extname(pathname).toLowerCase()
  if (!ext) return false
  if (ext === '.html' || ext === '.htm' || ext === '.php' || ext === '.asp' || ext === '.aspx') {
    return false
  }
  return true
}

export function resolveInputTarget(raw: string): InputTarget {
  const normalized = raw.trim()
  if (!normalized) {
    throw new Error('Missing input')
  }

  const asPath = path.resolve(normalized)
  if (existsSync(asPath)) {
    return { kind: 'file', filePath: asPath }
  }

  if (normalized === '-') {
    return { kind: 'stdin' }
  }

  const extractedUrls = extractHttpUrlsFromText(normalized)
  const extractedLast = extractedUrls.at(-1) ?? null
  if (extractedLast && extractedLast !== normalized) {
    for (let i = extractedUrls.length - 1; i >= 0; i -= 1) {
      const candidate = extractedUrls[i]
      if (!candidate) continue
      try {
        return resolveInputTarget(candidate)
      } catch {
        // keep trying earlier candidates
      }
    }
  }

  let parsed: URL
  const normalizedUrlInput = normalizeUrlInput(normalized)
  try {
    parsed = new URL(normalizedUrlInput)
  } catch {
    throw new Error(`Invalid URL or file path: ${raw}`)
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:' && parsed.protocol !== 'file:') {
    const embedded = normalized.lastIndexOf('https://')
    const embeddedHttp = normalized.lastIndexOf('http://')
    const idx = Math.max(embedded, embeddedHttp)
    if (idx >= 0) {
      const candidate = normalized.slice(idx)
      return resolveInputTarget(candidate)
    }
  }

  if (parsed.protocol === 'file:') {
    const filePath = path.resolve(decodeURIComponent(parsed.pathname))
    return { kind: 'file', filePath }
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('Only HTTP and HTTPS URLs can be summarized')
  }
  // Preserve user input (do not canonicalize like adding trailing slashes),
  // but apply our minimal normalization fixes (e.g. `\\?` -> `?`).
  return { kind: 'url', url: normalizedUrlInput }
}

export async function classifyUrl({
  url,
  fetchImpl,
  timeoutMs,
}: {
  url: string
  fetchImpl: typeof fetch
  timeoutMs: number
}): Promise<UrlKind> {
  const parsed = new URL(url)
  if (isLikelyAssetPathname(parsed.pathname)) {
    return { kind: 'asset' }
  }

  const tryDetectFromHead = async (): Promise<boolean> => {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const res = await fetchImpl(url, { method: 'HEAD', signal: controller.signal })
      if (!res.ok) return false
      const mediaType = normalizeHeaderMediaType(res.headers.get('content-type'))
      if (isLikelyAssetMediaType(mediaType)) return true
      const filename = parseContentDispositionFilename(res.headers.get('content-disposition'))
      if (filename && isLikelyAssetPathname(filename)) return true
      return false
    } catch {
      return false
    } finally {
      clearTimeout(timeout)
    }
  }

  const tryDetectFromRange = async (): Promise<boolean> => {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const res = await fetchImpl(url, {
        method: 'GET',
        headers: { Range: 'bytes=0-2047' },
        signal: controller.signal,
      })
      if (!res.ok) return false
      const mediaType = normalizeHeaderMediaType(res.headers.get('content-type'))
      if (isLikelyAssetMediaType(mediaType)) return true
      const buffer = new Uint8Array(await res.arrayBuffer())
      return !looksLikeHtml(buffer)
    } catch {
      return false
    } finally {
      clearTimeout(timeout)
    }
  }

  if (await tryDetectFromHead()) return { kind: 'asset' }
  if (await tryDetectFromRange()) return { kind: 'asset' }
  return { kind: 'website' }
}

async function detectMediaType({
  bytes,
  headerContentType,
  nameHint,
}: {
  bytes: Uint8Array
  headerContentType: string | null
  nameHint: string | null
}): Promise<string> {
  const sniffed = await fileTypeFromBuffer(bytes)
  if (sniffed?.mime) return sniffed.mime

  const header = normalizeHeaderMediaType(headerContentType)
  if (header && header !== 'application/octet-stream') return header

  if (nameHint) {
    const byExt = mime.getType(nameHint)
    if (typeof byExt === 'string' && byExt.length > 0) return byExt
  }

  return 'application/octet-stream'
}

function buildAttachment({
  bytes,
  mediaType,
  filename,
}: {
  bytes: Uint8Array
  mediaType: string
  filename: string | null
}): AssetAttachment {
  if (mediaType.startsWith('image/')) {
    return { mediaType, filename, kind: 'image', bytes }
  }

  return { mediaType, filename, kind: 'file', bytes }
}

export async function loadLocalAsset({
  filePath,
  maxBytes = MAX_ASSET_BYTES_DEFAULT,
}: {
  filePath: string
  maxBytes?: number
}): Promise<{ sourceLabel: string; attachment: AssetAttachment }> {
  const stat = await fs.stat(filePath)
  if (!stat.isFile()) {
    throw new Error(`Not a file: ${filePath}`)
  }
  if (stat.size > maxBytes) {
    throw new Error(`File too large (${stat.size} bytes). Limit is ${maxBytes} bytes.`)
  }

  const bytes = new Uint8Array(await fs.readFile(filePath))
  const filename = path.basename(filePath)
  const mediaType = await detectMediaType({ bytes, headerContentType: null, nameHint: filename })
  return {
    sourceLabel: filePath,
    attachment: buildAttachment({ bytes, mediaType, filename }),
  }
}

export async function loadRemoteAsset({
  url,
  fetchImpl,
  timeoutMs,
  maxBytes = MAX_ASSET_BYTES_DEFAULT,
}: {
  url: string
  fetchImpl: typeof fetch
  timeoutMs: number
  maxBytes?: number
}): Promise<{ sourceLabel: string; attachment: AssetAttachment }> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetchImpl(url, { signal: controller.signal })
    if (!res.ok) {
      throw new Error(`Download failed: ${res.status} ${res.statusText}`)
    }

    const contentLength = res.headers.get('content-length')
    if (contentLength) {
      const parsed = Number(contentLength)
      if (Number.isFinite(parsed) && parsed > maxBytes) {
        throw new Error(`Remote file too large (${parsed} bytes). Limit is ${maxBytes} bytes.`)
      }
    }

    const arrayBuffer = await res.arrayBuffer()
    if (arrayBuffer.byteLength > maxBytes) {
      throw new Error(
        `Remote file too large (${arrayBuffer.byteLength} bytes). Limit is ${maxBytes} bytes.`
      )
    }

    const bytes = new Uint8Array(arrayBuffer)
    const parsedUrl = new URL(url)
    const filename = path.basename(parsedUrl.pathname) || null
    const headerContentType = res.headers.get('content-type')
    const mediaType = await detectMediaType({ bytes, headerContentType, nameHint: filename })

    if (isHtmlMediaType(mediaType) || looksLikeHtml(bytes)) {
      throw new Error('URL appears to be a website (HTML), not a file')
    }

    return {
      sourceLabel: url,
      attachment: buildAttachment({ bytes, mediaType, filename }),
    }
  } finally {
    clearTimeout(timeout)
  }
}

export function buildAssetPromptMessages({
  promptText,
  attachment,
}: {
  promptText: string
  attachment: AssetAttachment
}): Array<Message> {
  if (attachment.kind !== 'image') {
    throw new Error(
      `Internal error: tried to build model messages for non-image attachment (${attachment.mediaType}).`
    )
  }

  return [
    userTextAndImageMessage({
      text: promptText,
      imageBytes: attachment.bytes,
      mimeType: attachment.mediaType,
    }),
  ]
}
