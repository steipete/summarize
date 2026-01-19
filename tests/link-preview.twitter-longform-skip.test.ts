import { describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  resolveTranscriptForLink: vi.fn(async () => ({
    text: 'Transcript text.',
    source: 'yt-dlp',
    metadata: null,
    diagnostics: {
      cacheMode: 'default',
      cacheStatus: 'miss',
      textProvided: true,
      provider: 'yt-dlp',
      attemptedProviders: ['yt-dlp'],
      notes: null,
    },
  })),
}))

vi.mock('../packages/core/src/content/transcript/index.js', () => ({
  resolveTranscriptForLink: mocks.resolveTranscriptForLink,
}))

import { fetchLinkContent } from '../packages/core/src/content/link-preview/content/index.js'

const noopFetch = vi.fn(async () => new Response('nope', { status: 500 }))

const createDeps = (text: string) => ({
  fetch: noopFetch as unknown as typeof fetch,
  scrapeWithFirecrawl: null,
  apifyApiToken: null,
  ytDlpPath: '/usr/local/bin/yt-dlp',
  falApiKey: null,
  openaiApiKey: null,
  convertHtmlToMarkdown: null,
  transcriptCache: null,
  readTweetWithBird: async () => ({
    text,
    author: { username: 'birdy' },
  }),
  resolveTwitterCookies: null,
  onProgress: null,
})

describe('twitter long-form transcript skip', () => {
  it('skips yt-dlp transcript for long-form tweet text', async () => {
    mocks.resolveTranscriptForLink.mockClear()

    const result = await fetchLinkContent(
      'https://x.com/user/status/123',
      { format: 'text' },
      createDeps('x'.repeat(600))
    )

    expect(mocks.resolveTranscriptForLink).not.toHaveBeenCalled()
    expect(result.transcriptSource).toBeNull()
    expect(result.diagnostics.transcript.attemptedProviders).toHaveLength(0)
    expect(result.diagnostics.transcript.notes ?? '').toContain('Skipped yt-dlp transcript')
  })

  it('skips transcript for short tweet text when media transcript mode is auto', async () => {
    mocks.resolveTranscriptForLink.mockClear()

    const result = await fetchLinkContent(
      'https://x.com/user/status/123',
      { format: 'text' },
      createDeps('short tweet')
    )

    expect(mocks.resolveTranscriptForLink).not.toHaveBeenCalled()
    expect(result.transcriptSource).toBeNull()
    expect(result.diagnostics.transcript.notes ?? '').toContain('media transcript mode is auto')
  })

  it('still attempts transcript for short tweet text when media transcript mode is prefer', async () => {
    mocks.resolveTranscriptForLink.mockClear()

    const result = await fetchLinkContent(
      'https://x.com/user/status/123',
      { format: 'text', mediaTranscript: 'prefer' },
      createDeps('short tweet')
    )

    expect(mocks.resolveTranscriptForLink).toHaveBeenCalledTimes(1)
    expect(result.transcriptSource).toBe('yt-dlp')
  })
})
