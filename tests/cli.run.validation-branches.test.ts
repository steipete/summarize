import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Writable } from 'node:stream'
import { describe, expect, it } from 'vitest'

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

describe('cli run.ts validation branches', () => {
  it('rejects --markdown-mode without --format md', async () => {
    const stdout = collectStream()
    const stderr = collectStream()
    await expect(
      runCli(['--markdown-mode', 'llm', '--timeout', '2s', 'https://example.com'], {
        env: {},
        fetch: (() => {
          throw new Error('unexpected fetch')
        }) as unknown as typeof fetch,
        stdout: stdout.stream,
        stderr: stderr.stream,
      })
    ).rejects.toThrow(/--markdown-mode is only supported with --format md/)
  })

  it('rejects --extract for non-media local files', async () => {
    const root = mkdtempSync(join(tmpdir(), 'summarize-extract-file-'))
    const filePath = join(root, 'input.txt')
    writeFileSync(filePath, 'hello', 'utf8')

    const stdout = collectStream()
    const stderr = collectStream()
    await expect(
      runCli(['--extract', '--timeout', '2s', filePath], {
        env: {},
        fetch: (() => {
          throw new Error('unexpected fetch')
        }) as unknown as typeof fetch,
        stdout: stdout.stream,
        stderr: stderr.stream,
      })
    ).rejects.toThrow(/--extract for local files is only supported for media files/)
  })

  it('allows --extract for local media files and reaches media transcription path', async () => {
    const root = mkdtempSync(join(tmpdir(), 'summarize-extract-media-'))
    const filePath = join(root, 'episode.mp3')
    writeFileSync(filePath, 'not-real-audio', 'utf8')

    const stdout = collectStream()
    const stderr = collectStream()
    await expect(
      runCli(['--extract', '--timeout', '2s', filePath], {
        env: {},
        fetch: (() => {
          throw new Error('unexpected fetch')
        }) as unknown as typeof fetch,
        stdout: stdout.stream,
        stderr: stderr.stream,
      })
    ).rejects.toThrow(/Media file transcription requires one of the following/)
  })

  it('rejects unsupported --cli values', async () => {
    const stdout = collectStream()
    const stderr = collectStream()
    await expect(
      runCli(['--cli', 'nope', '--timeout', '2s', 'https://example.com'], {
        env: {},
        fetch: (() => {
          throw new Error('unexpected fetch')
        }) as unknown as typeof fetch,
        stdout: stdout.stream,
        stderr: stderr.stream,
      })
    ).rejects.toThrow(/Unsupported --cli/)
  })
})
