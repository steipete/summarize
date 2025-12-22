import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { loadSummarizeConfig } from '../src/config.js'

describe('config loading', () => {
  it('loads ~/.summarize/config.json by default', () => {
    const root = mkdtempSync(join(tmpdir(), 'summarize-config-'))
    const configDir = join(root, '.summarize')
    mkdirSync(configDir, { recursive: true })
    const configPath = join(configDir, 'config.json')
    writeFileSync(configPath, JSON.stringify({ model: 'openai/gpt-5.2' }), 'utf8')

    const result = loadSummarizeConfig({ env: { HOME: root } })
    expect(result.path).toBe(configPath)
    expect(result.config).toEqual({ model: 'openai/gpt-5.2' })
  })

  it('supports simplified auto config shapes', () => {
    const root = mkdtempSync(join(tmpdir(), 'summarize-config-'))
    const configDir = join(root, '.summarize')
    mkdirSync(configDir, { recursive: true })
    const configPath = join(configDir, 'config.json')

    writeFileSync(
      configPath,
      JSON.stringify({
        model: 'auto',
        media: { videoMode: 'auto' },
        auto: [
          { when: 'video', candidates: ['google/gemini-3-flash-preview'] },
          {
            when: 'youtube, website',
            candidates: ['openai/gpt-5-nano', { model: 'xai/grok-4-fast-non-reasoning', openrouterProviders: ['groq'] }],
          },
          { candidates: ['openai/gpt-5-nano', 'openrouter/openai/gpt-5-nano'] },
        ],
      }),
      'utf8'
    )

    const result = loadSummarizeConfig({ env: { HOME: root } })
    expect(result.path).toBe(configPath)
    expect(result.config).toEqual({
      model: 'auto',
      media: { videoMode: 'auto' },
      auto: {
        rules: [
          { when: { kind: 'video' }, candidates: [{ model: 'google/gemini-3-flash-preview' }] },
          {
            when: { kind: 'youtube' },
            candidates: [
              { model: 'openai/gpt-5-nano' },
              { model: 'xai/grok-4-fast-non-reasoning', openrouterProviders: ['groq'] },
            ],
          },
          {
            when: { kind: 'website' },
            candidates: [
              { model: 'openai/gpt-5-nano' },
              { model: 'xai/grok-4-fast-non-reasoning', openrouterProviders: ['groq'] },
            ],
          },
          {
            candidates: [{ model: 'openai/gpt-5-nano' }, { model: 'openrouter/openai/gpt-5-nano' }],
          },
        ],
      },
    })
  })
})
