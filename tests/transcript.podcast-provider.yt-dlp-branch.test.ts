import { describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  fetchTranscriptWithYtDlp: vi.fn(async () => ({
    text: 'ok',
    provider: 'openai' as const,
    notes: ['yt-dlp used'],
  })),
}))

vi.mock('../packages/core/src/content/link-preview/transcript/providers/youtube/yt-dlp.js', () => ({
  fetchTranscriptWithYtDlp: mocks.fetchTranscriptWithYtDlp,
}))

import { fetchTranscript } from '../packages/core/src/content/link-preview/transcript/providers/podcast.js'

const baseOptions = {
  fetch: vi.fn() as unknown as typeof fetch,
  scrapeWithFirecrawl: null as unknown as ((...args: unknown[]) => unknown) | null,
  apifyApiToken: null,
  youtubeTranscriptMode: 'auto' as const,
  ytDlpPath: '/usr/local/bin/yt-dlp',
  falApiKey: null,
  openaiApiKey: 'OPENAI',
  onProgress: null,
}

describe('podcast transcript provider - yt-dlp branch', () => {
  it('uses yt-dlp when no enclosure is found and ytDlpPath is set', async () => {
    const result = await fetchTranscript(
      { url: 'https://example.com/not-a-feed', html: '<html/>', resourceKey: null },
      baseOptions
    )
    expect(result.source).toBe('yt-dlp')
    expect(result.text).toBe('ok')
    expect(result.metadata?.kind).toBe('yt_dlp')
    expect(result.notes).toContain('yt-dlp used')
  })

  it('reports yt-dlp transcription failures', async () => {
    mocks.fetchTranscriptWithYtDlp.mockImplementationOnce(async () => {
      throw new Error('boom')
    })
    const result = await fetchTranscript(
      { url: 'https://example.com/not-a-feed', html: '<html/>', resourceKey: null },
      baseOptions
    )
    expect(result.text).toBeNull()
    expect(result.notes).toContain('yt-dlp transcription failed')
  })
})
