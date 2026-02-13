import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileTypeFromBuffer } from 'file-type'

const DEFAULT_STDIN_MAX_BYTES = 50 * 1024 * 1024

function toBufferChunk(chunk: unknown): Buffer {
  if (Buffer.isBuffer(chunk)) return chunk
  if (chunk instanceof ArrayBuffer) return Buffer.from(chunk)
  if (chunk instanceof Uint8Array) return Buffer.from(chunk)
  if (typeof chunk === 'string') return Buffer.from(chunk)
  throw new Error(`Unsupported stdin chunk type: ${typeof chunk}`)
}

async function readStreamToBuffer(
  stream: NodeJS.ReadableStream,
  maxBytes: number
): Promise<Buffer> {
  const chunks: Buffer[] = []
  let totalSize = 0
  for await (const chunk of stream) {
    const buffer = toBufferChunk(chunk)
    totalSize += buffer.length
    if (totalSize > maxBytes) {
      throw new Error(
        `Stdin content exceeds maximum size of ${(maxBytes / 1024 / 1024).toFixed(1)}MB`
      )
    }
    chunks.push(buffer)
  }
  return Buffer.concat(chunks)
}

function decodeUtf8Text(bytes: Buffer): string | null {
  if (bytes.includes(0x00)) return null
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    return null
  }
}

async function resolveStdinExtensionAndKind(
  bytes: Buffer
): Promise<{ extension: string; kind: 'text' | 'binary'; decodedText: string | null }> {
  const sniffed = await fileTypeFromBuffer(bytes)
  if (sniffed?.ext) {
    return { extension: `.${sniffed.ext}`, kind: 'binary', decodedText: null }
  }
  const decodedText = decodeUtf8Text(bytes)
  if (decodedText !== null) {
    return { extension: '.txt', kind: 'text', decodedText }
  }
  return { extension: '.bin', kind: 'binary', decodedText: null }
}

export type StdinTempFile = {
  filePath: string
  kind: 'text' | 'binary'
  cleanup: () => Promise<void>
}

export async function createTempFileFromStdin({
  stream,
  maxBytes = DEFAULT_STDIN_MAX_BYTES,
}: {
  stream: NodeJS.ReadableStream
  maxBytes?: number
}): Promise<StdinTempFile> {
  const bytes = await readStreamToBuffer(stream, maxBytes)
  if (bytes.length === 0) {
    throw new Error('Stdin is empty')
  }

  const { extension, kind, decodedText } = await resolveStdinExtensionAndKind(bytes)
  if (kind === 'text' && !decodedText?.trim()) {
    throw new Error('Stdin is empty')
  }

  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'summarize-stdin-'))
  const filePath = path.join(tempDir, `input${extension}`)
  const cleanup = async () => {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {})
  }

  try {
    await fs.writeFile(filePath, bytes, {
      mode: 0o600,
      flag: 'wx',
    })
  } catch (error) {
    await cleanup()
    throw error
  }

  return { filePath, kind, cleanup }
}
