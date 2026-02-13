import { access, readFile } from 'node:fs/promises'
import path from 'node:path'
import { Readable } from 'node:stream'
import { describe, expect, it } from 'vitest'

import { createTempFileFromStdin } from '../src/run/stdin-temp-file.js'

const streamFrom = (...chunks: Array<string | Uint8Array | Buffer>) => Readable.from(chunks)

describe('createTempFileFromStdin', () => {
  it('writes UTF-8 text stdin to a .txt temp file', async () => {
    const temp = await createTempFileFromStdin({
      stream: streamFrom('hello from stdin\n'),
    })
    try {
      expect(temp.kind).toBe('text')
      expect(path.extname(temp.filePath)).toBe('.txt')
      await expect(readFile(temp.filePath, 'utf8')).resolves.toBe('hello from stdin\n')
    } finally {
      await temp.cleanup()
    }
  })

  it('rejects whitespace-only text stdin', async () => {
    await expect(
      createTempFileFromStdin({
        stream: streamFrom('   \n\t  '),
      })
    ).rejects.toThrow('Stdin is empty')
  })

  it('detects binary stdin and preserves bytes', async () => {
    const pngBytes = Buffer.from(
      '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c6360000002000100ffff03000006000557bf840000000049454e44ae426082',
      'hex'
    )
    const temp = await createTempFileFromStdin({
      stream: streamFrom(pngBytes),
    })
    try {
      expect(temp.kind).toBe('binary')
      expect(path.extname(temp.filePath)).toBe('.png')
      const stored = await readFile(temp.filePath)
      expect(Buffer.compare(stored, pngBytes)).toBe(0)
    } finally {
      await temp.cleanup()
    }
  })

  it('falls back to .bin when binary type is unknown', async () => {
    const unknownBinary = Buffer.from([0x00, 0xff, 0x10, 0x80, 0x42, 0x00])
    const temp = await createTempFileFromStdin({
      stream: streamFrom(unknownBinary),
    })
    try {
      expect(temp.kind).toBe('binary')
      expect(path.extname(temp.filePath)).toBe('.bin')
    } finally {
      await temp.cleanup()
    }
  })

  it('rejects oversized stdin streams', async () => {
    await expect(
      createTempFileFromStdin({
        stream: streamFrom(Buffer.alloc(4), Buffer.alloc(4)),
        maxBytes: 7,
      })
    ).rejects.toThrow(/Stdin content exceeds maximum size/)
  })

  it('cleans up the temp directory', async () => {
    const temp = await createTempFileFromStdin({
      stream: streamFrom('cleanup me'),
    })
    const filePath = temp.filePath
    await temp.cleanup()
    await expect(access(filePath)).rejects.toThrow()
  })
})
