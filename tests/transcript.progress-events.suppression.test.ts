import { describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  fetchYoutube: vi.fn(async () => ({
    text: null,
    source: null,
    attemptedProviders: [],
    metadata: null,
  })),
}))

vi.mock('../packages/core/src/content/transcript/providers/youtube.js', () => ({
  canHandle: (ctx: { url: string }) =>
    ctx.url.includes('youtube.com') || ctx.url.includes('youtu.be'),
  fetchTranscript: mocks.fetchYoutube,
}))

import { resolveTranscriptForLink } from '../packages/core/src/content/transcript/index.js'

describe('transcript progress events', () => {
  it('does not emit transcript-start/done for generic pages', async () => {
    const onProgress = vi.fn()
    await resolveTranscriptForLink(
      'https://example.com',
      '<!doctype html><html><body><article><p>Hello</p></article></body></html>',
      {
        fetch: vi.fn() as unknown as typeof fetch,
        scrapeWithFirecrawl: null,
        apifyApiToken: null,
        ytDlpPath: null,
        falApiKey: null,
        openaiApiKey: null,
        convertHtmlToMarkdown: null,
        transcriptCache: null,
        onProgress,
      }
    )
    expect(onProgress).not.toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'transcript-start' })
    )
    expect(onProgress).not.toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'transcript-done' })
    )
  })

  it('emits transcript-start/done for YouTube URLs', async () => {
    const onProgress = vi.fn()
    await resolveTranscriptForLink('https://www.youtube.com/watch?v=dQw4w9WgXcQ', null, {
      fetch: vi.fn() as unknown as typeof fetch,
      scrapeWithFirecrawl: null,
      apifyApiToken: null,
      ytDlpPath: null,
      falApiKey: null,
      openaiApiKey: null,
      convertHtmlToMarkdown: null,
      transcriptCache: null,
      onProgress,
    })
    expect(onProgress).toHaveBeenCalledWith(expect.objectContaining({ kind: 'transcript-start' }))
    expect(onProgress).toHaveBeenCalledWith(expect.objectContaining({ kind: 'transcript-done' }))
  })
})
