import { describe, expect, it } from 'vitest'

import { resolveEnvState } from '../src/run/run-env.js'

describe('provider baseUrl env vars', () => {
  it('reads OPENAI_BASE_URL env var', () => {
    const result = resolveEnvState({
      env: {},
      envForRun: { OPENAI_BASE_URL: 'https://openai-proxy.example.com/v1' },
      configForCli: null,
    })
    expect(result.providerBaseUrls.openai).toBe('https://openai-proxy.example.com/v1')
  })

  it('reads ANTHROPIC_BASE_URL env var', () => {
    const result = resolveEnvState({
      env: {},
      envForRun: { ANTHROPIC_BASE_URL: 'https://anthropic-proxy.example.com' },
      configForCli: null,
    })
    expect(result.providerBaseUrls.anthropic).toBe('https://anthropic-proxy.example.com')
  })

  it('reads GOOGLE_BASE_URL env var', () => {
    const result = resolveEnvState({
      env: {},
      envForRun: { GOOGLE_BASE_URL: 'https://google-proxy.example.com' },
      configForCli: null,
    })
    expect(result.providerBaseUrls.google).toBe('https://google-proxy.example.com')
  })

  it('reads GEMINI_BASE_URL as fallback for google', () => {
    const result = resolveEnvState({
      env: {},
      envForRun: { GEMINI_BASE_URL: 'https://gemini-proxy.example.com' },
      configForCli: null,
    })
    expect(result.providerBaseUrls.google).toBe('https://gemini-proxy.example.com')
  })

  it('prefers GOOGLE_BASE_URL over GEMINI_BASE_URL', () => {
    const result = resolveEnvState({
      env: {},
      envForRun: {
        GOOGLE_BASE_URL: 'https://google-proxy.example.com',
        GEMINI_BASE_URL: 'https://gemini-proxy.example.com',
      },
      configForCli: null,
    })
    expect(result.providerBaseUrls.google).toBe('https://google-proxy.example.com')
  })

  it('reads XAI_BASE_URL env var', () => {
    const result = resolveEnvState({
      env: {},
      envForRun: { XAI_BASE_URL: 'https://xai-proxy.example.com' },
      configForCli: null,
    })
    expect(result.providerBaseUrls.xai).toBe('https://xai-proxy.example.com')
  })

  it('env vars take precedence over config', () => {
    const result = resolveEnvState({
      env: {},
      envForRun: {
        OPENAI_BASE_URL: 'https://env-openai.example.com',
        ANTHROPIC_BASE_URL: 'https://env-anthropic.example.com',
        GOOGLE_BASE_URL: 'https://env-google.example.com',
        XAI_BASE_URL: 'https://env-xai.example.com',
      },
      configForCli: {
        openai: { baseUrl: 'https://config-openai.example.com' },
        anthropic: { baseUrl: 'https://config-anthropic.example.com' },
        google: { baseUrl: 'https://config-google.example.com' },
        xai: { baseUrl: 'https://config-xai.example.com' },
      },
    })
    expect(result.providerBaseUrls).toEqual({
      openai: 'https://env-openai.example.com',
      anthropic: 'https://env-anthropic.example.com',
      google: 'https://env-google.example.com',
      xai: 'https://env-xai.example.com',
    })
  })

  it('falls back to config when env vars are absent', () => {
    const result = resolveEnvState({
      env: {},
      envForRun: {},
      configForCli: {
        openai: { baseUrl: 'https://config-openai.example.com' },
        anthropic: { baseUrl: 'https://config-anthropic.example.com' },
        google: { baseUrl: 'https://config-google.example.com' },
        xai: { baseUrl: 'https://config-xai.example.com' },
      },
    })
    expect(result.providerBaseUrls).toEqual({
      openai: 'https://config-openai.example.com',
      anthropic: 'https://config-anthropic.example.com',
      google: 'https://config-google.example.com',
      xai: 'https://config-xai.example.com',
    })
  })

  it('trims env var values', () => {
    const result = resolveEnvState({
      env: {},
      envForRun: {
        OPENAI_BASE_URL: '  https://openai-proxy.example.com  ',
        ANTHROPIC_BASE_URL: '  https://anthropic-proxy.example.com  ',
      },
      configForCli: null,
    })
    expect(result.providerBaseUrls.openai).toBe('https://openai-proxy.example.com')
    expect(result.providerBaseUrls.anthropic).toBe('https://anthropic-proxy.example.com')
  })

  it('returns null for providers without config or env vars', () => {
    const result = resolveEnvState({
      env: {},
      envForRun: {},
      configForCli: null,
    })
    expect(result.providerBaseUrls).toEqual({
      openai: null,
      anthropic: null,
      google: null,
      xai: null,
    })
  })

  it('handles empty env var strings as absent', () => {
    const result = resolveEnvState({
      env: {},
      envForRun: {
        OPENAI_BASE_URL: '',
        ANTHROPIC_BASE_URL: '   ',
      },
      configForCli: {
        openai: { baseUrl: 'https://config-openai.example.com' },
        anthropic: { baseUrl: 'https://config-anthropic.example.com' },
      },
    })
    // Empty strings should fall back to config
    expect(result.providerBaseUrls.openai).toBe('https://config-openai.example.com')
    expect(result.providerBaseUrls.anthropic).toBe('https://config-anthropic.example.com')
  })
})
