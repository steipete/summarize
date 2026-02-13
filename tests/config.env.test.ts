import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { loadSummarizeConfig, mergeConfigEnv } from '../src/config.js'

const writeConfig = (raw: string) => {
  const root = mkdtempSync(join(tmpdir(), 'summarize-config-env-'))
  const configDir = join(root, '.summarize')
  mkdirSync(configDir, { recursive: true })
  const configPath = join(configDir, 'config.json')
  writeFileSync(configPath, raw, 'utf8')
  return { root, configPath }
}

const writeJsonConfig = (value: unknown) => writeConfig(JSON.stringify(value))

describe('config env', () => {
  it('loads env map from config', () => {
    const { root } = writeJsonConfig({
      env: {
        OPENAI_API_KEY: 'sk-config',
        CUSTOM_FLAG: 'enabled',
      },
    })

    const result = loadSummarizeConfig({ env: { HOME: root } })
    expect(result.config?.env).toEqual({
      OPENAI_API_KEY: 'sk-config',
      CUSTOM_FLAG: 'enabled',
    })
  })

  it('throws when env is not an object', () => {
    const { root } = writeJsonConfig({ env: 'nope' })
    expect(() => loadSummarizeConfig({ env: { HOME: root } })).toThrow(/"env" must be an object/i)
  })

  it('throws when env value is not a string', () => {
    const { root } = writeJsonConfig({ env: { OPENAI_API_KEY: 123 } })
    expect(() => loadSummarizeConfig({ env: { HOME: root } })).toThrow(
      /"env\.OPENAI_API_KEY" must be a string/i
    )
  })

  it('merges config env as fallback (existing env wins)', () => {
    const merged = mergeConfigEnv({
      env: {
        OPENAI_API_KEY: 'sk-shell',
        OTHER: '1',
      },
      config: {
        env: {
          OPENAI_API_KEY: 'sk-config',
          CUSTOM_FLAG: 'enabled',
        },
      },
    })

    expect(merged.OPENAI_API_KEY).toBe('sk-shell')
    expect(merged.CUSTOM_FLAG).toBe('enabled')
    expect(merged.OTHER).toBe('1')
  })

  it('uses config env when shell value is blank', () => {
    const merged = mergeConfigEnv({
      env: {
        OPENAI_API_KEY: '   ',
      },
      config: {
        env: {
          OPENAI_API_KEY: 'sk-config',
        },
      },
    })
    expect(merged.OPENAI_API_KEY).toBe('sk-config')
  })

  it('maps legacy apiKeys to environment variable names', () => {
    const merged = mergeConfigEnv({
      env: {},
      config: {
        apiKeys: {
          openai: 'sk-openai',
          openrouter: 'sk-openrouter',
          zai: 'sk-zai',
          apify: 'apify-token',
          fal: 'fal-key',
        },
      },
    })

    expect(merged.OPENAI_API_KEY).toBe('sk-openai')
    expect(merged.OPENROUTER_API_KEY).toBe('sk-openrouter')
    expect(merged.Z_AI_API_KEY).toBe('sk-zai')
    expect(merged.APIFY_API_TOKEN).toBe('apify-token')
    expect(merged.FAL_KEY).toBe('fal-key')
  })

  it('prefers explicit env map over legacy apiKeys', () => {
    const merged = mergeConfigEnv({
      env: {},
      config: {
        apiKeys: { openai: 'legacy-openai' },
        env: { OPENAI_API_KEY: 'explicit-openai' },
      },
    })

    expect(merged.OPENAI_API_KEY).toBe('explicit-openai')
  })
})
