import type { Api } from '@mariozechner/pi-ai'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { generateTextWithModelId, streamTextWithModelId } from '../src/llm/generate-text.js'
import { buildDocumentPrompt } from '../src/llm/prompt.js'
import { makeAssistantMessage, makeTextDeltaStream } from './helpers/pi-ai-mock.js'

type MockModel = { provider: string; id: string; api: Api }

const mocks = vi.hoisted(() => ({
  completeSimple: vi.fn(),
  streamSimple: vi.fn(),
  getModel: vi.fn(() => {
    throw new Error('no model')
  }),
}))

mocks.completeSimple.mockImplementation(async (model: MockModel) =>
  makeAssistantMessage({
    provider: model.provider,
    model: model.id,
    api: model.api,
    text: 'ok',
    usage: { input: 1, output: 2, totalTokens: 3 },
  })
)
mocks.streamSimple.mockImplementation((_model: MockModel) =>
  makeTextDeltaStream(['o', 'k'], makeAssistantMessage({ text: 'ok' }))
)

vi.mock('@mariozechner/pi-ai', () => ({
  completeSimple: mocks.completeSimple,
  streamSimple: mocks.streamSimple,
  getModel: mocks.getModel,
}))

describe('llm generate/stream', () => {
  const originalBaseUrl = process.env.OPENAI_BASE_URL

  afterEach(() => {
    mocks.completeSimple.mockClear()
    mocks.streamSimple.mockClear()
    process.env.OPENAI_BASE_URL = originalBaseUrl
  })

  it('routes by provider (generateText) and includes maxOutputTokens when set', async () => {
    mocks.completeSimple.mockClear()
    await generateTextWithModelId({
      modelId: 'xai/grok-4-fast-non-reasoning',
      apiKeys: {
        xaiApiKey: 'k',
        openaiApiKey: null,
        googleApiKey: null,
        anthropicApiKey: null,
        openrouterApiKey: null,
      },
      prompt: 'hi',
      timeoutMs: 2000,
      fetchImpl: globalThis.fetch.bind(globalThis),
      maxOutputTokens: 7,
    })
    await generateTextWithModelId({
      modelId: 'google/gemini-3-flash-preview',
      apiKeys: {
        xaiApiKey: null,
        openaiApiKey: null,
        googleApiKey: 'k',
        anthropicApiKey: null,
        openrouterApiKey: null,
      },
      prompt: 'hi',
      timeoutMs: 2000,
      fetchImpl: globalThis.fetch.bind(globalThis),
      maxOutputTokens: 7,
    })
    await generateTextWithModelId({
      modelId: 'anthropic/claude-opus-4-5',
      apiKeys: {
        xaiApiKey: null,
        openaiApiKey: null,
        googleApiKey: null,
        anthropicApiKey: 'k',
        openrouterApiKey: null,
      },
      prompt: 'hi',
      timeoutMs: 2000,
      fetchImpl: globalThis.fetch.bind(globalThis),
      maxOutputTokens: 7,
    })
    await generateTextWithModelId({
      modelId: 'openai/gpt-5.2',
      apiKeys: {
        openaiApiKey: 'k',
        xaiApiKey: null,
        googleApiKey: null,
        anthropicApiKey: null,
        openrouterApiKey: null,
      },
      prompt: 'hi',
      timeoutMs: 2000,
      fetchImpl: globalThis.fetch.bind(globalThis),
      maxOutputTokens: 7,
    })
    expect(mocks.completeSimple).toHaveBeenCalledTimes(4)
    for (const call of mocks.completeSimple.mock.calls) {
      const options = (call?.[2] ?? {}) as Record<string, unknown>
      expect(options).toHaveProperty('maxTokens', 7)
    }
  })

  it('does not include maxOutputTokens when unset', async () => {
    mocks.completeSimple.mockClear()
    mocks.streamSimple.mockClear()

    await generateTextWithModelId({
      modelId: 'openai/gpt-5.2',
      apiKeys: {
        openaiApiKey: 'k',
        xaiApiKey: null,
        googleApiKey: null,
        anthropicApiKey: null,
        openrouterApiKey: null,
      },
      prompt: 'hi',
      timeoutMs: 2000,
      fetchImpl: globalThis.fetch.bind(globalThis),
    })

    await streamTextWithModelId({
      modelId: 'openai/gpt-5.2',
      apiKeys: {
        openaiApiKey: 'k',
        xaiApiKey: null,
        googleApiKey: null,
        anthropicApiKey: null,
        openrouterApiKey: null,
      },
      prompt: 'hi',
      timeoutMs: 2000,
      fetchImpl: globalThis.fetch.bind(globalThis),
    })

    expect(mocks.completeSimple).toHaveBeenCalledTimes(1)
    expect(mocks.streamSimple).toHaveBeenCalledTimes(1)

    const generateArgs = (mocks.completeSimple.mock.calls[0]?.[2] ?? {}) as Record<string, unknown>
    const streamArgs = (mocks.streamSimple.mock.calls[0]?.[2] ?? {}) as Record<string, unknown>

    expect(generateArgs).not.toHaveProperty('maxTokens')
    expect(streamArgs).not.toHaveProperty('maxTokens')
  })

  it('uses Anthropic document calls for PDF prompts', async () => {
    mocks.completeSimple.mockClear()

    const fetchMock = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          content: [{ type: 'text', text: 'ok' }],
          usage: { input_tokens: 3, output_tokens: 4 },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      )
    })

    const result = await generateTextWithModelId({
      modelId: 'anthropic/claude-opus-4-5',
      apiKeys: {
        xaiApiKey: null,
        openaiApiKey: null,
        googleApiKey: null,
        anthropicApiKey: 'k',
        openrouterApiKey: null,
      },
      prompt: buildDocumentPrompt({
        text: 'Summarize the attached PDF.',
        document: {
          bytes: new Uint8Array([1, 2, 3]),
          mediaType: 'application/pdf',
          filename: 'test.pdf',
        },
      }),
      timeoutMs: 2000,
      fetchImpl: fetchMock as unknown as typeof fetch,
    })

    expect(result.text).toBe('ok')
    expect(result.usage).toMatchObject({ promptTokens: 3, completionTokens: 4, totalTokens: 7 })
    expect(mocks.completeSimple).toHaveBeenCalledTimes(0)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const options = fetchMock.mock.calls[0]?.[1] as RequestInit
    const body = JSON.parse(String(options.body))
    expect(body.model).toBe('claude-opus-4-5')
    expect(body.messages?.[0]?.content?.[0]?.type).toBe('document')
    expect(body.messages?.[0]?.content?.[0]?.source?.media_type).toBe('application/pdf')
    expect(typeof body.messages?.[0]?.content?.[0]?.source?.data).toBe('string')
  })

  it('uses OpenAI responses for PDF prompts', async () => {
    mocks.completeSimple.mockClear()
    process.env.OPENAI_BASE_URL = ''

    const fetchMock = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          output_text: 'ok',
          usage: { input_tokens: 2, output_tokens: 3, total_tokens: 5 },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      )
    })

    const result = await generateTextWithModelId({
      modelId: 'openai/gpt-5.2',
      apiKeys: {
        xaiApiKey: null,
        openaiApiKey: 'k',
        googleApiKey: null,
        anthropicApiKey: null,
        openrouterApiKey: null,
      },
      prompt: buildDocumentPrompt({
        text: 'Summarize the attached PDF.',
        document: {
          bytes: new Uint8Array([4, 5, 6]),
          mediaType: 'application/pdf',
          filename: 'test.pdf',
        },
      }),
      timeoutMs: 2000,
      fetchImpl: fetchMock as unknown as typeof fetch,
    })

    expect(result.text).toBe('ok')
    expect(result.usage).toMatchObject({ promptTokens: 2, completionTokens: 3, totalTokens: 5 })
    expect(mocks.completeSimple).toHaveBeenCalledTimes(0)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const options = fetchMock.mock.calls[0]?.[1] as RequestInit
    const body = JSON.parse(String(options.body))
    expect(body.model).toBe('gpt-5.2')
    expect(body.input?.[0]?.content?.[0]?.type).toBe('input_file')
    expect(body.input?.[0]?.content?.[0]?.file_data).toBeTypeOf('string')
  })

  it('uses Gemini inline data for PDF prompts', async () => {
    mocks.completeSimple.mockClear()

    const fetchMock = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          candidates: [
            {
              content: {
                parts: [{ text: 'ok' }],
              },
            },
          ],
          usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 2, totalTokenCount: 3 },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      )
    })

    const result = await generateTextWithModelId({
      modelId: 'google/gemini-3-flash-preview',
      apiKeys: {
        xaiApiKey: null,
        openaiApiKey: null,
        googleApiKey: 'k',
        anthropicApiKey: null,
        openrouterApiKey: null,
      },
      prompt: buildDocumentPrompt({
        text: 'Summarize the attached PDF.',
        document: {
          bytes: new Uint8Array([7, 8, 9]),
          mediaType: 'application/pdf',
          filename: 'test.pdf',
        },
      }),
      timeoutMs: 2000,
      fetchImpl: fetchMock as unknown as typeof fetch,
    })

    expect(result.text).toBe('ok')
    expect(result.usage).toMatchObject({ promptTokens: 1, completionTokens: 2, totalTokens: 3 })
    expect(mocks.completeSimple).toHaveBeenCalledTimes(0)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const options = fetchMock.mock.calls[0]?.[1] as RequestInit
    const body = JSON.parse(String(options.body))
    expect(body.contents?.[0]?.parts?.[0]?.inline_data?.mime_type).toBe('application/pdf')
    expect(body.contents?.[0]?.parts?.[0]?.inline_data?.data).toBeTypeOf('string')
  })

  it('routes by provider (streamText) and includes maxOutputTokens when set', async () => {
    mocks.streamSimple.mockClear()
    await streamTextWithModelId({
      modelId: 'xai/grok-4-fast-non-reasoning',
      apiKeys: {
        xaiApiKey: 'k',
        openaiApiKey: null,
        googleApiKey: null,
        anthropicApiKey: null,
        openrouterApiKey: null,
      },
      prompt: 'hi',
      timeoutMs: 2000,
      fetchImpl: globalThis.fetch.bind(globalThis),
      maxOutputTokens: 9,
    })
    await streamTextWithModelId({
      modelId: 'google/gemini-3-flash-preview',
      apiKeys: {
        xaiApiKey: null,
        openaiApiKey: null,
        googleApiKey: 'k',
        anthropicApiKey: null,
        openrouterApiKey: null,
      },
      prompt: 'hi',
      timeoutMs: 2000,
      fetchImpl: globalThis.fetch.bind(globalThis),
      maxOutputTokens: 9,
    })
    await streamTextWithModelId({
      modelId: 'anthropic/claude-opus-4-5',
      apiKeys: {
        xaiApiKey: null,
        openaiApiKey: null,
        googleApiKey: null,
        anthropicApiKey: 'k',
        openrouterApiKey: null,
      },
      prompt: 'hi',
      timeoutMs: 2000,
      fetchImpl: globalThis.fetch.bind(globalThis),
      maxOutputTokens: 9,
    })
    await streamTextWithModelId({
      modelId: 'openai/gpt-5.2',
      apiKeys: {
        openaiApiKey: 'k',
        xaiApiKey: null,
        googleApiKey: null,
        anthropicApiKey: null,
        openrouterApiKey: null,
      },
      prompt: 'hi',
      timeoutMs: 2000,
      fetchImpl: globalThis.fetch.bind(globalThis),
      maxOutputTokens: 9,
    })
    expect(mocks.streamSimple).toHaveBeenCalledTimes(4)
    for (const call of mocks.streamSimple.mock.calls) {
      const options = (call?.[2] ?? {}) as Record<string, unknown>
      expect(options).toHaveProperty('maxTokens', 9)
    }
  })

  it('throws a friendly timeout error on AbortError', async () => {
    mocks.completeSimple.mockImplementationOnce(async () => {
      throw new DOMException('aborted', 'AbortError')
    })
    await expect(
      generateTextWithModelId({
        modelId: 'openai/gpt-5.2',
        apiKeys: {
          openaiApiKey: 'k',
          xaiApiKey: null,
          googleApiKey: null,
          anthropicApiKey: null,
          openrouterApiKey: null,
        },
        prompt: 'hi',
        timeoutMs: 1,
        fetchImpl: globalThis.fetch.bind(globalThis),
        maxOutputTokens: 10,
      })
    ).rejects.toThrow(/timed out/i)
  })

  it('retries once when the model returns an empty output', async () => {
    mocks.completeSimple.mockClear()
    mocks.completeSimple.mockImplementationOnce(async () =>
      makeAssistantMessage({ text: '   ', usage: { input: 1, output: 2, totalTokens: 3 } })
    )
    mocks.completeSimple.mockImplementationOnce(async () =>
      makeAssistantMessage({ text: 'ok', usage: { input: 1, output: 2, totalTokens: 3 } })
    )

    const result = await generateTextWithModelId({
      modelId: 'openai/gpt-5.2',
      apiKeys: {
        openaiApiKey: 'k',
        xaiApiKey: null,
        googleApiKey: null,
        anthropicApiKey: null,
        openrouterApiKey: null,
      },
      prompt: 'hi',
      timeoutMs: 2000,
      fetchImpl: globalThis.fetch.bind(globalThis),
      maxOutputTokens: 10,
      retries: 1,
    })

    expect(result.text).toBe('ok')
    expect(mocks.completeSimple).toHaveBeenCalledTimes(2)
  })

  it('enforces missing-key errors per provider', async () => {
    await expect(
      generateTextWithModelId({
        modelId: 'google/gemini-3-flash-preview',
        apiKeys: {
          openaiApiKey: null,
          xaiApiKey: null,
          googleApiKey: null,
          anthropicApiKey: null,
          openrouterApiKey: null,
        },
        prompt: 'hi',
        timeoutMs: 2000,
        fetchImpl: globalThis.fetch.bind(globalThis),
        maxOutputTokens: 10,
      })
    ).rejects.toThrow(/GEMINI_API_KEY/i)

    await expect(
      generateTextWithModelId({
        modelId: 'xai/grok-4-fast-non-reasoning',
        apiKeys: {
          openaiApiKey: null,
          xaiApiKey: null,
          googleApiKey: null,
          anthropicApiKey: null,
          openrouterApiKey: null,
        },
        prompt: 'hi',
        timeoutMs: 2000,
        fetchImpl: globalThis.fetch.bind(globalThis),
        maxOutputTokens: 10,
      })
    ).rejects.toThrow(/XAI_API_KEY/i)

    await expect(
      generateTextWithModelId({
        modelId: 'anthropic/claude-opus-4-5',
        apiKeys: {
          openaiApiKey: null,
          xaiApiKey: null,
          googleApiKey: null,
          anthropicApiKey: null,
          openrouterApiKey: null,
        },
        prompt: 'hi',
        timeoutMs: 2000,
        fetchImpl: globalThis.fetch.bind(globalThis),
        maxOutputTokens: 10,
      })
    ).rejects.toThrow(/ANTHROPIC_API_KEY/i)
  })

  it('uses chat completions for custom OPENAI_BASE_URL and skips OpenRouter headers', async () => {
    process.env.OPENAI_BASE_URL = 'https://openai.example.com/v1'
    mocks.completeSimple.mockClear()

    await generateTextWithModelId({
      modelId: 'openai/gpt-5.2',
      apiKeys: {
        openaiApiKey: 'openai-key',
        openrouterApiKey: 'openrouter-key',
        xaiApiKey: null,
        googleApiKey: null,
        anthropicApiKey: null,
      },
      prompt: 'hi',
      timeoutMs: 2000,
      fetchImpl: globalThis.fetch.bind(globalThis),
    })

    const model = mocks.completeSimple.mock.calls[0]?.[0] as { baseUrl?: string; api?: string }
    expect(model.baseUrl).toBe('https://openai.example.com/v1')
    expect(model.api).toBe('openai-completions')

    const headers = (
      mocks.completeSimple.mock.calls[0]?.[0] as { headers?: Record<string, string> }
    ).headers
    expect(headers?.['HTTP-Referer'] ?? null).toBeNull()
  })

  it('adds OpenRouter headers and forces chat completions when OPENROUTER_API_KEY is set', async () => {
    delete process.env.OPENAI_BASE_URL
    mocks.completeSimple.mockClear()

    await generateTextWithModelId({
      modelId: 'openai/openai/gpt-oss-20b',
      apiKeys: {
        openaiApiKey: null,
        openrouterApiKey: 'openrouter-key',
        xaiApiKey: null,
        googleApiKey: null,
        anthropicApiKey: null,
      },
      prompt: 'hi',
      timeoutMs: 2000,
      fetchImpl: globalThis.fetch.bind(globalThis),
    })

    const model = mocks.completeSimple.mock.calls[0]?.[0] as {
      baseUrl?: string
      api?: string
      headers?: Record<string, string>
    }
    expect(model.baseUrl).toBe('https://openrouter.ai/api/v1')
    expect(model.api).toBe('openai-completions')
    expect(model.headers?.['HTTP-Referer']).toBe('https://github.com/steipete/summarize')
    expect(model.headers?.['X-Title']).toBe('summarize')
  })

  it('applies provider baseUrl overrides (google/xai)', async () => {
    mocks.completeSimple.mockClear()

    await generateTextWithModelId({
      modelId: 'google/gemini-3-flash-preview',
      apiKeys: {
        openaiApiKey: null,
        openrouterApiKey: null,
        xaiApiKey: null,
        googleApiKey: 'k',
        anthropicApiKey: null,
      },
      prompt: 'hi',
      timeoutMs: 2000,
      fetchImpl: globalThis.fetch.bind(globalThis),
      googleBaseUrlOverride: 'https://google-proxy.example.com',
    })

    const googleModel = mocks.completeSimple.mock.calls[0]?.[0] as { baseUrl?: string }
    expect(googleModel.baseUrl).toBe('https://google-proxy.example.com')

    mocks.completeSimple.mockClear()
    await generateTextWithModelId({
      modelId: 'xai/grok-4-fast-non-reasoning',
      apiKeys: {
        openaiApiKey: null,
        openrouterApiKey: null,
        xaiApiKey: 'k',
        googleApiKey: null,
        anthropicApiKey: null,
      },
      prompt: 'hi',
      timeoutMs: 2000,
      fetchImpl: globalThis.fetch.bind(globalThis),
      xaiBaseUrlOverride: 'https://xai-proxy.example.com/v1',
    })

    const xaiModel = mocks.completeSimple.mock.calls[0]?.[0] as { baseUrl?: string }
    expect(xaiModel.baseUrl).toBe('https://xai-proxy.example.com/v1')
  })

  it('wraps anthropic model access errors with a helpful message', async () => {
    mocks.completeSimple.mockImplementationOnce(async () => {
      const error = Object.assign(new Error('model: claude-3-5-sonnet-latest'), {
        statusCode: 404,
        responseBody: JSON.stringify({
          type: 'error',
          error: { type: 'not_found_error', message: 'model: claude-3-5-sonnet-latest' },
        }),
      })
      throw error
    })

    await expect(
      generateTextWithModelId({
        modelId: 'anthropic/claude-3-5-sonnet-latest',
        apiKeys: {
          xaiApiKey: null,
          openaiApiKey: null,
          googleApiKey: null,
          anthropicApiKey: 'k',
          openrouterApiKey: null,
        },
        prompt: 'hi',
        timeoutMs: 2000,
        fetchImpl: globalThis.fetch.bind(globalThis),
        maxOutputTokens: 10,
      })
    ).rejects.toThrow(/Anthropic API rejected model "claude-3-5-sonnet-latest"/i)

    mocks.streamSimple.mockImplementationOnce(() => {
      const error = Object.assign(new Error('model: claude-3-5-sonnet-latest'), {
        statusCode: 403,
        responseBody: JSON.stringify({
          type: 'error',
          error: { type: 'permission_error', message: 'model: claude-3-5-sonnet-latest' },
        }),
      })
      throw error
    })

    await expect(
      streamTextWithModelId({
        modelId: 'anthropic/claude-3-5-sonnet-latest',
        apiKeys: {
          xaiApiKey: null,
          openaiApiKey: null,
          googleApiKey: null,
          anthropicApiKey: 'k',
          openrouterApiKey: null,
        },
        prompt: 'hi',
        timeoutMs: 2000,
        fetchImpl: globalThis.fetch.bind(globalThis),
        maxOutputTokens: 10,
      })
    ).rejects.toThrow(/Anthropic API rejected model "claude-3-5-sonnet-latest"/i)
  })

  it('throws a friendly timeout error on AbortError (streamText)', async () => {
    mocks.streamSimple.mockImplementationOnce(() => {
      throw new DOMException('aborted', 'AbortError')
    })
    await expect(
      streamTextWithModelId({
        modelId: 'openai/gpt-5.2',
        apiKeys: {
          openaiApiKey: 'k',
          xaiApiKey: null,
          googleApiKey: null,
          anthropicApiKey: null,
          openrouterApiKey: null,
        },
        prompt: 'hi',
        timeoutMs: 1,
        fetchImpl: globalThis.fetch.bind(globalThis),
        maxOutputTokens: 10,
      })
    ).rejects.toThrow(/timed out/i)
  })

  it('times out when a stream stalls before yielding', async () => {
    mocks.streamSimple.mockImplementationOnce(() => ({
      async *[Symbol.asyncIterator]() {
        await new Promise(() => {})
      },
      result: async () => makeAssistantMessage({ text: 'ok' }),
    }))
    const result = await streamTextWithModelId({
      modelId: 'openai/gpt-5.2',
      apiKeys: {
        openaiApiKey: 'k',
        xaiApiKey: null,
        googleApiKey: null,
        anthropicApiKey: null,
        openrouterApiKey: null,
      },
      prompt: 'hi',
      timeoutMs: 5,
      fetchImpl: globalThis.fetch.bind(globalThis),
      maxOutputTokens: 10,
    })
    const iterator = result.textStream[Symbol.asyncIterator]()
    const nextPromise = iterator.next()
    await expect(nextPromise).rejects.toThrow(/timed out/i)
  }, 250)
})
