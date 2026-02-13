import { describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  resolveTranscriptForLink: vi.fn(async () => ({
    text: null,
    source: null,
    metadata: null,
    diagnostics: {
      cacheMode: 'default',
      cacheStatus: 'miss',
      textProvided: false,
      provider: null,
      attemptedProviders: [],
      notes: null,
    },
  })),
}))

vi.mock('../packages/core/src/content/transcript/index.js', () => ({
  resolveTranscriptForLink: mocks.resolveTranscriptForLink,
}))

import { fetchLinkContent } from '../packages/core/src/content/link-preview/content/index.js'

const buildDeps = (fetchImpl: typeof fetch) => ({
  fetch: fetchImpl,
  scrapeWithFirecrawl: null,
  apifyApiToken: null,
  ytDlpPath: null,
  groqApiKey: null,
  falApiKey: null,
  openaiApiKey: null,
  convertHtmlToMarkdown: null,
  transcriptCache: null,
  readTweetWithBird: null,
  resolveTwitterCookies: null,
  onProgress: null,
})

describe('link preview redirects', () => {
  it('uses the final URL for extraction and transcript resolution', async () => {
    mocks.resolveTranscriptForLink.mockClear()

    const html = '<html><head><title>Summarize</title></head><body>Hello</body></html>'
    const response = new Response(html, {
      status: 200,
      headers: { 'content-type': 'text/html' },
    })
    Object.defineProperty(response, 'url', {
      value: 'https://summarize.sh/',
      configurable: true,
    })

    const fetchMock = vi.fn(async () => response)

    const result = await fetchLinkContent(
      'https://t.co/abc',
      { format: 'text' },
      buildDeps(fetchMock as unknown as typeof fetch)
    )

    expect(result.url).toBe('https://summarize.sh/')
    expect(mocks.resolveTranscriptForLink).toHaveBeenCalledWith(
      'https://summarize.sh/',
      expect.any(String),
      expect.any(Object),
      expect.any(Object)
    )
  })
})
