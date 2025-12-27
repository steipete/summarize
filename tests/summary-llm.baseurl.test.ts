import { describe, expect, it, vi } from 'vitest'

import { summarizeWithModelId } from '../src/run/summary-llm.js'

describe('summarizeWithModelId baseUrl passthrough', () => {
  it('should accept and pass anthropicBaseUrlOverride to generateTextWithModelId', async () => {
    const customBaseUrl = 'https://my-anthropic-proxy.example.com'
    const capturedUrls: string[] = []

    const mockFetch = vi.fn(async (url: string | URL | Request) => {
      const urlStr = typeof url === 'string' ? url : url instanceof URL ? url.href : url.url
      capturedUrls.push(urlStr)
      return new Response(JSON.stringify({ error: { message: 'test' } }), {
        status: 401,
        headers: { 'content-type': 'application/json' },
      })
    }) as unknown as typeof fetch

    try {
      await summarizeWithModelId({
        modelId: 'anthropic/claude-sonnet-4-20250514',
        prompt: 'test prompt',
        timeoutMs: 5000,
        fetchImpl: mockFetch,
        apiKeys: {
          xaiApiKey: null,
          openaiApiKey: null,
          googleApiKey: null,
          anthropicApiKey: 'test-key',
          openrouterApiKey: null,
        },
        retries: 0,
        // This parameter should exist and be passed through
        anthropicBaseUrlOverride: customBaseUrl,
      })
    } catch {
      // Expected to fail due to mock response
    }

    expect(capturedUrls.length).toBeGreaterThan(0)
    // The URL should use the custom base URL
    expect(capturedUrls[0]).toContain('my-anthropic-proxy.example.com')
  })

  it('should accept and pass googleBaseUrlOverride to generateTextWithModelId', async () => {
    const customBaseUrl = 'https://my-google-proxy.example.com'
    const capturedUrls: string[] = []

    const mockFetch = vi.fn(async (url: string | URL | Request) => {
      const urlStr = typeof url === 'string' ? url : url instanceof URL ? url.href : url.url
      capturedUrls.push(urlStr)
      return new Response(JSON.stringify({ error: { message: 'test' } }), {
        status: 401,
        headers: { 'content-type': 'application/json' },
      })
    }) as unknown as typeof fetch

    try {
      await summarizeWithModelId({
        modelId: 'google/gemini-2.0-flash',
        prompt: 'test prompt',
        timeoutMs: 5000,
        fetchImpl: mockFetch,
        apiKeys: {
          xaiApiKey: null,
          openaiApiKey: null,
          googleApiKey: 'test-key',
          anthropicApiKey: null,
          openrouterApiKey: null,
        },
        retries: 0,
        googleBaseUrlOverride: customBaseUrl,
      })
    } catch {
      // Expected to fail
    }

    expect(capturedUrls.length).toBeGreaterThan(0)
    expect(capturedUrls[0]).toContain('my-google-proxy.example.com')
  })

  it('should accept and pass xaiBaseUrlOverride to generateTextWithModelId', async () => {
    const customBaseUrl = 'https://my-xai-proxy.example.com'
    const capturedUrls: string[] = []

    const mockFetch = vi.fn(async (url: string | URL | Request) => {
      const urlStr = typeof url === 'string' ? url : url instanceof URL ? url.href : url.url
      capturedUrls.push(urlStr)
      return new Response(JSON.stringify({ error: { message: 'test' } }), {
        status: 401,
        headers: { 'content-type': 'application/json' },
      })
    }) as unknown as typeof fetch

    try {
      await summarizeWithModelId({
        modelId: 'xai/grok-3',
        prompt: 'test prompt',
        timeoutMs: 5000,
        fetchImpl: mockFetch,
        apiKeys: {
          xaiApiKey: 'test-key',
          openaiApiKey: null,
          googleApiKey: null,
          anthropicApiKey: null,
          openrouterApiKey: null,
        },
        retries: 0,
        xaiBaseUrlOverride: customBaseUrl,
      })
    } catch {
      // Expected to fail
    }

    expect(capturedUrls.length).toBeGreaterThan(0)
    expect(capturedUrls[0]).toContain('my-xai-proxy.example.com')
  })
})
