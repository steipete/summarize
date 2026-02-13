import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AssistantMessage, Tool } from '@mariozechner/pi-ai'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { completeAgentResponse } from '../src/daemon/agent.js'
import * as modelAuto from '../src/model-auto.js'

const { mockCompleteSimple, mockGetModel } = vi.hoisted(() => ({
  mockCompleteSimple: vi.fn(),
  mockGetModel: vi.fn(),
}))

vi.mock('@mariozechner/pi-ai', () => {
  return {
    completeSimple: mockCompleteSimple,
    getModel: mockGetModel,
  }
})

const buildAssistant = (provider: string, model: string): AssistantMessage => ({
  role: 'assistant',
  content: [{ type: 'text', text: 'ok' }],
  api: 'openai-completions',
  provider,
  model,
  usage: {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  },
  stopReason: 'stop',
  timestamp: Date.now(),
})

const makeModel = (provider: string, modelId: string) => ({
  id: modelId,
  name: modelId,
  provider,
  api: 'openai-completions' as const,
  baseUrl: 'https://example.com',
  reasoning: false,
  input: ['text'],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 8192,
  maxTokens: 2048,
})

const makeTempHome = () => mkdtempSync(join(tmpdir(), 'summarize-daemon-agent-'))

beforeEach(() => {
  mockCompleteSimple.mockReset()
  mockGetModel.mockReset()
  mockGetModel.mockImplementation((provider: string, modelId: string) =>
    makeModel(provider, modelId)
  )
  mockCompleteSimple.mockImplementation(async (model: { provider: string; id: string }) =>
    buildAssistant(model.provider, model.id)
  )
})

describe('daemon/agent', () => {
  it('passes openrouter api key to pi-ai when using openrouter models', async () => {
    const home = makeTempHome()
    await completeAgentResponse({
      env: { HOME: home, OPENROUTER_API_KEY: 'or-key' },
      pageUrl: 'https://example.com',
      pageTitle: 'Example',
      pageContent: 'Hello world',
      messages: [{ role: 'user', content: 'Hi' }],
      modelOverride: 'openrouter/openai/gpt-5-mini',
      tools: [],
      automationEnabled: false,
    })

    const options = mockCompleteSimple.mock.calls[0]?.[2] as { apiKey?: string }
    expect(options.apiKey).toBe('or-key')
  })

  it('passes openai api key to pi-ai for openai models', async () => {
    const home = makeTempHome()
    await completeAgentResponse({
      env: { HOME: home, OPENAI_API_KEY: 'sk-openai' },
      pageUrl: 'https://example.com',
      pageTitle: null,
      pageContent: 'Hello world',
      messages: [{ role: 'user', content: 'Hi' }],
      modelOverride: 'openai/gpt-5-mini',
      tools: [],
      automationEnabled: false,
    })

    const options = mockCompleteSimple.mock.calls[0]?.[2] as { apiKey?: string }
    expect(options.apiKey).toBe('sk-openai')
  })

  it('throws a helpful error when openrouter key is missing', async () => {
    const home = makeTempHome()
    await expect(
      completeAgentResponse({
        env: { HOME: home },
        pageUrl: 'https://example.com',
        pageTitle: null,
        pageContent: 'Hello world',
        messages: [{ role: 'user', content: 'Hi' }],
        modelOverride: 'openrouter/openai/gpt-5-mini',
        tools: [],
        automationEnabled: false,
      })
    ).rejects.toThrow(/Missing OPENROUTER_API_KEY/)
  })

  it('includes summarize tool definitions when automation is enabled', async () => {
    const home = makeTempHome()
    await completeAgentResponse({
      env: { HOME: home, OPENAI_API_KEY: 'sk-openai' },
      pageUrl: 'https://example.com',
      pageTitle: null,
      pageContent: 'Hello world',
      messages: [{ role: 'user', content: 'Hi' }],
      modelOverride: 'openai/gpt-5-mini',
      tools: ['summarize'],
      automationEnabled: true,
    })

    const context = mockCompleteSimple.mock.calls[0]?.[1] as { tools?: Tool[] }
    expect(context.tools?.some((tool) => tool.name === 'summarize')).toBe(true)
  })

  it('exposes artifacts tool definitions when automation is enabled', async () => {
    const home = makeTempHome()
    await completeAgentResponse({
      env: { HOME: home, OPENAI_API_KEY: 'sk-openai' },
      pageUrl: 'https://example.com',
      pageTitle: null,
      pageContent: 'Hello world',
      messages: [{ role: 'user', content: 'Hi' }],
      modelOverride: 'openai/gpt-5-mini',
      tools: ['artifacts'],
      automationEnabled: true,
    })

    const context = mockCompleteSimple.mock.calls[0]?.[1] as { tools?: Tool[] }
    expect(context.tools?.some((tool) => tool.name === 'artifacts')).toBe(true)
  })

  it('navigate tool exposes listTabs and switchToTab parameters', async () => {
    const home = makeTempHome()
    await completeAgentResponse({
      env: { HOME: home, OPENAI_API_KEY: 'sk-openai' },
      pageUrl: 'https://example.com',
      pageTitle: null,
      pageContent: 'Hello world',
      messages: [{ role: 'user', content: 'Hi' }],
      modelOverride: 'openai/gpt-5-mini',
      tools: ['navigate'],
      automationEnabled: true,
    })

    const context = mockCompleteSimple.mock.calls[0]?.[1] as { tools?: Tool[] }
    const navigate = context.tools?.find((tool) => tool.name === 'navigate')
    const properties = (navigate?.parameters as { properties?: Record<string, unknown> })
      ?.properties
    expect(properties && 'listTabs' in properties).toBe(true)
    expect(properties && 'switchToTab' in properties).toBe(true)
  })

  it('accepts legacy OpenRouter env mapping for auto fallback attempts', async () => {
    const home = makeTempHome()
    const autoSpy = vi.spyOn(modelAuto, 'buildAutoModelAttempts').mockReturnValue([
      {
        transport: 'openrouter',
        userModelId: 'openrouter/openai/gpt-5-mini',
        llmModelId: 'openai/openai/gpt-5-mini',
        openrouterProviders: null,
        forceOpenRouter: true,
        requiredEnv: 'OPENROUTER_API_KEY',
        debug: 'test',
      },
    ])

    try {
      await completeAgentResponse({
        env: {
          HOME: home,
          OPENAI_BASE_URL: 'https://openrouter.ai/api/v1',
          OPENAI_API_KEY: 'sk-openrouter-via-openai',
        },
        pageUrl: 'https://example.com',
        pageTitle: null,
        pageContent: 'Hello world',
        messages: [{ role: 'user', content: 'Hi' }],
        modelOverride: null,
        tools: [],
        automationEnabled: false,
      })

      const options = mockCompleteSimple.mock.calls[0]?.[2] as { apiKey?: string }
      expect(options.apiKey).toBe('sk-openrouter-via-openai')
    } finally {
      autoSpy.mockRestore()
    }
  })
})
