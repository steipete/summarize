import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'

import { createCacheStore } from '../src/cache.js'
import { streamSummaryForVisiblePage } from '../src/daemon/summarize.js'

function createTextStream(chunks: string[]): AsyncIterable<string> {
  return {
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) yield chunk
    },
  }
}

const streamTextMock = vi.fn(() => {
  return {
    textStream: createTextStream(['### Overview\n- Cached summary.\n']),
    totalUsage: Promise.resolve({ promptTokens: 1, completionTokens: 1, totalTokens: 2 }),
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

describe('daemon summary cache', () => {
  it('reuses cached summary for visible page requests', async () => {
    streamTextMock.mockClear()

    const root = mkdtempSync(join(tmpdir(), 'summarize-daemon-cache-'))
    const summarizeDir = join(root, '.summarize')
    const cacheDir = join(summarizeDir, 'cache')
    mkdirSync(cacheDir, { recursive: true })

    writeFileSync(
      join(cacheDir, 'litellm-model_prices_and_context_window.json'),
      JSON.stringify({ 'gpt-5.2': { max_input_tokens: 999_999 } }),
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

    const cachePath = join(summarizeDir, 'cache.sqlite')
    const store = await createCacheStore({ path: cachePath, maxBytes: 1024 * 1024 })
    const cacheState = {
      mode: 'default' as const,
      store,
      ttlMs: 30 * 24 * 60 * 60 * 1000,
      maxBytes: 1024 * 1024,
      path: cachePath,
    }

    const runOnce = async () => {
      let out = ''
      const sink = {
        writeChunk: (text: string) => {
          out += text
        },
        onModelChosen: () => {},
      }

      await streamSummaryForVisiblePage({
        env: { HOME: root, OPENAI_API_KEY: 'test' },
        fetchImpl: globalThis.fetch.bind(globalThis),
        input: {
          url: 'https://example.com/article',
          title: 'Hello',
          text: 'Content',
          truncated: false,
        },
        modelOverride: 'openai/gpt-5.2',
        promptOverride: null,
        lengthRaw: 'xl',
        languageRaw: 'auto',
        sink,
        cache: cacheState,
      })

      return out
    }

    const first = await runOnce()
    expect(streamTextMock).toHaveBeenCalledTimes(1)

    const second = await runOnce()
    expect(streamTextMock).toHaveBeenCalledTimes(1)
    expect(second).toBe(first)

    store.close()
    globalFetchSpy.mockRestore()
  })
})
