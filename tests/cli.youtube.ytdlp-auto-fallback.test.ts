import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Writable } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'

import { runCli } from '../src/run.js'

vi.mock('../packages/core/src/content/link-preview/transcript/providers/youtube/yt-dlp.js', () => ({
  fetchTranscriptWithYtDlp: vi.fn(async () => {
    return { text: 'hello from ytdlp', provider: 'cpp', error: null, notes: [] }
  }),
}))

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

describe('cli YouTube auto transcript yt-dlp fallback', () => {
  it('falls back to yt-dlp when captions are unavailable', async () => {
    const root = mkdtempSync(join(tmpdir(), 'summarize-ytdlp-fallback-'))
    const binDir = join(root, 'bin')
    mkdirSync(binDir, { recursive: true })

    const fakeYtDlp = join(binDir, 'yt-dlp')
    writeFileSync(fakeYtDlp, '#!/bin/sh\nexit 0\n', 'utf8')
    chmodSync(fakeYtDlp, 0o755)

    const url = 'https://www.youtube.com/watch?v=oYU2hAbx_Fc'
    const html =
      '<!doctype html><html><head><title>Ok</title></head><body>' +
      '<script>var ytInitialPlayerResponse = {"videoDetails":{"shortDescription":"I do."},"playabilityStatus":{"status":"OK"}};</script>' +
      '</body></html>'

    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const requestUrl = typeof input === 'string' ? input : input.url
      if (requestUrl === url) {
        return new Response(html, { status: 200, headers: { 'Content-Type': 'text/html' } })
      }
      throw new Error(`Unexpected fetch call: ${requestUrl}`)
    })

    const stdout = collectStream()
    const stderr = collectStream()

    await runCli(['--extract', '--json', '--timeout', '2s', url], {
      env: {
        HOME: root,
        PATH: binDir,
        OPENAI_API_KEY: 'test',
      },
      fetch: fetchMock as unknown as typeof fetch,
      stdout: stdout.stream,
      stderr: stderr.stream,
    })

    const payload = JSON.parse(stdout.getText()) as {
      extracted: {
        transcriptSource: string | null
        diagnostics: { transcript: { attemptedProviders: string[]; provider: string | null } }
        content: string
      }
    }

    expect(payload.extracted.transcriptSource).toBe('yt-dlp')
    expect(payload.extracted.diagnostics.transcript.provider).toBe('yt-dlp')
    expect(payload.extracted.diagnostics.transcript.attemptedProviders).toContain('yt-dlp')
    expect(payload.extracted.content).toContain('hello from ytdlp')
  })
})
