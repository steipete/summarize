import { Writable } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'

import { runCli } from '../src/run.js'

const htmlResponse = (html: string, status = 200) =>
  new Response(html, {
    status,
    headers: { 'Content-Type': 'text/html' },
  })

describe('cli --json', () => {
  it('disables AI SDK warning logs (stdout must stay JSON)', async () => {
    const globalObject = globalThis as unknown as { AI_SDK_LOG_WARNINGS?: boolean }
    const previous = globalObject.AI_SDK_LOG_WARNINGS
    globalObject.AI_SDK_LOG_WARNINGS = true

    try {
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

      await runCli(['--json', '--extract', '--timeout', '2s', 'https://example.com'], {
        env: {},
        fetch: fetchMock as unknown as typeof fetch,
        stdout,
        stderr: new Writable({
          write(_chunk, _encoding, callback) {
            callback()
          },
        }),
      })

      expect(globalObject.AI_SDK_LOG_WARNINGS).toBe(false)
      expect(() => JSON.parse(stdoutText)).not.toThrow()
    } finally {
      globalObject.AI_SDK_LOG_WARNINGS = previous
    }
  })

  it('prints JSON with prompt in --extract mode (no LLM call)', async () => {
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

    await runCli(['--json', '--extract', '--timeout', '2s', 'https://example.com'], {
      env: {},
      fetch: fetchMock as unknown as typeof fetch,
      stdout,
      stderr,
    })

    expect(stderrText).toContain('· auto')
    const parsed = JSON.parse(stdoutText) as {
      env: {
        hasXaiKey: boolean
        hasOpenAIKey: boolean
        hasGoogleKey: boolean
        hasAnthropicKey: boolean
      }
      llm: unknown
      summary: unknown
    }
    expect(parsed.env.hasXaiKey).toBe(false)
    expect(parsed.env.hasOpenAIKey).toBe(false)
    expect(parsed.env.hasGoogleKey).toBe(false)
    expect(parsed.env.hasAnthropicKey).toBe(false)
    expect(parsed.llm).toBeNull()
    expect(parsed.summary).toBeNull()
  })

  it('caps prompt guidance when requested length exceeds extracted content', async () => {
    const bodyText = 'Short content only.'
    const html =
      '<!doctype html><html><head><title>Ok</title><meta name="description" content="Desc" /></head>' +
      `<body><article><p>${bodyText}</p></article></body></html>`

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

    await runCli(
      ['--json', '--extract-only', '--length', 'xxl', '--timeout', '2s', 'https://example.com'],
      {
        env: {},
        fetch: fetchMock as unknown as typeof fetch,
        stdout,
        stderr: new Writable({
          write(_chunk, _encoding, callback) {
            callback()
          },
        }),
      }
    )

    const parsed = JSON.parse(stdoutText) as { prompt: string; extracted: { content: string } }
    expect(parsed.prompt).toContain(
      `Extracted content length: ${parsed.extracted.content.length} characters`
    )
    expect(parsed.prompt).toContain('Produce a comprehensive Markdown report')
  })
})
