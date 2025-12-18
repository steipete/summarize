import { Writable } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'

import { runCli } from '../src/run.js'

const htmlResponse = (html: string, status = 200) =>
  new Response(html, {
    status,
    headers: { 'Content-Type': 'text/html' },
  })

const openAiResponse = (content: string) =>
  Response.json(
    {
      choices: [{ message: { content } }],
    },
    { status: 200, headers: { 'Content-Type': 'application/json' } }
  )

describe('cli map-reduce summarization', () => {
  it('splits large inputs into chunks automatically', async () => {
    const content = 'A'.repeat(130_000)
    const html =
      '<!doctype html><html><head><title>Big</title></head>' +
      `<body><article><p>${content}</p></article></body></html>`

    let openAiCall = 0
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.url
      if (url === 'https://example.com') {
        return htmlResponse(html)
      }
      if (url === 'https://api.openai.com/v1/chat/completions') {
        openAiCall += 1
        if (openAiCall <= 3) {
          return openAiResponse(`chunk-${openAiCall}`)
        }
        return openAiResponse('FINAL')
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

    await runCli(['--json', '--timeout', '10s', 'https://example.com'], {
      env: { OPENAI_API_KEY: 'test' },
      fetch: fetchMock as unknown as typeof fetch,
      stdout,
      stderr,
    })

    const parsed = JSON.parse(stdoutText) as {
      llm: { provider: string; strategy: string; chunkCount: number } | null
      summary: string | null
    }

    expect(parsed.llm?.provider).toBe('openai')
    expect(parsed.llm?.strategy).toBe('map-reduce')
    expect(parsed.llm?.chunkCount).toBe(3)
    expect(parsed.summary).toBe('FINAL')
    expect(stderrText).toContain('summarizing in 3 chunks')
    expect(openAiCall).toBe(4)
  })

  it('skips a chunk when OpenAI returns an empty response', async () => {
    const content = 'A'.repeat(130_000)
    const html =
      '<!doctype html><html><head><title>Big</title></head>' +
      `<body><article><p>${content}</p></article></body></html>`

    let openAiCall = 0
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.url
      if (url === 'https://example.com') {
        return htmlResponse(html)
      }
      if (url === 'https://api.openai.com/v1/chat/completions') {
        openAiCall += 1
        if (openAiCall === 2) {
          return Response.json(
            { choices: [{ message: { content: null } }] },
            { status: 200, headers: { 'Content-Type': 'application/json' } }
          )
        }
        if (openAiCall <= 3) {
          return openAiResponse(`chunk-${openAiCall}`)
        }
        return openAiResponse('FINAL')
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

    await runCli(['--json', '--timeout', '10s', 'https://example.com'], {
      env: { OPENAI_API_KEY: 'test' },
      fetch: fetchMock as unknown as typeof fetch,
      stdout,
      stderr,
    })

    const parsed = JSON.parse(stdoutText) as {
      llm: { provider: string; strategy: string; chunkCount: number } | null
      summary: string | null
    }

    expect(parsed.llm?.provider).toBe('openai')
    expect(parsed.llm?.strategy).toBe('map-reduce')
    expect(parsed.llm?.chunkCount).toBe(3)
    expect(parsed.summary).toBe('FINAL')
    expect(stderrText).toContain('OpenAI returned an empty response for chunk 2; skipping.')
    expect(openAiCall).toBe(4)
  })
})
