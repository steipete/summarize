import { describe, expect, it } from 'vitest'

import { resolveRunOverrides } from '../src/run/run-settings.js'

describe('run/run-settings overrides', () => {
  it('parses mode overrides when valid', () => {
    const overrides = resolveRunOverrides({
      firecrawl: 'always',
      markdownMode: 'llm',
      preprocess: 'auto',
      youtube: 'no-auto',
    })
    expect(overrides.firecrawlMode).toBe('always')
    expect(overrides.markdownMode).toBe('llm')
    expect(overrides.preprocessMode).toBe('auto')
    expect(overrides.youtubeMode).toBe('no-auto')
  })

  it('returns null for invalid modes', () => {
    const overrides = resolveRunOverrides({
      firecrawl: 'nope',
      markdownMode: 'markdown',
      preprocess: 'yes',
      youtube: 'v2',
    })
    expect(overrides.firecrawlMode).toBeNull()
    expect(overrides.markdownMode).toBeNull()
    expect(overrides.preprocessMode).toBeNull()
    expect(overrides.youtubeMode).toBeNull()
  })

  it('parses timeout, retries, and max output tokens', () => {
    const overrides = resolveRunOverrides({
      timeout: '90s',
      retries: '3',
      maxOutputTokens: '2k',
    })
    expect(overrides.timeoutMs).toBe(90_000)
    expect(overrides.retries).toBe(3)
    expect(overrides.maxOutputTokensArg).toBe(2000)

    const overridesNumeric = resolveRunOverrides({
      timeout: 15_000,
      retries: 2,
      maxOutputTokens: 512,
    })
    expect(overridesNumeric.timeoutMs).toBe(15_000)
    expect(overridesNumeric.retries).toBe(2)
    expect(overridesNumeric.maxOutputTokensArg).toBe(512)
  })

  it('parses timestamps override', () => {
    const overrides = resolveRunOverrides({ timestamps: 'yes' })
    expect(overrides.transcriptTimestamps).toBe(true)

    const overridesOff = resolveRunOverrides({ timestamps: 'off' })
    expect(overridesOff.transcriptTimestamps).toBe(false)
  })

  it('parses transcriber override', () => {
    const overrides = resolveRunOverrides({ transcriber: 'Parakeet ' })
    expect(overrides.transcriber).toBe('parakeet')

    const invalid = resolveRunOverrides({ transcriber: 'gpt-4o' })
    expect(invalid.transcriber).toBeNull()
  })
})
