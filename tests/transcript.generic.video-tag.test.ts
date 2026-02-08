import { describe, expect, it, vi } from 'vitest'

import { fetchTranscript } from '../packages/core/src/content/transcript/providers/generic.js'

const fetchTranscriptWithYtDlp = vi.fn(async () => ({
  text: 'yt-dlp transcript',
  provider: 'openai',
  notes: [],
  error: null,
}))

vi.mock('../packages/core/src/content/transcript/providers/youtube/yt-dlp.js', () => ({
  fetchTranscriptWithYtDlp,
}))

const buildOptions = (overrides?: Partial<Parameters<typeof fetchTranscript>[1]>) => ({
  fetch: fetch,
  scrapeWithFirecrawl: null,
  apifyApiToken: null,
  youtubeTranscriptMode: 'auto',
  mediaTranscriptMode: 'auto',
  ytDlpPath: '/usr/bin/yt-dlp',
  groqApiKey: null,
  falApiKey: null,
  openaiApiKey: 'test',
  resolveTwitterCookies: null,
  onProgress: null,
  ...overrides,
})

describe('generic transcript provider (video tag fallback)', () => {
  it('uses yt-dlp when mediaTranscriptMode=prefer and a video tag lacks src', async () => {
    const html = `
      <html>
        <body>
          <video class="u-full-width" preload="none" controls></video>
        </body>
      </html>
    `

    const result = await fetchTranscript(
      { url: 'https://example.com/page', html, resourceKey: null },
      buildOptions({ mediaTranscriptMode: 'prefer' })
    )

    expect(fetchTranscriptWithYtDlp).toHaveBeenCalledTimes(1)
    expect(fetchTranscriptWithYtDlp).toHaveBeenCalledWith(
      expect.objectContaining({ url: 'https://example.com/page' })
    )
    expect(result.source).toBe('yt-dlp')
    expect(result.text).toContain('yt-dlp transcript')
    expect(result.attemptedProviders).toContain('yt-dlp')
  })

  it('does not use yt-dlp without prefer mode', async () => {
    fetchTranscriptWithYtDlp.mockClear()
    const html = `
      <html>
        <body>
          <video class="u-full-width" preload="none" controls></video>
        </body>
      </html>
    `

    const result = await fetchTranscript(
      { url: 'https://example.com/page', html, resourceKey: null },
      buildOptions({ mediaTranscriptMode: 'auto' })
    )

    expect(fetchTranscriptWithYtDlp).not.toHaveBeenCalled()
    expect(result.source).toBeNull()
  })
})
