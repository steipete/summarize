import { describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  resolveTranscriptForLink: vi.fn(async () => ({
    text: 'Transcript text',
    source: 'embedded',
    metadata: null,
    diagnostics: {
      cacheMode: 'default',
      cacheStatus: 'miss',
      textProvided: true,
      provider: 'embedded',
      attemptedProviders: ['embedded'],
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

describe('link preview media transcript preference', () => {
  it('short-circuits to transcript for direct media URLs', async () => {
    mocks.resolveTranscriptForLink.mockClear()
    const fetchMock = vi.fn(async () => {
      throw new Error('HTML fetch should not occur for direct media')
    })

    const url = 'https://example.com/video.mp4'
    const result = await fetchLinkContent(
      url,
      { format: 'text', mediaTranscript: 'prefer' },
      buildDeps(fetchMock as unknown as typeof fetch)
    )

    expect(fetchMock).not.toHaveBeenCalled()
    expect(mocks.resolveTranscriptForLink).toHaveBeenCalled()
    expect(result.content).toContain('Transcript')
    expect(result.transcriptSource).toBe('embedded')
  })

  it('passes media transcript mode through for HTML pages', async () => {
    mocks.resolveTranscriptForLink.mockClear()
    const html = '<!doctype html><html><head><title>Ok</title></head><body>Hello</body></html>'
    const fetchMock = vi.fn(
      async () => new Response(html, { status: 200, headers: { 'content-type': 'text/html' } })
    )

    await fetchLinkContent(
      'https://example.com',
      { format: 'text', mediaTranscript: 'prefer' },
      buildDeps(fetchMock as unknown as typeof fetch)
    )

    expect(mocks.resolveTranscriptForLink).toHaveBeenCalledWith(
      'https://example.com',
      expect.any(String),
      expect.any(Object),
      expect.objectContaining({ mediaTranscriptMode: 'prefer' })
    )
  })
})
