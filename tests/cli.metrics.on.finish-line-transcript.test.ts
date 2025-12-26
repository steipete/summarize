import { Writable } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'

import { runCli } from '../src/run.js'

const mocks = vi.hoisted(() => ({
  resolveTranscriptForLink: vi.fn(async () => ({
    text: 'Hello world\nSecond line',
    source: 'youtube',
    metadata: { durationSeconds: 44 },
    diagnostics: {
      cacheMode: 'default',
      cacheStatus: 'miss',
      textProvided: true,
      provider: 'youtube',
      attemptedProviders: ['youtube'],
      notes: null,
    },
  })),
}))

vi.mock('../packages/core/src/content/link-preview/transcript/index.js', () => ({
  resolveTranscriptForLink: mocks.resolveTranscriptForLink,
}))

describe('--metrics on', () => {
  it('prints transcript length on the finish line (no noisy calls=1)', async () => {
    const youtubeUrl = 'https://www.youtube.com/watch?v=EYSQGkpuzAA&t=69s'
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.url
      if (url === youtubeUrl) {
        return new Response(
          '<!doctype html><html><head>' +
            '<title>Video</title>' +
            '<meta property="og:site_name" content="YouTube" />' +
            '</head><body>ok</body></html>',
          { status: 200, headers: { 'Content-Type': 'text/html' } }
        )
      }
      throw new Error(`Unexpected fetch call: ${url}`)
    })

    let stderrText = ''
    const stderr = new Writable({
      write(chunk, _encoding, callback) {
        stderrText += chunk.toString()
        callback()
      },
    })

    await runCli(['--extract', '--metrics', 'on', '--timeout', '2s', youtubeUrl], {
      env: {},
      fetch: fetchMock as unknown as typeof fetch,
      stdout: new Writable({
        write(_chunk, _encoding, callback) {
          callback()
        },
      }),
      stderr,
    })

    expect(stderrText).toMatch(/\b44s video · \d+ words\b/)
    expect(stderrText).toMatch(/\bwords\b/)
    expect(stderrText).not.toContain('calls=')
    expect(stderrText).not.toContain('input=')
  })
})
