import { describe, expect, it, vi } from 'vitest'

const generateTextWithModelIdMock = vi.fn(async () => ({
  text: '# Formatted Transcript\n\nThis is a well-structured transcript.',
  canonicalModelId: 'openai/gpt-5.2',
  provider: 'openai',
}))

vi.mock('../src/llm/generate-text.js', () => ({
  generateTextWithModelId: generateTextWithModelIdMock,
}))

describe('Transcript→Markdown converter', async () => {
  const { createTranscriptToMarkdownConverter } = await import(
    '../src/llm/transcript-to-markdown.js'
  )

  it('passes system + prompt to generateTextWithModelId', async () => {
    generateTextWithModelIdMock.mockClear()

    const converter = createTranscriptToMarkdownConverter({
      modelId: 'openai/gpt-5.2',
      xaiApiKey: null,
      googleApiKey: null,
      openaiApiKey: 'test',
      anthropicApiKey: null,
      openrouterApiKey: null,
      fetchImpl: globalThis.fetch.bind(globalThis),
    })

    const result = await converter({
      title: 'How to Speak',
      source: 'YouTube',
      transcript: 'SPEAKER: Hello everyone. Um, today we will talk about speaking.',
      timeoutMs: 2000,
    })

    expect(result).toBe('# Formatted Transcript\n\nThis is a well-structured transcript.')
    expect(generateTextWithModelIdMock).toHaveBeenCalledTimes(1)
    const args = generateTextWithModelIdMock.mock.calls[0]?.[0] as {
      system?: string
      prompt: string
      modelId: string
    }
    expect(args.modelId).toBe('openai/gpt-5.2')
    expect(args.system).toContain('You convert raw transcripts')
    expect(args.system).toContain('filler words')
    expect(args.prompt).toContain('Title: How to Speak')
    expect(args.prompt).toContain('Source: YouTube')
    expect(args.prompt).toContain('Hello everyone')
  })

  it('handles null title and source gracefully', async () => {
    generateTextWithModelIdMock.mockClear()

    const converter = createTranscriptToMarkdownConverter({
      modelId: 'openai/gpt-5.2',
      xaiApiKey: null,
      googleApiKey: null,
      openaiApiKey: 'test',
      anthropicApiKey: null,
      openrouterApiKey: null,
      fetchImpl: globalThis.fetch.bind(globalThis),
    })

    await converter({
      title: null,
      source: null,
      transcript: 'Some transcript content',
      timeoutMs: 2000,
    })

    const args = generateTextWithModelIdMock.mock.calls[0]?.[0] as { prompt: string }
    expect(args.prompt).toContain('Title: unknown')
    expect(args.prompt).toContain('Source: unknown')
  })

  it('truncates very large transcript inputs', async () => {
    generateTextWithModelIdMock.mockClear()

    const converter = createTranscriptToMarkdownConverter({
      modelId: 'openai/gpt-5.2',
      xaiApiKey: null,
      googleApiKey: null,
      openaiApiKey: 'test',
      anthropicApiKey: null,
      openrouterApiKey: null,
      fetchImpl: globalThis.fetch.bind(globalThis),
    })

    const transcript = `${'A'.repeat(200_005)}MARKER`
    await converter({
      title: 'Test',
      source: 'Test',
      transcript,
      timeoutMs: 2000,
    })

    const args = generateTextWithModelIdMock.mock.calls[0]?.[0] as { prompt: string }
    expect(args.prompt).not.toContain('MARKER')
  })

  it('calls onUsage callback with model info', async () => {
    generateTextWithModelIdMock.mockClear()

    const onUsageMock = vi.fn()

    const converter = createTranscriptToMarkdownConverter({
      modelId: 'openai/gpt-5.2',
      xaiApiKey: null,
      googleApiKey: null,
      openaiApiKey: 'test',
      anthropicApiKey: null,
      openrouterApiKey: null,
      fetchImpl: globalThis.fetch.bind(globalThis),
      onUsage: onUsageMock,
    })

    await converter({
      title: 'Test',
      source: 'Test',
      transcript: 'Test transcript',
      timeoutMs: 2000,
    })

    expect(onUsageMock).toHaveBeenCalledTimes(1)
    expect(onUsageMock).toHaveBeenCalledWith({
      model: 'openai/gpt-5.2',
      provider: 'openai',
      usage: undefined,
    })
  })

  it('works with OpenRouter API key', async () => {
    generateTextWithModelIdMock.mockClear()

    const converter = createTranscriptToMarkdownConverter({
      modelId: 'openrouter/anthropic/claude-3-haiku',
      forceOpenRouter: true,
      xaiApiKey: null,
      googleApiKey: null,
      openaiApiKey: null,
      anthropicApiKey: null,
      openrouterApiKey: 'test-openrouter-key',
      fetchImpl: globalThis.fetch.bind(globalThis),
    })

    await converter({
      title: 'Test',
      source: 'Test',
      transcript: 'Test transcript',
      timeoutMs: 2000,
    })

    expect(generateTextWithModelIdMock).toHaveBeenCalledTimes(1)
    const args = generateTextWithModelIdMock.mock.calls[0]?.[0] as {
      modelId: string
      forceOpenRouter?: boolean
    }
    expect(args.modelId).toBe('openrouter/anthropic/claude-3-haiku')
    expect(args.forceOpenRouter).toBe(true)
  })
})
