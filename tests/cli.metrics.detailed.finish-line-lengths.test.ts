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

vi.mock('../packages/core/src/content/transcript/index.js', () => ({
  resolveTranscriptForLink: mocks.resolveTranscriptForLink,
}))

describe('--metrics detailed', () => {
  it('adds YouTube transcript length stats to the finish line (best effort)', async () => {
    mocks.resolveTranscriptForLink.mockResolvedValueOnce({
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
    })

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

    await runCli(['--extract', '--metrics', 'detailed', '--timeout', '2s', youtubeUrl], {
      env: {},
      fetch: fetchMock as unknown as typeof fetch,
      stdout: new Writable({
        write(_chunk, _encoding, callback) {
          callback()
        },
      }),
      stderr,
    })

    expect(stderrText).toMatch(/\btranscript=/)
    expect(stderrText).toMatch(/\btranscript=44s\b/)
    expect(stderrText).toMatch(/\btranscript=.*\bwords\b/)
    expect(stderrText).toMatch(/\b44s video · \d+ words\b/)
    expect(stderrText).toMatch(/\btx=/)
  })

  it('includes Whisper/OpenAI transcription cost in total cost output', async () => {
    mocks.resolveTranscriptForLink.mockResolvedValueOnce({
      text: 'Hello world\nSecond line',
      source: 'whisper',
      metadata: { durationSeconds: 60, transcriptionProvider: 'openai' },
      diagnostics: {
        cacheMode: 'default',
        cacheStatus: 'miss',
        textProvided: true,
        provider: 'whisper',
        attemptedProviders: ['whisper'],
        notes: null,
      },
    })

    const url = 'https://example.com/video'
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const resolved = typeof input === 'string' ? input : input.url
      if (resolved === url) {
        return new Response(
          '<!doctype html><html><head>' +
            '<title>Video</title>' +
            '<meta property="og:site_name" content="Example" />' +
            '</head><body>ok</body></html>',
          { status: 200, headers: { 'Content-Type': 'text/html' } }
        )
      }
      throw new Error(`Unexpected fetch call: ${resolved}`)
    })

    let stderrText = ''
    const stderr = new Writable({
      write(chunk, _encoding, callback) {
        stderrText += chunk.toString()
        callback()
      },
    })

    await runCli(
      ['--extract', '--format', 'text', '--metrics', 'detailed', '--timeout', '2s', url],
      {
        env: { OPENAI_API_KEY: 'test' },
        fetch: fetchMock as unknown as typeof fetch,
        stdout: new Writable({
          write(_chunk, _encoding, callback) {
            callback()
          },
        }),
        stderr,
      }
    )

    expect(stderrText).toContain('$0.0060')
    expect(stderrText).toContain('txcost=$0.0060')
  })
})
