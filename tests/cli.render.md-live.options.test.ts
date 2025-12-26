import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Writable } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'

import { runCli } from '../src/run.js'

const { createLiveRendererMock, renderMock } = vi.hoisted(() => ({
  createLiveRendererMock: vi.fn(() => ({
    render: vi.fn(),
    finish: vi.fn(),
  })),
  renderMock: vi.fn(() => 'ok\n'),
}))

vi.mock('markdansi', () => ({
  createLiveRenderer: createLiveRendererMock,
  render: renderMock,
}))

const streamTextMock = vi.fn(() => {
  return {
    textStream: createTextStream(['Hello **bo', 'ld**\n']),
    totalUsage: Promise.resolve({
      promptTokens: 100,
      completionTokens: 50,
      totalTokens: 150,
    }),
  }
})

vi.mock('ai', () => ({
  streamText: streamTextMock,
}))

const createOpenAIMock = vi.fn(() => {
  return (_modelId: string) => ({})
})

vi.mock('@ai-sdk/openai', () => ({
  createOpenAI: createOpenAIMock,
}))

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

function createTextStream(chunks: string[]): AsyncIterable<string> {
  return {
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) yield chunk
    },
  }
}

describe('cli md-live rendering options', () => {
  it('pads maxRows to avoid scrollback anchor row', async () => {
    createLiveRendererMock.mockClear()
    renderMock.mockClear()
    streamTextMock.mockClear()
    createOpenAIMock.mockClear()
    streamTextMock.mockImplementation(() => {
      return {
        textStream: createTextStream(['Hello **bo', 'ld**\n']),
        totalUsage: Promise.resolve({
          promptTokens: 100,
          completionTokens: 50,
          totalTokens: 150,
        }),
      }
    })

    const root = mkdtempSync(join(tmpdir(), 'summarize-md-live-opts-'))
    const cacheDir = join(root, '.summarize', 'cache')
    mkdirSync(cacheDir, { recursive: true })

    writeFileSync(
      join(cacheDir, 'litellm-model_prices_and_context_window.json'),
      JSON.stringify({
        'gpt-5.2': { input_cost_per_token: 0.00000175, output_cost_per_token: 0.000014 },
      }),
      'utf8'
    )
    writeFileSync(
      join(cacheDir, 'litellm-model_prices_and_context_window.meta.json'),
      JSON.stringify({ fetchedAtMs: Date.now() }),
      'utf8'
    )

    const globalFetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      throw new Error('unexpected LiteLLM catalog fetch')
    })

    try {
      const html =
        '<!doctype html><html><head><title>Hello</title></head>' +
        '<body><article><p>Hi</p></article></body></html>'

      const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
        const url = typeof input === 'string' ? input : input.url
        if (url === 'https://example.com') return htmlResponse(html)
        throw new Error(`Unexpected fetch call: ${url}`)
      })

      const stdout = collectStream()
      ;(stdout.stream as unknown as { isTTY?: boolean; columns?: number; rows?: number }).isTTY = true
      ;(stdout.stream as unknown as { columns?: number; rows?: number }).columns = 80
      ;(stdout.stream as unknown as { rows?: number }).rows = 20
      const stderr = collectStream()

      await runCli(
        [
          '--model',
          'openai/gpt-5.2',
          '--timeout',
          '2s',
          '--stream',
          'auto',
          '--render',
          'auto',
          'https://example.com',
        ],
        {
          env: { HOME: root, OPENAI_API_KEY: 'test' },
          fetch: fetchMock as unknown as typeof fetch,
          stdout: stdout.stream,
          stderr: stderr.stream,
        }
      )

      expect(createLiveRendererMock).toHaveBeenCalledTimes(1)
      const options = createLiveRendererMock.mock.calls[0]?.[0]
      const renderer = createLiveRendererMock.mock.results[0]?.value
      expect(options?.maxRows).toBe(19)
      expect(options?.tailRows).toBe(12)
      expect(options?.clearOnOverflow).toBe(false)
      expect(options?.appendWhenPossible).toBe(true)
      expect(renderer?.finish).toHaveBeenCalledWith('Hello **bold**')
    } finally {
      globalFetchSpy.mockRestore()
    }
  })

  it('locks live render width across frames', async () => {
    createLiveRendererMock.mockClear()
    renderMock.mockClear()
    streamTextMock.mockClear()
    createOpenAIMock.mockClear()
    streamTextMock.mockImplementation(() => {
      return {
        textStream: createTextStream(['Hello **bo', 'ld**\n']),
        totalUsage: Promise.resolve({
          promptTokens: 100,
          completionTokens: 50,
          totalTokens: 150,
        }),
      }
    })

    const root = mkdtempSync(join(tmpdir(), 'summarize-md-live-width-'))
    const cacheDir = join(root, '.summarize', 'cache')
    mkdirSync(cacheDir, { recursive: true })

    writeFileSync(
      join(cacheDir, 'litellm-model_prices_and_context_window.json'),
      JSON.stringify({
        'gpt-5.2': { input_cost_per_token: 0.00000175, output_cost_per_token: 0.000014 },
      }),
      'utf8'
    )
    writeFileSync(
      join(cacheDir, 'litellm-model_prices_and_context_window.meta.json'),
      JSON.stringify({ fetchedAtMs: Date.now() }),
      'utf8'
    )

    const globalFetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      throw new Error('unexpected LiteLLM catalog fetch')
    })

    try {
      const html =
        '<!doctype html><html><head><title>Hello</title></head>' +
        '<body><article><p>Hi</p></article></body></html>'

      const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
        const url = typeof input === 'string' ? input : input.url
        if (url === 'https://example.com') return htmlResponse(html)
        throw new Error(`Unexpected fetch call: ${url}`)
      })

      const stdout = collectStream()
      const stdoutState = stdout.stream as unknown as {
        isTTY?: boolean
        columns?: number
        rows?: number
      }
      stdoutState.isTTY = true
      stdoutState.columns = 80
      stdoutState.rows = 20
      const stderr = collectStream()

      await runCli(
        [
          '--model',
          'openai/gpt-5.2',
          '--timeout',
          '2s',
          '--stream',
          'auto',
          '--render',
          'auto',
          'https://example.com',
        ],
        {
          env: { HOME: root, OPENAI_API_KEY: 'test' },
          fetch: fetchMock as unknown as typeof fetch,
          stdout: stdout.stream,
          stderr: stderr.stream,
        }
      )

      const options = createLiveRendererMock.mock.calls[0]?.[0]
      const renderFrame = options?.renderFrame
      expect(options?.width).toBe(79)

      renderMock.mockClear()
      renderFrame?.('Hello')
      expect(renderMock).toHaveBeenLastCalledWith(
        expect.any(String),
        expect.objectContaining({ width: 79 })
      )

      // Changing columns mid-stream should not alter the live renderer width.
      stdoutState.columns = 100
      renderFrame?.('Hello again')
      expect(renderMock).toHaveBeenLastCalledWith(
        expect.any(String),
        expect.objectContaining({ width: 79 })
      )
    } finally {
      globalFetchSpy.mockRestore()
    }
  })

  it('caps tailRows for short terminals', async () => {
    createLiveRendererMock.mockClear()
    renderMock.mockClear()
    streamTextMock.mockClear()
    createOpenAIMock.mockClear()
    streamTextMock.mockImplementation(() => {
      return {
        textStream: createTextStream(['Hello **bo', 'ld**\n']),
        totalUsage: Promise.resolve({
          promptTokens: 100,
          completionTokens: 50,
          totalTokens: 150,
        }),
      }
    })

    const root = mkdtempSync(join(tmpdir(), 'summarize-md-live-short-'))
    const cacheDir = join(root, '.summarize', 'cache')
    mkdirSync(cacheDir, { recursive: true })

    writeFileSync(
      join(cacheDir, 'litellm-model_prices_and_context_window.json'),
      JSON.stringify({
        'gpt-5.2': { input_cost_per_token: 0.00000175, output_cost_per_token: 0.000014 },
      }),
      'utf8'
    )
    writeFileSync(
      join(cacheDir, 'litellm-model_prices_and_context_window.meta.json'),
      JSON.stringify({ fetchedAtMs: Date.now() }),
      'utf8'
    )

    const globalFetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      throw new Error('unexpected LiteLLM catalog fetch')
    })

    try {
      const html =
        '<!doctype html><html><head><title>Hello</title></head>' +
        '<body><article><p>Hi</p></article></body></html>'

      const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
        const url = typeof input === 'string' ? input : input.url
        if (url === 'https://example.com') return htmlResponse(html)
        throw new Error(`Unexpected fetch call: ${url}`)
      })

      const stdout = collectStream()
      ;(stdout.stream as unknown as { isTTY?: boolean; columns?: number; rows?: number }).isTTY = true
      ;(stdout.stream as unknown as { columns?: number; rows?: number }).columns = 80
      ;(stdout.stream as unknown as { rows?: number }).rows = 5
      const stderr = collectStream()

      await runCli(
        [
          '--model',
          'openai/gpt-5.2',
          '--timeout',
          '2s',
          '--stream',
          'auto',
          '--render',
          'auto',
          'https://example.com',
        ],
        {
          env: { HOME: root, OPENAI_API_KEY: 'test' },
          fetch: fetchMock as unknown as typeof fetch,
          stdout: stdout.stream,
          stderr: stderr.stream,
        }
      )

      const options = createLiveRendererMock.mock.calls[0]?.[0]
      expect(options?.maxRows).toBe(4)
      expect(options?.tailRows).toBe(3)
    } finally {
      globalFetchSpy.mockRestore()
    }
  })
})
