import { describe, expect, it } from 'vitest'

import { normalizeGatewayStyleModelId, parseGatewayStyleModelId } from '../src/llm/model-id.js'

describe('model id parsing', () => {
  it('normalizes gateway-style ids', () => {
    expect(normalizeGatewayStyleModelId('xai/grok-4-fast-non-reasoning')).toBe(
      'xai/grok-4-fast-non-reasoning'
    )
    expect(normalizeGatewayStyleModelId('openai/gpt-5.2')).toBe('openai/gpt-5.2')
    expect(normalizeGatewayStyleModelId('google/gemini-2.0-flash')).toBe('google/gemini-2.0-flash')
  })

  it('accepts historical grok aliases', () => {
    expect(normalizeGatewayStyleModelId('grok-4-1-fast-non-reasoning')).toBe(
      'xai/grok-4-fast-non-reasoning'
    )
    expect(normalizeGatewayStyleModelId('xai/grok-4-1-fast-non-reasoning')).toBe(
      'xai/grok-4-fast-non-reasoning'
    )
  })

  it('infers provider for bare model ids (best-effort)', () => {
    expect(normalizeGatewayStyleModelId('grok-4')).toBe('xai/grok-4')
    expect(normalizeGatewayStyleModelId('gemini-2.0-flash')).toBe('google/gemini-2.0-flash')
    expect(normalizeGatewayStyleModelId('gpt-5.2')).toBe('openai/gpt-5.2')
  })

  it('parses provider + model', () => {
    expect(parseGatewayStyleModelId('xai/grok-4-fast-non-reasoning')).toEqual({
      provider: 'xai',
      model: 'grok-4-fast-non-reasoning',
      canonical: 'xai/grok-4-fast-non-reasoning',
    })
  })
})
