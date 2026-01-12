import { Writable } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'

import { runCli } from '../src/run.js'

describe('cli --extract (asset url)', () => {
  it('prints extracted text and skips the LLM', async () => {
    const body = 'Hello from asset.'
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.url
      if (url === 'https://example.com/file.txt') {
        return new Response(body, {
          status: 200,
          headers: { 'Content-Type': 'text/plain' },
        })
      }
      if (url === 'https://api.openai.com/v1/chat/completions') {
        throw new Error('Unexpected OpenAI call in --extract mode')
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
        '--timeout',
        '2s',
        '--model',
        'openai/gpt-4o-mini',
        'https://example.com/file.txt',
      ],
      {
        env: { OPENAI_API_KEY: 'test' },
        fetch: fetchMock as unknown as typeof fetch,
        stdout,
        stderr: new Writable({
          write(_chunk, _encoding, cb) {
            cb()
          },
        }),
      }
    )

    expect(stdoutText.trim()).toBe(body)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('prints extracted content as JSON and skips the LLM', async () => {
    const body = 'Hello from asset.'
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.url
      if (url === 'https://example.com/file.txt') {
        return new Response(body, {
          status: 200,
          headers: { 'Content-Type': 'text/plain' },
        })
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
        '--json',
        '--timeout',
        '2s',
        '--model',
        'openai/gpt-4o-mini',
        'https://example.com/file.txt',
      ],
      {
        env: { OPENAI_API_KEY: 'test' },
        fetch: fetchMock as unknown as typeof fetch,
        stdout,
        stderr: new Writable({
          write(_chunk, _encoding, cb) {
            cb()
          },
        }),
      }
    )

    const payload = JSON.parse(stdoutText) as unknown as {
      input: { kind: string; url: string }
      extracted: { kind: string; content: string }
      llm: unknown
      summary: unknown
    }
    expect(payload.input.kind).toBe('asset-url')
    expect(payload.input.url).toBe('https://example.com/file.txt')
    expect(payload.extracted.kind).toBe('asset')
    expect(payload.extracted.content).toBe(body)
    expect(payload.llm).toBeNull()
    expect(payload.summary).toBeNull()
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})
