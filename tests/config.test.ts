import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { loadSummarizeConfig } from '../src/config.js'

describe('config loading', () => {
  it('loads ~/.config/summarize/config.json by default', () => {
    const root = mkdtempSync(join(tmpdir(), 'summarize-config-'))
    const configDir = join(root, '.config', 'summarize')
    mkdirSync(configDir, { recursive: true })
    const configPath = join(configDir, 'config.json')
    writeFileSync(configPath, JSON.stringify({ model: 'openai/gpt-5.2' }), 'utf8')

    const result = loadSummarizeConfig({ env: { HOME: root }, configPathArg: null })
    expect(result.path).toBe(configPath)
    expect(result.config).toEqual({ model: 'openai/gpt-5.2' })
  })

  it('respects SUMMARIZE_CONFIG over the default path', () => {
    const root = mkdtempSync(join(tmpdir(), 'summarize-config-'))
    const configPath = join(root, 'custom.json')
    writeFileSync(configPath, JSON.stringify({ model: 'google/gemini-2.0-flash' }), 'utf8')

    const result = loadSummarizeConfig({
      env: { SUMMARIZE_CONFIG: configPath },
      configPathArg: null,
    })
    expect(result.path).toBe(configPath)
    expect(result.config).toEqual({ model: 'google/gemini-2.0-flash' })
  })

  it('lets --config override SUMMARIZE_CONFIG', () => {
    const root = mkdtempSync(join(tmpdir(), 'summarize-config-'))
    const fromEnv = join(root, 'env.json')
    const fromArg = join(root, 'arg.json')
    writeFileSync(fromEnv, JSON.stringify({ model: 'openai/gpt-5.2' }), 'utf8')
    writeFileSync(fromArg, JSON.stringify({ model: 'xai/grok-4-fast-non-reasoning' }), 'utf8')

    const result = loadSummarizeConfig({
      env: { SUMMARIZE_CONFIG: fromEnv },
      configPathArg: fromArg,
    })
    expect(result.path).toBe(fromArg)
    expect(result.config).toEqual({ model: 'xai/grok-4-fast-non-reasoning' })
  })
})
