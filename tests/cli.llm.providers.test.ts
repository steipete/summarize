import { Writable } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'

import { runCli } from '../src/run.js'

const htmlResponse = (html: string, status = 200) =>
  new Response(html, {
    status,
    headers: { 'Content-Type': 'text/html' },
  })

const generateTextMock = vi.fn(async () => ({ text: 'OK' }))
const createOpenAIMock = vi.fn(({ apiKey }: { apiKey: string }) => {
  return (modelId: string) => ({ provider: 'openai', modelId, apiKey })
})
const createGoogleMock = vi.fn(({ apiKey }: { apiKey: string }) => {
  return (modelId: string) => ({ provider: 'google', modelId, apiKey })
})
const createXaiMock = vi.fn(({ apiKey }: { apiKey: string }) => {
  return (modelId: string) => ({ provider: 'xai', modelId, apiKey })
})

vi.mock('ai', () => ({
  generateText: generateTextMock,
}))

vi.mock('@ai-sdk/openai', () => ({
  createOpenAI: createOpenAIMock,
}))

vi.mock('@ai-sdk/google', () => ({
  createGoogleGenerativeAI: createGoogleMock,
}))

vi.mock('@ai-sdk/xai', () => ({
  createXai: createXaiMock,
}))

function collectStdout() {
  let text = ''
  const stdout = new Writable({
    write(chunk, _encoding, callback) {
      text += chunk.toString()
      callback()
    },
  })
  return { stdout, getText: () => text }
}

describe('cli LLM provider selection (direct keys)', () => {
  it('uses OpenAI when --model is openai/...', async () => {
    generateTextMock.mockReset().mockResolvedValue({ text: 'OK' })
    createOpenAIMock.mockClear()
    createGoogleMock.mockClear()
    createXaiMock.mockClear()

    const html =
      '<!doctype html><html><head><title>Hello</title></head>' +
      '<body><article><p>Hi</p></article></body></html>'

    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.url
      if (url === 'https://example.com') return htmlResponse(html)
      throw new Error(`Unexpected fetch call: ${url}`)
    })

    const out = collectStdout()
    await runCli(['--model', 'openai/gpt-5.2', '--timeout', '2s', 'https://example.com'], {
      env: { OPENAI_API_KEY: 'test' },
      fetch: fetchMock as unknown as typeof fetch,
      stdout: out.stdout,
      stderr: new Writable({
        write(_c, _e, cb) {
          cb()
        },
      }),
    })

    expect(out.getText().trim()).toBe('OK')
    expect(createOpenAIMock).toHaveBeenCalledTimes(1)
    expect(createGoogleMock).toHaveBeenCalledTimes(0)
    expect(createXaiMock).toHaveBeenCalledTimes(0)
  })

  it('uses Google when --model is google/...', async () => {
    generateTextMock.mockReset().mockResolvedValue({ text: 'OK' })
    createOpenAIMock.mockClear()
    createGoogleMock.mockClear()
    createXaiMock.mockClear()

    const html =
      '<!doctype html><html><head><title>Hello</title></head>' +
      '<body><article><p>Hi</p></article></body></html>'

    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.url
      if (url === 'https://example.com') return htmlResponse(html)
      throw new Error(`Unexpected fetch call: ${url}`)
    })

    const out = collectStdout()
    await runCli(['--model', 'google/gemini-2.0-flash', '--timeout', '2s', 'https://example.com'], {
      env: { GOOGLE_GENERATIVE_AI_API_KEY: 'test' },
      fetch: fetchMock as unknown as typeof fetch,
      stdout: out.stdout,
      stderr: new Writable({
        write(_c, _e, cb) {
          cb()
        },
      }),
    })

    expect(out.getText().trim()).toBe('OK')
    expect(createOpenAIMock).toHaveBeenCalledTimes(0)
    expect(createGoogleMock).toHaveBeenCalledTimes(1)
    expect(createXaiMock).toHaveBeenCalledTimes(0)
  })

  it('uses xAI when --model is xai/...', async () => {
    generateTextMock.mockReset().mockResolvedValue({ text: 'OK' })
    createOpenAIMock.mockClear()
    createGoogleMock.mockClear()
    createXaiMock.mockClear()

    const html =
      '<!doctype html><html><head><title>Hello</title></head>' +
      '<body><article><p>Hi</p></article></body></html>'

    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.url
      if (url === 'https://example.com') return htmlResponse(html)
      throw new Error(`Unexpected fetch call: ${url}`)
    })

    const out = collectStdout()
    await runCli(
      ['--model', 'xai/grok-4-fast-non-reasoning', '--timeout', '2s', 'https://example.com'],
      {
        env: { XAI_API_KEY: 'test' },
        fetch: fetchMock as unknown as typeof fetch,
        stdout: out.stdout,
        stderr: new Writable({
          write(_c, _e, cb) {
            cb()
          },
        }),
      }
    )

    expect(out.getText().trim()).toBe('OK')
    expect(createOpenAIMock).toHaveBeenCalledTimes(0)
    expect(createGoogleMock).toHaveBeenCalledTimes(0)
    expect(createXaiMock).toHaveBeenCalledTimes(1)
  })
})
