import { describe, expect, it, vi } from 'vitest'

import { generateTextWithModelId } from '../src/llm/generate-text.js'

describe('provider baseUrl passthrough', () => {
  it('passes anthropicBaseUrlOverride to Anthropic client', async () => {
    const customBaseUrl = 'https://my-anthropic-proxy.example.com'
    const capturedUrls: string[] = []

    const mockFetch = vi.fn(async (url: string | URL | Request) => {
      const urlStr = typeof url === 'string' ? url : url instanceof URL ? url.href : url.url
      capturedUrls.push(urlStr)
      // Return a mock error response to end the request quickly
      return new Response(JSON.stringify({ error: { message: 'test' } }), {
        status: 401,
        headers: { 'content-type': 'application/json' },
      })
    }) as unknown as typeof fetch

    try {
      await generateTextWithModelId({
        modelId: 'anthropic/claude-sonnet-4-20250514',
        apiKeys: {
          xaiApiKey: null,
          openaiApiKey: null,
          googleApiKey: null,
          anthropicApiKey: 'test-key',
          openrouterApiKey: null,
        },
        prompt: 'test prompt',
        timeoutMs: 5000,
        fetchImpl: mockFetch,
        anthropicBaseUrlOverride: customBaseUrl,
      })
    } catch {
      // Expected to fail due to mock response
    }

    expect(capturedUrls.length).toBeGreaterThan(0)
    expect(capturedUrls[0]).toContain(customBaseUrl)
  })

  it('passes googleBaseUrlOverride to Google client', async () => {
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
      await generateTextWithModelId({
        modelId: 'google/gemini-2.0-flash',
        apiKeys: {
          xaiApiKey: null,
          openaiApiKey: null,
          googleApiKey: 'test-key',
          anthropicApiKey: null,
          openrouterApiKey: null,
        },
        prompt: 'test prompt',
        timeoutMs: 5000,
        fetchImpl: mockFetch,
        googleBaseUrlOverride: customBaseUrl,
      })
    } catch {
      // Expected to fail due to mock response
    }

    expect(capturedUrls.length).toBeGreaterThan(0)
    expect(capturedUrls[0]).toContain(customBaseUrl)
  })

  it('passes xaiBaseUrlOverride to xAI client', async () => {
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
      await generateTextWithModelId({
        modelId: 'xai/grok-3',
        apiKeys: {
          xaiApiKey: 'test-key',
          openaiApiKey: null,
          googleApiKey: null,
          anthropicApiKey: null,
          openrouterApiKey: null,
        },
        prompt: 'test prompt',
        timeoutMs: 5000,
        fetchImpl: mockFetch,
        xaiBaseUrlOverride: customBaseUrl,
      })
    } catch {
      // Expected to fail due to mock response
    }

    expect(capturedUrls.length).toBeGreaterThan(0)
    expect(capturedUrls[0]).toContain(customBaseUrl)
  })
})
