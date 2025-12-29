import { Writable } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'

import { runCli } from '../src/run.js'

describe('cli --extract', () => {
  it('prints full extracted content (no truncation) and never calls OpenAI', async () => {
    const body = 'A'.repeat(60_000)
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.url
      void init
      if (url === 'https://api.openai.com/v1/chat/completions') {
        throw new Error('Unexpected OpenAI call in --extract mode')
      }
      if (url === 'https://api.firecrawl.dev/v1/scrape') {
        return new Response(
          JSON.stringify({ success: true, data: { markdown: `# Example\n\n${body}`, html: null } }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        )
      }
      if (url === 'https://example.com') {
        const html =
          '<!doctype html><html><head><title>Example</title></head>' +
          `<body><article>${body}</article></body></html>`
        return new Response(html, { status: 200, headers: { 'Content-Type': 'text/html' } })
      }
      throw new Error(`Unexpected fetch call: ${url}`)
    })

    let stdoutText = ''
    const stdout = new Writable({
      write(chunk, _encoding, callback) {
        stdoutText += chunk.toString()
        callback()
      },
    })

    await runCli(
      [
        '--extract',
        '--format',
        'md',
        '--firecrawl',
        'always',
        '--timeout',
        '2s',
        'https://example.com',
      ],
      {
        env: { OPENAI_API_KEY: 'test', FIRECRAWL_API_KEY: 'test' },
        fetch: fetchMock as unknown as typeof fetch,
        stdout,
        stderr: new Writable({
          write(_chunk, _encoding, cb) {
            cb()
          },
        }),
      }
    )

    expect(stdoutText).toContain(body.slice(0, 200))
    expect(stdoutText.length).toBeGreaterThanOrEqual(59_000)
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })

  it('keeps --extract-only as a deprecated alias', async () => {
    const html =
      '<!doctype html><html><head><title>Ok</title></head>' +
      `<body><article><p>${'A'.repeat(260)}</p></article></body></html>`

    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.url
      if (url === 'https://example.com') {
        return new Response(html, { status: 200, headers: { 'Content-Type': 'text/html' } })
      }
      throw new Error(`Unexpected fetch call: ${url}`)
    })

    let stdoutText = ''
    const stdout = new Writable({
      write(chunk, _encoding, callback) {
        stdoutText += chunk.toString()
        callback()
      },
    })

    await runCli(['--extract-only', '--format', 'text', '--timeout', '2s', 'https://example.com'], {
      env: {},
      fetch: fetchMock as unknown as typeof fetch,
      stdout,
      stderr: new Writable({
        write(_chunk, _encoding, cb) {
          cb()
        },
      }),
    })

    expect(stdoutText.length).toBeGreaterThan(0)
  })
})
