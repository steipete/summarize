import { Writable } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'

import { runCli } from '../src/run.js'

describe('--verbose', () => {
  it('prints progress and extraction diagnostics to stderr', async () => {
    const html =
      '<!doctype html><html><head><title>Hello</title></head>' +
      '<body><article><p>Some article content.</p></article></body></html>'

    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.url
      if (url === 'https://example.com') {
        return new Response(html, { status: 200, headers: { 'Content-Type': 'text/html' } })
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

    const stdout = new Writable({
      write(chunk, encoding, callback) {
        void chunk
        void encoding
        callback()
      },
    })

    await runCli(
      [
        '--json',
        '--verbose',
        '--extract',
        '--firecrawl',
        'off',
        '--timeout',
        '10s',
        'https://example.com',
      ],
      {
        env: {},
        fetch: fetchMock as unknown as typeof fetch,
        stdout,
        stderr,
      }
    )

    expect(stderrText).toContain('[summarize] config url=https://example.com')
    expect(stderrText).toContain('[summarize] extract start')
    expect(stderrText).toContain('[summarize] extract done strategy=html')
    expect(stderrText).toContain('transcriptSource=none')
    expect(stderrText).toContain('extract firecrawl attempted=false used=false')
    expect(stderrText).toContain('extract transcript textProvided=false')
  })

  it('uses ANSI colors when stderr is a rich TTY', async () => {
    const html =
      '<!doctype html><html><head><title>Hello</title></head>' +
      '<body><article><p>Some article content.</p></article></body></html>'

    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.url
      if (url === 'https://example.com') {
        return new Response(html, { status: 200, headers: { 'Content-Type': 'text/html' } })
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
    ;(stderr as unknown as { isTTY?: boolean }).isTTY = true

    const stdout = new Writable({
      write(chunk, encoding, callback) {
        void chunk
        void encoding
        callback()
      },
    })

    await runCli(
      ['--json', '--verbose', '--extract', '--firecrawl', 'off', 'https://example.com'],
      {
        env: { TERM: 'xterm-256color' },
        fetch: fetchMock as unknown as typeof fetch,
        stdout,
        stderr,
      }
    )

    expect(stderrText).toContain('\u001b[')
  })
})

describe('--debug', () => {
  it('acts like --verbose', async () => {
    const html =
      '<!doctype html><html><head><title>Hello</title></head>' +
      '<body><article><p>Some article content.</p></article></body></html>'

    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.url
      if (url === 'https://example.com') {
        return new Response(html, { status: 200, headers: { 'Content-Type': 'text/html' } })
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

    const stdout = new Writable({
      write(chunk, encoding, callback) {
        void chunk
        void encoding
        callback()
      },
    })

    await runCli(
      [
        '--json',
        '--debug',
        '--extract',
        '--firecrawl',
        'off',
        '--timeout',
        '10s',
        'https://example.com',
      ],
      {
        env: {},
        fetch: fetchMock as unknown as typeof fetch,
        stdout,
        stderr,
      }
    )

    expect(stderrText).toContain('[summarize] config url=https://example.com')
    expect(stderrText).toContain('[summarize] extract start')
  })
})
