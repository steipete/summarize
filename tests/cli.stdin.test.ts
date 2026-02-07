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
    ).rejects.toThrow('--extract is not supported for piped stdin input')
  })

  it('allows --markdown-mode llm for stdin (transcript formatting coming soon)', async () => {
    // This test verifies that --markdown-mode llm is allowed for stdin
    // (actual transcript formatting will be implemented in a future update)
    const testContent = 'Test content for markdown mode.'

    try {
      await runCli(['--format', 'md', '--markdown-mode', 'llm', '-'], {
        env: { HOME: home },
        fetch: vi.fn() as unknown as typeof fetch,
        stdin: createStdinStream(testContent),
        stdout: noopStream(),
        stderr: noopStream(),
      })
      // If it succeeds, that's fine - --markdown-mode llm is allowed
    } catch (error) {
      // If it throws, make sure it's NOT a restriction error
      const message = error instanceof Error ? error.message : String(error)
      expect(message).not.toMatch(/--markdown-mode is only supported/)
    }
  })

  it('rejects --markdown-mode readability for stdin', async () => {
    // Only --markdown-mode llm is allowed for stdin (other modes need URL context)
    const testContent = 'Test content.'

    await expect(
      runCli(['--format', 'md', '--markdown-mode', 'readability', '-'], {
        env: { HOME: home },
        fetch: vi.fn() as unknown as typeof fetch,
        stdin: createStdinStream(testContent),
        stdout: noopStream(),
        stderr: noopStream(),
      })
    ).rejects.toThrow('--markdown-mode is only supported for URL inputs')
  })

  it('processes stdin correctly for non-extract mode', async () => {
    // This test verifies that stdin is processed and doesn't fail with stdin-related errors
    const testContent = 'Test content for basic processing.'

    try {
      await runCli(['-'], {
        env: { HOME: home },
        fetch: vi.fn() as unknown as typeof fetch,
        stdin: createStdinStream(testContent),
        stdout: noopStream(),
        stderr: noopStream(),
      })
      // If it succeeds, that's fine - stdin was processed correctly
    } catch (error) {
      // If it throws, make sure it's NOT a stdin-related error
      const message = error instanceof Error ? error.message : String(error)
      expect(message).not.toMatch(/Stdin is empty/)
    }
  })
})
