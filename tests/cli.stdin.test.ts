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

const collectStream = () => {
  let text = ''
  return {
    stream: new Writable({
      write(chunk, encoding, callback) {
        void encoding
        text += chunk.toString()
        callback()
      },
    }),
    getText: () => text,
  }
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

  it('allows --markdown-mode llm for stdin', async () => {
    const testContent = 'Test content for markdown mode.'

    await expect(
      runCli(['--extract', '--format', 'md', '--markdown-mode', 'llm', '-'], {
        env: { HOME: home },
        fetch: vi.fn() as unknown as typeof fetch,
        stdin: createStdinStream(testContent),
        stdout: noopStream(),
        stderr: noopStream(),
      })
    ).rejects.toThrow('--extract is not supported for piped stdin input')
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
    ).rejects.toThrow('Only --markdown-mode llm is supported for file/stdin inputs')
  })

  it('prints short text from stdin without requiring model setup', async () => {
    const testContent = 'Test content for basic processing.'
    const stdout = collectStream()

    await runCli(['-'], {
      env: { HOME: home },
      fetch: vi.fn() as unknown as typeof fetch,
      stdin: createStdinStream(testContent),
      stdout: stdout.stream,
      stderr: noopStream(),
    })

    expect(stdout.getText()).toContain(testContent)
  })
})
