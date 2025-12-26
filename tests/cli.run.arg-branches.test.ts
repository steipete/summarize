import { Writable } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'

import { runCli } from '../src/run.js'

const htmlResponse = (html: string, status = 200) =>
  new Response(html, {
    status,
    headers: { 'Content-Type': 'text/html' },
  })

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

describe('cli run.ts arg parsing branches', () => {
  it('prints help and exits', async () => {
    const stdout = collectStream()
    const stderr = collectStream()
    await runCli(['--help'], {
      env: {},
      fetch: vi.fn() as unknown as typeof fetch,
      stdout: stdout.stream,
      stderr: stderr.stream,
    })
    expect(stdout.getText() + stderr.getText()).toContain('Usage:')
  })

  it('prints version and exits', async () => {
    const stdout = collectStream()
    const stderr = collectStream()
    await runCli(['--version'], {
      env: {},
      fetch: vi.fn() as unknown as typeof fetch,
      stdout: stdout.stream,
      stderr: stderr.stream,
    })
    expect(stdout.getText().trim()).toMatch(/^\d+\.\d+\.\d+/)
    expect(stderr.getText()).toBe('')
  })

  it('treats --cli <url> as input when no explicit input arg is provided', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.url
      if (url === 'https://example.com') {
        return htmlResponse(
          '<!doctype html><html><body><article><p>Hello from site</p></article></body></html>'
        )
      }
      throw new Error(`Unexpected fetch call: ${url}`)
    })

    const stdout = collectStream()
    const stderr = collectStream()
    await runCli(['--cli', 'https://example.com', '--extract', '--timeout', '2s'], {
      env: {},
      fetch: fetchMock as unknown as typeof fetch,
      stdout: stdout.stream,
      stderr: stderr.stream,
    })

    expect(fetchMock).toHaveBeenCalled()
    expect(stdout.getText()).toContain('Transcript:')
  })

  it('errors when input is missing', async () => {
    const stdout = collectStream()
    const stderr = collectStream()
    await expect(
      runCli(['--extract', '--timeout', '2s'], {
        env: {},
        fetch: vi.fn() as unknown as typeof fetch,
        stdout: stdout.stream,
        stderr: stderr.stream,
      })
    ).rejects.toThrow(/Usage: summarize <url-or-file>/)
  })

  it('--debug defaults --metrics to detailed', async () => {
    const youtubeUrl = 'https://www.youtube.com/watch?v=EYSQGkpuzAA&t=69s'
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.url
      if (url === youtubeUrl) {
        return htmlResponse(
          '<!doctype html><html><head>' +
            '<title>Video</title>' +
            '<meta property="og:site_name" content="YouTube" />' +
            '</head><body>ok</body></html>'
        )
      }
      throw new Error(`Unexpected fetch call: ${url}`)
    })

    const stdout = collectStream()
    const stderr = collectStream()
    await runCli(['--debug', '--extract', '--timeout', '2s', youtubeUrl], {
      env: {},
      fetch: fetchMock as unknown as typeof fetch,
      stdout: stdout.stream,
      stderr: stderr.stream,
    })

    expect(stderr.getText()).toMatch(/\btranscript=44s\b/)
  })
})
