import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { loadSummarizeConfig } from '../src/config.js'

const writeConfig = (raw: string) => {
  const root = mkdtempSync(join(tmpdir(), 'summarize-config-'))
  const configDir = join(root, '.summarize')
  mkdirSync(configDir, { recursive: true })
  const configPath = join(configDir, 'config.json')
  writeFileSync(configPath, raw, 'utf8')
  return { root, configPath }
}

const writeJsonConfig = (value: unknown) => writeConfig(JSON.stringify(value))

describe('provider baseUrl config', () => {
  it('parses openai.baseUrl', () => {
    const { root } = writeJsonConfig({
      model: { id: 'openai/gpt-5-mini' },
      openai: { baseUrl: 'https://my-openai-proxy.example.com/v1' },
    })
    const result = loadSummarizeConfig({ env: { HOME: root } })
    expect(result.config).toEqual({
      model: { id: 'openai/gpt-5-mini' },
      openai: { baseUrl: 'https://my-openai-proxy.example.com/v1' },
    })
  })

  it('parses openai.baseUrl with useChatCompletions', () => {
    const { root } = writeJsonConfig({
      model: { id: 'openai/gpt-5-mini' },
      openai: {
        baseUrl: 'https://my-openai-proxy.example.com/v1',
        useChatCompletions: true,
      },
    })
    const result = loadSummarizeConfig({ env: { HOME: root } })
    expect(result.config).toEqual({
      model: { id: 'openai/gpt-5-mini' },
      openai: {
        baseUrl: 'https://my-openai-proxy.example.com/v1',
        useChatCompletions: true,
      },
    })
  })

  it('parses anthropic.baseUrl', () => {
    const { root } = writeJsonConfig({
      model: { id: 'anthropic/claude-sonnet-4-20250514' },
      anthropic: { baseUrl: 'https://my-anthropic-proxy.example.com' },
    })
    const result = loadSummarizeConfig({ env: { HOME: root } })
    expect(result.config).toEqual({
      model: { id: 'anthropic/claude-sonnet-4-20250514' },
      anthropic: { baseUrl: 'https://my-anthropic-proxy.example.com' },
    })
  })

  it('parses google.baseUrl', () => {
    const { root } = writeJsonConfig({
      model: { id: 'google/gemini-2.0-flash' },
      google: { baseUrl: 'https://my-google-proxy.example.com' },
    })
    const result = loadSummarizeConfig({ env: { HOME: root } })
    expect(result.config).toEqual({
      model: { id: 'google/gemini-2.0-flash' },
      google: { baseUrl: 'https://my-google-proxy.example.com' },
    })
  })

  it('parses xai.baseUrl', () => {
    const { root } = writeJsonConfig({
      model: { id: 'xai/grok-3' },
      xai: { baseUrl: 'https://my-xai-proxy.example.com' },
    })
    const result = loadSummarizeConfig({ env: { HOME: root } })
    expect(result.config).toEqual({
      model: { id: 'xai/grok-3' },
      xai: { baseUrl: 'https://my-xai-proxy.example.com' },
    })
  })

  it('parses multiple provider baseUrls', () => {
    const { root } = writeJsonConfig({
      model: 'auto',
      openai: { baseUrl: 'https://openai-proxy.example.com/v1' },
      anthropic: { baseUrl: 'https://anthropic-proxy.example.com' },
      google: { baseUrl: 'https://google-proxy.example.com' },
      xai: { baseUrl: 'https://xai-proxy.example.com' },
    })
    const result = loadSummarizeConfig({ env: { HOME: root } })
    expect(result.config).toEqual({
      model: { mode: 'auto' },
      openai: { baseUrl: 'https://openai-proxy.example.com/v1' },
      anthropic: { baseUrl: 'https://anthropic-proxy.example.com' },
      google: { baseUrl: 'https://google-proxy.example.com' },
      xai: { baseUrl: 'https://xai-proxy.example.com' },
    })
  })

  it('rejects non-object anthropic config', () => {
    const { root } = writeJsonConfig({ anthropic: 'nope' })
    expect(() => loadSummarizeConfig({ env: { HOME: root } })).toThrow(
      /"anthropic" must be an object/i
    )
  })

  it('rejects non-object google config', () => {
    const { root } = writeJsonConfig({ google: 123 })
    expect(() => loadSummarizeConfig({ env: { HOME: root } })).toThrow(
      /"google" must be an object/i
    )
  })

  it('rejects non-object xai config', () => {
    const { root } = writeJsonConfig({ xai: [] })
    expect(() => loadSummarizeConfig({ env: { HOME: root } })).toThrow(/"xai" must be an object/i)
  })

  it('rejects empty baseUrl strings', () => {
    const { root: root1 } = writeJsonConfig({ openai: { baseUrl: '   ' } })
    expect(loadSummarizeConfig({ env: { HOME: root1 } }).config).toEqual({})

    const { root: root2 } = writeJsonConfig({ anthropic: { baseUrl: '' } })
    expect(loadSummarizeConfig({ env: { HOME: root2 } }).config).toEqual({})
  })

  it('trims baseUrl strings', () => {
    const { root } = writeJsonConfig({
      openai: { baseUrl: '  https://example.com/v1  ' },
    })
    const result = loadSummarizeConfig({ env: { HOME: root } })
    expect(result.config).toEqual({
      openai: { baseUrl: 'https://example.com/v1' },
    })
  })

  it('ignores non-string baseUrl values', () => {
    const { root } = writeJsonConfig({
      openai: { baseUrl: 123 },
      anthropic: { baseUrl: true },
    })
    const result = loadSummarizeConfig({ env: { HOME: root } })
    expect(result.config).toEqual({})
  })
})
