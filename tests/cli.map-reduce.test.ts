import { Writable } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'

import { runCli } from '../src/run.js'

const htmlResponse = (html: string, status = 200) =>
  new Response(html, {
    status,
    headers: { 'Content-Type': 'text/html' },
  })

const generateTextMock = vi.fn(async () => ({ text: 'OK' }))

vi.mock('ai', () => ({
  generateText: generateTextMock,
}))

vi.mock('@ai-sdk/openai', () => ({
  createOpenAI: vi.fn(({ apiKey }: { apiKey: string }) => {
    return (modelId: string) => ({ provider: 'openai', modelId, apiKey })
  }),
}))

describe('cli map-reduce summarization', () => {
  it('splits large inputs into chunks automatically', async () => {
    const content = 'A'.repeat(130_000)
    const html =
      '<!doctype html><html><head><title>Big</title></head>' +
      `<body><article><p>${content}</p></article></body></html>`

    generateTextMock.mockReset()
    let call = 0
    generateTextMock.mockImplementation(async () => {
      call += 1
      if (call <= 3) return { text: `chunk-${call}` }
      return { text: 'FINAL' }
    })

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

    await runCli(
      ['--json', '--model', 'openai/gpt-5.2', '--timeout', '10s', 'https://example.com'],
      {
        env: { OPENAI_API_KEY: 'test' },
        fetch: fetchMock as unknown as typeof fetch,
        stdout,
        stderr,
      }
    )

    const parsed = JSON.parse(stdoutText) as {
      llm: { provider: string; strategy: string; chunkCount: number } | null
      summary: string | null
    }

    expect(parsed.llm?.provider).toBe('openai')
    expect(parsed.llm?.strategy).toBe('map-reduce')
    expect(parsed.llm?.chunkCount).toBe(3)
    expect(parsed.summary).toBe('FINAL')
    expect(stderrText).toContain('summarizing in 3 chunks')
    expect(generateTextMock).toHaveBeenCalledTimes(4)
  })

  it('handles an empty chunk summary without failing', async () => {
    const content = 'A'.repeat(130_000)
    const html =
      '<!doctype html><html><head><title>Big</title></head>' +
      `<body><article><p>${content}</p></article></body></html>`

    generateTextMock.mockReset()
    let call = 0
    generateTextMock.mockImplementation(async () => {
      call += 1
      if (call === 2) return { text: '' }
      if (call <= 3) return { text: `chunk-${call}` }
      return { text: 'FINAL' }
    })

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

    const stderr = new Writable({
      write(chunk, _encoding, callback) {
        void chunk
        callback()
      },
    })

    await runCli(
      ['--json', '--model', 'openai/gpt-5.2', '--timeout', '10s', 'https://example.com'],
      {
        env: { OPENAI_API_KEY: 'test' },
        fetch: fetchMock as unknown as typeof fetch,
        stdout,
        stderr,
      }
    )

    const parsed = JSON.parse(stdoutText) as {
      llm: { provider: string; strategy: string; chunkCount: number } | null
      summary: string | null
    }

    expect(parsed.llm?.provider).toBe('openai')
    expect(parsed.llm?.strategy).toBe('map-reduce')
    expect(parsed.llm?.chunkCount).toBe(3)
    expect(parsed.summary).toBe('FINAL')
    expect(generateTextMock).toHaveBeenCalledTimes(4)
  })
})
