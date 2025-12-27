import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { loadSummarizeConfig } from '../src/config.js'
import { resolveEnvState } from '../src/run/run-env.js'

const writeJsonConfig = (value: unknown) => {
  const root = mkdtempSync(join(tmpdir(), 'summarize-config-'))
  const configDir = join(root, '.summarize')
  mkdirSync(configDir, { recursive: true })
  const configPath = join(configDir, 'config.json')
  writeFileSync(configPath, JSON.stringify(value), 'utf8')
  return { root, configPath }
}

describe('config baseUrl flows to EnvState', () => {
  it('anthropic.baseUrl from config flows to providerBaseUrls', () => {
    const { root } = writeJsonConfig({
      anthropic: { baseUrl: 'https://anthropic-proxy.example.com' },
    })

    const { config } = loadSummarizeConfig({ env: { HOME: root } })
    const envState = resolveEnvState({
      env: { HOME: root },
      envForRun: {},
      configForCli: config,
    })

    expect(envState.providerBaseUrls.anthropic).toBe('https://anthropic-proxy.example.com')
  })

  it('google.baseUrl from config flows to providerBaseUrls', () => {
    const { root } = writeJsonConfig({
      google: { baseUrl: 'https://google-proxy.example.com' },
    })

    const { config } = loadSummarizeConfig({ env: { HOME: root } })
    const envState = resolveEnvState({
      env: { HOME: root },
      envForRun: {},
      configForCli: config,
    })

    expect(envState.providerBaseUrls.google).toBe('https://google-proxy.example.com')
  })

  it('xai.baseUrl from config flows to providerBaseUrls', () => {
    const { root } = writeJsonConfig({
      xai: { baseUrl: 'https://xai-proxy.example.com' },
    })

    const { config } = loadSummarizeConfig({ env: { HOME: root } })
    const envState = resolveEnvState({
      env: { HOME: root },
      envForRun: {},
      configForCli: config,
    })

    expect(envState.providerBaseUrls.xai).toBe('https://xai-proxy.example.com')
  })

  it('openai.baseUrl from config flows to providerBaseUrls', () => {
    const { root } = writeJsonConfig({
      openai: { baseUrl: 'https://openai-proxy.example.com' },
    })

    const { config } = loadSummarizeConfig({ env: { HOME: root } })
    const envState = resolveEnvState({
      env: { HOME: root },
      envForRun: {},
      configForCli: config,
    })

    expect(envState.providerBaseUrls.openai).toBe('https://openai-proxy.example.com')
  })

  it('env vars take precedence over config for all providers', () => {
    const { root } = writeJsonConfig({
      openai: { baseUrl: 'https://config-openai.example.com' },
      anthropic: { baseUrl: 'https://config-anthropic.example.com' },
      google: { baseUrl: 'https://config-google.example.com' },
      xai: { baseUrl: 'https://config-xai.example.com' },
    })

    const { config } = loadSummarizeConfig({ env: { HOME: root } })
    const envState = resolveEnvState({
      env: { HOME: root },
      envForRun: {
        OPENAI_BASE_URL: 'https://env-openai.example.com',
        ANTHROPIC_BASE_URL: 'https://env-anthropic.example.com',
        GOOGLE_BASE_URL: 'https://env-google.example.com',
        XAI_BASE_URL: 'https://env-xai.example.com',
      },
      configForCli: config,
    })

    expect(envState.providerBaseUrls.openai).toBe('https://env-openai.example.com')
    expect(envState.providerBaseUrls.anthropic).toBe('https://env-anthropic.example.com')
    expect(envState.providerBaseUrls.google).toBe('https://env-google.example.com')
    expect(envState.providerBaseUrls.xai).toBe('https://env-xai.example.com')
  })
})
