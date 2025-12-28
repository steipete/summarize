import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Writable } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'

import { runCli } from '../src/run.js'

function collectStream() {
  let text = ''
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      text += chunk.toString()
      callback()
    },
  })
  return { stream, getText: () => text }
}

function noopStream(): Writable {
  return new Writable({
    write(_chunk, _encoding, callback) {
      callback()
    },
  })
}

describe('twitter subcommand', () => {
  it('shows help with twitter --help', async () => {
    const root = mkdtempSync(join(tmpdir(), 'summarize-twitter-'))
    const stdout = collectStream()

    await runCli(['twitter', '--help'], {
      env: { HOME: root },
      fetch: globalThis.fetch,
      stdout: stdout.stream,
      stderr: noopStream(),
    })

    const output = stdout.getText()
    expect(output).toContain('--user')
    expect(output).toContain('--since')
    expect(output).toContain('--until')
    expect(output).toContain('--extract')
    expect(output).toContain('bird CLI')
  })

  it('shows help with help twitter', async () => {
    const root = mkdtempSync(join(tmpdir(), 'summarize-twitter-'))
    const stdout = collectStream()

    await runCli(['help', 'twitter'], {
      env: { HOME: root },
      fetch: globalThis.fetch,
      stdout: stdout.stream,
      stderr: noopStream(),
    })

    const output = stdout.getText()
    expect(output).toContain('--user')
    expect(output).toContain('YYYY-MM-DD')
  })

  it('requires --user flag', async () => {
    const root = mkdtempSync(join(tmpdir(), 'summarize-twitter-'))

    await expect(
      runCli(['twitter', '--since', '2025-01-01'], {
        env: { HOME: root },
        fetch: globalThis.fetch,
        stdout: noopStream(),
        stderr: noopStream(),
      })
    ).rejects.toThrow(/--user is required/i)
  })

  it('validates --since date format', async () => {
    const root = mkdtempSync(join(tmpdir(), 'summarize-twitter-'))

    await expect(
      runCli(['twitter', '--user', 'testuser', '--since', 'invalid-date'], {
        env: { HOME: root },
        fetch: globalThis.fetch,
        stdout: noopStream(),
        stderr: noopStream(),
      })
    ).rejects.toThrow(/--since must be in YYYY-MM-DD format/i)
  })

  it('validates --until date format', async () => {
    const root = mkdtempSync(join(tmpdir(), 'summarize-twitter-'))

    await expect(
      runCli(['twitter', '--user', 'testuser', '--until', '01-01-2025'], {
        env: { HOME: root },
        fetch: globalThis.fetch,
        stdout: noopStream(),
        stderr: noopStream(),
      })
    ).rejects.toThrow(/--until must be in YYYY-MM-DD format/i)
  })

  it('validates --count must be positive', async () => {
    const root = mkdtempSync(join(tmpdir(), 'summarize-twitter-'))

    await expect(
      runCli(['twitter', '--user', 'testuser', '-n', '0'], {
        env: { HOME: root },
        fetch: globalThis.fetch,
        stdout: noopStream(),
        stderr: noopStream(),
      })
    ).rejects.toThrow(/--count must be a positive number/i)
  })

  it('validates --count cannot exceed 100 without multi-day date range', async () => {
    const root = mkdtempSync(join(tmpdir(), 'summarize-twitter-'))

    await expect(
      runCli(['twitter', '--user', 'testuser', '-n', '101'], {
        env: { HOME: root },
        fetch: globalThis.fetch,
        stdout: noopStream(),
        stderr: noopStream(),
      })
    ).rejects.toThrow(/--count cannot exceed 100 without a multi-day date range/i)
  })

  it('handles bird CLI not found error', async () => {
    const root = mkdtempSync(join(tmpdir(), 'summarize-twitter-'))

    // Without BIRD_PATH and without bird in PATH, this should fail
    await expect(
      runCli(['twitter', '--user', 'testuser', '--since', '2025-01-01', '--extract'], {
        env: { HOME: root, PATH: '' },
        fetch: globalThis.fetch,
        stdout: noopStream(),
        stderr: noopStream(),
      })
    ).rejects.toThrow(/bird CLI not found/i)
  })

  it('normalizes username with @ prefix', async () => {
    const root = mkdtempSync(join(tmpdir(), 'summarize-twitter-'))

    // This will fail because bird is not installed, but it validates that
    // the @ prefix is handled (no error about invalid username)
    await expect(
      runCli(['twitter', '--user', '@testuser', '--since', '2025-01-01', '--extract'], {
        env: { HOME: root, PATH: '' },
        fetch: globalThis.fetch,
        stdout: noopStream(),
        stderr: noopStream(),
      })
    ).rejects.toThrow(/bird CLI not found/i)
  })
})
