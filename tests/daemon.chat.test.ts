import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'

import { streamChatResponse } from '../src/daemon/chat.js'
import { streamTextWithContext } from '../src/llm/generate-text.js'
import { buildAutoModelAttempts } from '../src/model-auto.js'

vi.mock('../src/llm/generate-text.js', () => {
  return {
    streamTextWithContext: vi.fn(async () => ({
      textStream: (async function* () {
        yield 'hello'
      })(),
      canonicalModelId: 'openai/gpt-5-mini',
      provider: 'openai',
      usage: Promise.resolve({ promptTokens: 1, completionTokens: 1, totalTokens: 2 }),
      lastError: () => null,
    })),
  }
})

vi.mock('../src/model-auto.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/model-auto.js')>()
  return {
    ...actual,
    buildAutoModelAttempts: vi.fn(),
  }
})

describe('daemon/chat', () => {
  it('uses native model ids when fixed model override is provided', async () => {
    const home = mkdtempSync(join(tmpdir(), 'summarize-daemon-chat-'))
    const events: Array<{ event: string }> = []
    const meta: Array<{ model?: string | null }> = []

    await streamChatResponse({
      env: { HOME: home, OPENAI_API_KEY: 'sk-openai' },
      fetchImpl: fetch,
      session: {
        id: 's1',
        lastMeta: { model: null, modelLabel: null, inputSummary: null, summaryFromCache: null },
      },
      pageUrl: 'https://example.com',
      pageTitle: 'Example',
      pageContent: 'Hello world',
      messages: [{ role: 'user', content: 'Hi' }],
      modelOverride: 'openai/gpt-5-mini',
      pushToSession: (evt) => events.push(evt),
      emitMeta: (patch) => meta.push(patch),
    })

    const calls = (streamTextWithContext as unknown as { mock: { calls: unknown[][] } }).mock.calls
    expect(calls.length).toBe(1)
    const args = calls[0]?.[0] as { modelId: string; forceOpenRouter?: boolean }
    expect(args.modelId).toBe('openai/gpt-5-mini')
    expect(args.forceOpenRouter).toBe(false)
    expect(meta[0]?.model).toBe('openai/gpt-5-mini')
    expect(events.some((evt) => evt.event === 'metrics')).toBe(true)
  })

  it('routes openrouter overrides through openrouter transport', async () => {
    const home = mkdtempSync(join(tmpdir(), 'summarize-daemon-chat-openrouter-'))
    const meta: Array<{ model?: string | null }> = []

    await streamChatResponse({
      env: { HOME: home, OPENROUTER_API_KEY: 'test' },
      fetchImpl: fetch,
      session: {
        id: 's2',
        lastMeta: { model: null, modelLabel: null, inputSummary: null, summaryFromCache: null },
      },
      pageUrl: 'https://example.com',
      pageTitle: null,
      pageContent: 'Hello world',
      messages: [{ role: 'user', content: 'Hi' }],
      modelOverride: 'openrouter/anthropic/claude-sonnet-4-5',
      pushToSession: () => {},
      emitMeta: (patch) => meta.push(patch),
    })

    const calls = (streamTextWithContext as unknown as { mock: { calls: unknown[][] } }).mock.calls
    const args = calls[calls.length - 1]?.[0] as { modelId: string; forceOpenRouter?: boolean }
    expect(args.modelId).toBe('openai/anthropic/claude-sonnet-4-5')
    expect(args.forceOpenRouter).toBe(true)
    expect(meta[0]?.model).toBe('openrouter/anthropic/claude-sonnet-4-5')
  })

  it('uses auto model attempts without forcing openrouter', async () => {
    const home = mkdtempSync(join(tmpdir(), 'summarize-daemon-chat-auto-'))
    const meta: Array<{ model?: string | null }> = []

    const attempts = [
      {
        transport: 'native' as const,
        userModelId: 'openai/gpt-5-mini',
        llmModelId: 'openai/gpt-5-mini',
        openrouterProviders: null,
        forceOpenRouter: false,
        requiredEnv: 'OPENAI_API_KEY' as const,
        debug: 'test',
      },
    ]

    vi.mocked(buildAutoModelAttempts).mockReturnValue(attempts)

    await streamChatResponse({
      env: { HOME: home, OPENAI_API_KEY: 'sk-openai' },
      fetchImpl: fetch,
      session: {
        id: 's3',
        lastMeta: { model: null, modelLabel: null, inputSummary: null, summaryFromCache: null },
      },
      pageUrl: 'https://example.com',
      pageTitle: null,
      pageContent: 'Hello world',
      messages: [{ role: 'user', content: 'Hi' }],
      modelOverride: null,
      pushToSession: () => {},
      emitMeta: (patch) => meta.push(patch),
    })

    const calls = (streamTextWithContext as unknown as { mock: { calls: unknown[][] } }).mock.calls
    const args = calls[calls.length - 1]?.[0] as { modelId: string; forceOpenRouter?: boolean }
    expect(args.modelId).toBe('openai/gpt-5-mini')
    expect(args.forceOpenRouter).toBe(false)
    expect(meta[0]?.model).toBe('openai/gpt-5-mini')
  })

  it('accepts legacy OpenRouter env mapping for auto attempts', async () => {
    const home = mkdtempSync(join(tmpdir(), 'summarize-daemon-chat-auto-openrouter-'))
    const meta: Array<{ model?: string | null }> = []

    const attempts = [
      {
        transport: 'openrouter' as const,
        userModelId: 'openrouter/openai/gpt-5-mini',
        llmModelId: 'openai/openai/gpt-5-mini',
        openrouterProviders: null,
        forceOpenRouter: true,
        requiredEnv: 'OPENROUTER_API_KEY' as const,
        debug: 'test',
      },
    ]

    vi.mocked(buildAutoModelAttempts).mockReturnValue(attempts)

    await streamChatResponse({
      env: {
        HOME: home,
        OPENAI_BASE_URL: 'https://openrouter.ai/api/v1',
        OPENAI_API_KEY: 'sk-openrouter-via-openai',
      },
      fetchImpl: fetch,
      session: {
        id: 's4',
        lastMeta: { model: null, modelLabel: null, inputSummary: null, summaryFromCache: null },
      },
      pageUrl: 'https://example.com',
      pageTitle: null,
      pageContent: 'Hello world',
      messages: [{ role: 'user', content: 'Hi' }],
      modelOverride: null,
      pushToSession: () => {},
      emitMeta: (patch) => meta.push(patch),
    })

    const calls = (streamTextWithContext as unknown as { mock: { calls: unknown[][] } }).mock.calls
    const args = calls[calls.length - 1]?.[0] as { modelId: string; forceOpenRouter?: boolean }
    expect(args.modelId).toBe('openai/openai/gpt-5-mini')
    expect(args.forceOpenRouter).toBe(true)
    expect(meta[0]?.model).toBe('openrouter/openai/gpt-5-mini')
  })
})
