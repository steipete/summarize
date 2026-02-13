import { access, readFile } from 'node:fs/promises'
import { extname } from 'node:path'
import { Readable, Writable } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'

const seen = vi.hoisted(() => ({
  filePath: null as string | null,
  bytes: null as Buffer | null,
}))

vi.mock('../src/run/flows/asset/input.js', () => ({
  isTranscribableExtension: vi.fn(() => false),
  withUrlAsset: vi.fn(async () => false),
  handleFileInput: vi.fn(async (_ctx, inputTarget) => {
    if (inputTarget.kind !== 'file') return false
    seen.filePath = inputTarget.filePath
    seen.bytes = await readFile(inputTarget.filePath)
    return true
  }),
}))

import { runCli } from '../src/run.js'

const noopStream = () =>
  new Writable({
    write(chunk, encoding, callback) {
      void chunk
      void encoding
      callback()
    },
  })

describe('cli stdin binary routing', () => {
  afterEach(() => {
    seen.filePath = null
    seen.bytes = null
  })

  it('routes binary stdin through a temp file without text coercion', async () => {
    const pngBytes = Buffer.from(
      '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c6360000002000100ffff03000006000557bf840000000049454e44ae426082',
      'hex'
    )

    await runCli(['-'], {
      env: { HOME: '/tmp' },
      fetch: vi.fn() as unknown as typeof fetch,
      stdin: Readable.from([pngBytes]),
      stdout: noopStream(),
      stderr: noopStream(),
    })

    expect(seen.filePath).toBeTruthy()
    expect(extname(seen.filePath ?? '')).toBe('.png')
    expect(Buffer.compare(seen.bytes ?? Buffer.alloc(0), pngBytes)).toBe(0)
    await expect(access(seen.filePath ?? '')).rejects.toThrow()
  })
})
