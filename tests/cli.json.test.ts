import { Writable } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'

import { runCli } from '../src/run.js'

const htmlResponse = (html: string, status = 200) =>
  new Response(html, {
    status,
    headers: { 'Content-Type': 'text/html' },
  })

describe('cli --json', () => {
  it('prints JSON with prompt when OPENAI_API_KEY is missing', async () => {
    const html =
      '<!doctype html><html><head><title>Ok</title><meta name="description" content="Desc" /></head>' +
      `<body><article><p>${'A'.repeat(260)}</p></article></body></html>`

    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.url
      if (url === 'https://example.com') {
        return htmlResponse(html)
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

    let stderrText = ''
    const stderr = new Writable({
      write(chunk, _encoding, callback) {
        stderrText += chunk.toString()
        callback()
      },
    })

    await runCli(['--json', '--timeout', '2s', 'https://example.com'], {
      env: {},
      fetch: fetchMock as unknown as typeof fetch,
      stdout,
      stderr,
    })

    expect(stderrText).toBe('')
    const parsed = JSON.parse(stdoutText) as {
      env: { hasOpenAIKey: boolean; hasAiGatewayKey: boolean }
      llm: unknown
      summary: unknown
    }
    expect(parsed.env.hasOpenAIKey).toBe(false)
    expect(parsed.env.hasAiGatewayKey).toBe(false)
    expect(parsed.llm).toBeNull()
    expect(parsed.summary).toBeNull()
  })
})
