import { describe, expect, it } from 'vitest'

import type { SummarizeConfig } from '../src/config.js'
import { buildAutoModelAttempts } from '../src/model-auto.js'

describe('auto model selection', () => {
  it('preserves candidate order (native then OpenRouter fallback)', () => {
    const config: SummarizeConfig = {
      model: {
        mode: 'auto',
        rules: [{ candidates: ['openai/gpt-5-mini', 'anthropic/claude-sonnet-4-5'] }],
      },
    }
    const attempts = buildAutoModelAttempts({
      kind: 'text',
      promptTokens: 100,
      desiredOutputTokens: 50,
      requiresVideoUnderstanding: false,
      env: { OPENROUTER_API_KEY: 'sk-or-test' },
      config,
      catalog: null,
      openrouterProvidersFromEnv: null,
    })

    expect(attempts[0]?.userModelId).toBe('openai/gpt-5-mini')
    expect(attempts[1]?.userModelId).toBe('openrouter/openai/gpt-5-mini')
    expect(attempts[2]?.userModelId).toBe('anthropic/claude-sonnet-4-5')
    expect(attempts[3]?.userModelId).toBe('openrouter/anthropic/claude-sonnet-4-5')
  })

  it('skips OpenRouter fallback for native-only models', () => {
    const config: SummarizeConfig = {
      model: {
        mode: 'auto',
        rules: [{ candidates: ['xai/grok-4-fast-non-reasoning', 'openai/gpt-5-mini'] }],
      },
    }
    const attempts = buildAutoModelAttempts({
      kind: 'text',
      promptTokens: 100,
      desiredOutputTokens: 50,
      requiresVideoUnderstanding: false,
      env: { OPENROUTER_API_KEY: 'sk-or-test' },
      config,
      catalog: null,
      openrouterProvidersFromEnv: null,
    })

    // xai/grok-4-fast-non-reasoning should have native attempt but NO OpenRouter fallback
    expect(attempts.some((a) => a.userModelId === 'xai/grok-4-fast-non-reasoning')).toBe(true)
    expect(attempts.some((a) => a.userModelId === 'openrouter/xai/grok-4-fast-non-reasoning')).toBe(false)
    // openai/gpt-5-mini should have both native and OpenRouter fallback
    expect(attempts.some((a) => a.userModelId === 'openai/gpt-5-mini')).toBe(true)
    expect(attempts.some((a) => a.userModelId === 'openrouter/openai/gpt-5-mini')).toBe(true)
  })

  it('adds an OpenRouter fallback attempt when OPENROUTER_API_KEY is set', () => {
    const config: SummarizeConfig = {
      model: { mode: 'auto', rules: [{ candidates: ['openai/gpt-5-mini'] }] },
    }
    const attempts = buildAutoModelAttempts({
      kind: 'text',
      promptTokens: 100,
      desiredOutputTokens: 50,
      requiresVideoUnderstanding: false,
      env: { OPENROUTER_API_KEY: 'sk-or-test' },
      config,
      catalog: null,
      openrouterProvidersFromEnv: ['groq'],
    })

    expect(attempts.some((a) => a.forceOpenRouter)).toBe(true)
    expect(attempts.some((a) => a.userModelId === 'openai/gpt-5-mini')).toBe(true)
    expect(attempts.some((a) => a.userModelId === 'openrouter/openai/gpt-5-mini')).toBe(true)
  })

  it('does not add an OpenRouter fallback when video understanding is required', () => {
    const config: SummarizeConfig = {
      model: { mode: 'auto', rules: [{ candidates: ['google/gemini-3-flash-preview'] }] },
    }
    const attempts = buildAutoModelAttempts({
      kind: 'video',
      promptTokens: 100,
      desiredOutputTokens: 50,
      requiresVideoUnderstanding: true,
      env: { OPENROUTER_API_KEY: 'sk-or-test' },
      config,
      catalog: null,
      openrouterProvidersFromEnv: ['groq'],
    })

    expect(attempts.every((a) => a.forceOpenRouter === false)).toBe(true)
  })

  it('respects explicit openrouter/... candidates (no native attempt)', () => {
    const config: SummarizeConfig = {
      model: { mode: 'auto', rules: [{ candidates: ['openrouter/openai/gpt-5-nano'] }] },
    }
    const attempts = buildAutoModelAttempts({
      kind: 'text',
      promptTokens: 100,
      desiredOutputTokens: 50,
      requiresVideoUnderstanding: false,
      env: { OPENROUTER_API_KEY: 'sk-or-test' },
      config,
      catalog: null,
      openrouterProvidersFromEnv: null,
    })

    expect(attempts.some((a) => a.userModelId === 'openrouter/openai/gpt-5-nano')).toBe(true)
    expect(attempts.some((a) => a.userModelId === 'openai/gpt-5-nano')).toBe(false)
  })

  it('treats OpenRouter model ids as opaque (meta-llama/... etc)', () => {
    const config: SummarizeConfig = {
      model: {
        mode: 'auto',
        rules: [{ candidates: ['openrouter/meta-llama/llama-3.3-70b-instruct:free'] }],
      },
    }
    const attempts = buildAutoModelAttempts({
      kind: 'text',
      promptTokens: 100,
      desiredOutputTokens: 50,
      requiresVideoUnderstanding: false,
      env: { OPENROUTER_API_KEY: 'sk-or-test' },
      config,
      catalog: null,
      openrouterProvidersFromEnv: null,
    })

    expect(attempts[0]?.userModelId).toBe('openrouter/meta-llama/llama-3.3-70b-instruct:free')
    expect(attempts[0]?.llmModelId).toBe('openai/meta-llama/llama-3.3-70b-instruct:free')
  })

  it('selects candidates via token bands (first match wins)', () => {
    const config: SummarizeConfig = {
      model: {
        mode: 'auto',
        rules: [
          {
            when: ['text'],
            bands: [
              { token: { max: 100 }, candidates: ['openai/gpt-5-nano'] },
              { token: { max: 1000 }, candidates: ['openai/gpt-5-mini'] },
              { candidates: ['xai/grok-4-fast-non-reasoning'] },
            ],
          },
        ],
      },
    }

    const attempts = buildAutoModelAttempts({
      kind: 'text',
      promptTokens: 200,
      desiredOutputTokens: 50,
      requiresVideoUnderstanding: false,
      env: {},
      config,
      catalog: null,
      openrouterProvidersFromEnv: null,
    })

    expect(attempts[0]?.userModelId).toBe('openai/gpt-5-mini')
  })

  it('filters candidates by LiteLLM max input tokens (skips too-small context)', () => {
    const config: SummarizeConfig = {
      model: {
        mode: 'auto',
        rules: [{ candidates: ['openai/gpt-5-nano', 'openai/gpt-5-mini'] }],
      },
    }

    const catalog = {
      'gpt-5-nano': { max_input_tokens: 10 },
      'gpt-5-mini': { max_input_tokens: 1000 },
    }

    const attempts = buildAutoModelAttempts({
      kind: 'text',
      promptTokens: 100,
      desiredOutputTokens: 50,
      requiresVideoUnderstanding: false,
      env: { OPENAI_API_KEY: 'test' },
      config,
      catalog,
      openrouterProvidersFromEnv: null,
    })

    expect(attempts[0]?.userModelId).toBe('openai/gpt-5-mini')
  })

  it('supports multi-kind "when" arrays', () => {
    const config: SummarizeConfig = {
      model: {
        mode: 'auto',
        rules: [
          { when: ['youtube', 'website'], candidates: ['openai/gpt-5-nano'] },
          { when: ['text'], candidates: ['openai/gpt-5-mini'] },
        ],
      },
    }

    const attemptsWebsite = buildAutoModelAttempts({
      kind: 'website',
      promptTokens: 100,
      desiredOutputTokens: 50,
      requiresVideoUnderstanding: false,
      env: { OPENAI_API_KEY: 'test' },
      config,
      catalog: null,
      openrouterProvidersFromEnv: null,
    })
    expect(attemptsWebsite[0]?.userModelId).toBe('openai/gpt-5-nano')

    const attemptsText = buildAutoModelAttempts({
      kind: 'text',
      promptTokens: 100,
      desiredOutputTokens: 50,
      requiresVideoUnderstanding: false,
      env: { OPENAI_API_KEY: 'test' },
      config,
      catalog: null,
      openrouterProvidersFromEnv: null,
    })
    expect(attemptsText[0]?.userModelId).toBe('openai/gpt-5-mini')
  })

  it('does not prepend CLI candidates unless enabled', () => {
    const attempts = buildAutoModelAttempts({
      kind: 'text',
      promptTokens: 100,
      desiredOutputTokens: 50,
      requiresVideoUnderstanding: false,
      env: {},
      config: null,
      catalog: null,
      openrouterProvidersFromEnv: null,
      cliAvailability: { claude: true, codex: true, gemini: true },
    })

    expect(attempts[0]?.userModelId).toBe('google/gemini-3-flash-preview')
  })

  it('prepends CLI candidates when enabled', () => {
    const config: SummarizeConfig = {
      cli: { enabled: ['claude', 'gemini', 'codex'] },
      model: { mode: 'auto', rules: [{ candidates: ['openai/gpt-5-mini'] }] },
    }
    const attempts = buildAutoModelAttempts({
      kind: 'text',
      promptTokens: 100,
      desiredOutputTokens: 50,
      requiresVideoUnderstanding: false,
      env: {},
      config,
      catalog: null,
      openrouterProvidersFromEnv: null,
      cliAvailability: { claude: true },
    })

    expect(attempts[0]?.userModelId).toBe('cli/claude/sonnet')
  })
})
