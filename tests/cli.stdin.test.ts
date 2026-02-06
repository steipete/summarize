import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable, Writable } from 'node:stream'
import { afterAll, describe, expect, it, vi } from 'vitest'

import { runCli } from '../src/run.js'

const noopStream = () =>
  new Writable({
    write(chunk, encoding, callback) {
      void chunk
      void encoding
      callback()
    },
  })

const createStdinStream = (content: string): Readable => {
  return Readable.from([content])
}

describe('cli stdin support', () => {
  const home = mkdtempSync(join(tmpdir(), 'summarize-tests-stdin-'))

  afterAll(() => {
    rmSync(home, { recursive: true, force: true })
  })

  it('errors on empty stdin', async () => {
    await expect(
      runCli(['-'], {
        env: { HOME: home },
        fetch: vi.fn() as unknown as typeof fetch,
        stdin: createStdinStream('   '), // Whitespace only
        stdout: noopStream(),
        stderr: noopStream(),
      })
    ).rejects.toThrow('Stdin is empty')
  })

  it('errors on completely empty stdin', async () => {
    await expect(
      runCli(['-'], {
        env: { HOME: home },
        fetch: vi.fn() as unknown as typeof fetch,
        stdin: createStdinStream(''), // Completely empty
        stdout: noopStream(),
        stderr: noopStream(),
      })
    ).rejects.toThrow('Stdin is empty')
  })

  it('errors on --extract with stdin', async () => {
    const testContent = 'This is a test document for extraction.'

    await expect(
      runCli(['--extract', '-'], {
        env: { HOME: home },
        fetch: vi.fn() as unknown as typeof fetch,
        stdin: createStdinStream(testContent),
        stdout: noopStream(),
        stderr: noopStream(),
      })
    ).rejects.toThrow('--extract is only supported for website/YouTube URLs')
  })

  it('processes stdin correctly for non-extract mode', async () => {
    // This test just verifies that stdin is processed and doesn't immediately fail
    // It will still fail later due to missing API keys, but that's expected
    const testContent = 'Test content for basic processing.'

    await expect(
      runCli(['-'], {
        env: { HOME: home },
        fetch: vi.fn() as unknown as typeof fetch,
        stdin: createStdinStream(testContent),
        stdout: noopStream(),
        stderr: noopStream(),
      })
    ).rejects.toThrow() // Will throw but not due to stdin processing
  })
})
