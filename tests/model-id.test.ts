import { describe, expect, it } from 'vitest'

import { normalizeGatewayStyleModelId, parseGatewayStyleModelId } from '../src/llm/model-id.js'

describe('model id parsing', () => {
  it('normalizes gateway-style ids', () => {
    expect(normalizeGatewayStyleModelId('xai/grok-4-fast-non-reasoning')).toBe(
      'xai/grok-4-fast-non-reasoning'
    )
    expect(normalizeGatewayStyleModelId('openai/gpt-5.2')).toBe('openai/gpt-5.2')
    expect(normalizeGatewayStyleModelId('google/gemini-2.0-flash')).toBe('google/gemini-2.0-flash')
    expect(normalizeGatewayStyleModelId('anthropic/claude-sonnet-4-5')).toBe(
      'anthropic/claude-sonnet-4-5'
    )
  })

  it('resolves short Anthropic model aliases to versioned form', () => {
    // Bare alias without provider prefix
    expect(normalizeGatewayStyleModelId('claude-sonnet-4')).toBe('anthropic/claude-sonnet-4-0')
    // With provider prefix
    expect(normalizeGatewayStyleModelId('anthropic/claude-sonnet-4')).toBe(
      'anthropic/claude-sonnet-4-0'
    )
    // Case-insensitive
    expect(normalizeGatewayStyleModelId('Anthropic/Claude-Sonnet-4')).toBe(
      'anthropic/claude-sonnet-4-0'
    )
    // claude-opus-4 alias
    expect(normalizeGatewayStyleModelId('claude-opus-4')).toBe('anthropic/claude-opus-4-0')
    expect(normalizeGatewayStyleModelId('anthropic/claude-opus-4')).toBe(
      'anthropic/claude-opus-4-0'
    )
    // Full model ids must NOT be rewritten
    expect(normalizeGatewayStyleModelId('anthropic/claude-sonnet-4-20250514')).toBe(
      'anthropic/claude-sonnet-4-20250514'
    )
    expect(normalizeGatewayStyleModelId('anthropic/claude-sonnet-4-0')).toBe(
      'anthropic/claude-sonnet-4-0'
    )
    expect(normalizeGatewayStyleModelId('anthropic/claude-sonnet-4-5')).toBe(
      'anthropic/claude-sonnet-4-5'
    )
  })

  it('accepts historical grok aliases', () => {
    expect(normalizeGatewayStyleModelId('grok-4-1-fast-non-reasoning')).toBe(
      'xai/grok-4-fast-non-reasoning'
    )
    expect(normalizeGatewayStyleModelId('grok-4.1-fast-non-reasoning')).toBe(
      'xai/grok-4-fast-non-reasoning'
    )
    expect(normalizeGatewayStyleModelId('xai/grok-4-1-fast-non-reasoning')).toBe(
      'xai/grok-4-fast-non-reasoning'
    )
    expect(normalizeGatewayStyleModelId('xai/grok-4.1-fast-non-reasoning')).toBe(
      'xai/grok-4-fast-non-reasoning'
    )
  })

  it('normalizes casing', () => {
    expect(normalizeGatewayStyleModelId('GOOGLE/GEMINI-3-FLASH-PREVIEW')).toBe(
      'google/gemini-3-flash-preview'
    )
    expect(normalizeGatewayStyleModelId('GEMINI-2.0-FLASH')).toBe('google/gemini-2.0-flash')
    expect(normalizeGatewayStyleModelId('GPT-5.2')).toBe('openai/gpt-5.2')
    expect(normalizeGatewayStyleModelId('XAI/GROK-4-1-FAST-NON-REASONING')).toBe(
      'xai/grok-4-fast-non-reasoning'
    )
  })

  it('infers provider for bare model ids (best-effort)', () => {
    expect(normalizeGatewayStyleModelId('grok-4')).toBe('xai/grok-4')
    expect(normalizeGatewayStyleModelId('gemini-2.0-flash')).toBe('google/gemini-2.0-flash')
    expect(normalizeGatewayStyleModelId('gpt-5.2')).toBe('openai/gpt-5.2')
    expect(normalizeGatewayStyleModelId('claude-sonnet-4-5')).toBe('anthropic/claude-sonnet-4-5')
  })

  it('parses provider + model', () => {
    expect(parseGatewayStyleModelId('xai/grok-4-fast-non-reasoning')).toEqual({
      provider: 'xai',
      model: 'grok-4-fast-non-reasoning',
      canonical: 'xai/grok-4-fast-non-reasoning',
    })
  })

  it('rejects unsupported providers', () => {
    expect(() => normalizeGatewayStyleModelId('meta/llama-3')).toThrow(/Unsupported model provider/)
  })

  it('rejects missing model ids after provider prefix', () => {
    expect(() => normalizeGatewayStyleModelId('openai/')).toThrow(
      /Missing model id after provider prefix/
    )
  })

  it('rejects empty model ids', () => {
    expect(() => normalizeGatewayStyleModelId('   ')).toThrow(/Missing model id/)
  })
})
