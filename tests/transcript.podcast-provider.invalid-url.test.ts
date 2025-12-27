import { describe, expect, it, vi } from 'vitest'

import { fetchTranscript } from '../packages/core/src/content/transcript/providers/podcast.js'

describe('podcast transcript provider - invalid URL branches', () => {
  it('handles invalid URLs gracefully and returns no-enclosure metadata', async () => {
    const result = await fetchTranscript(
      { url: 'not a url', html: null, resourceKey: null },
      {
        fetch: vi.fn() as unknown as typeof fetch,
        scrapeWithFirecrawl: null,
        apifyApiToken: null,
        youtubeTranscriptMode: 'auto',
        ytDlpPath: null,
        falApiKey: null,
        openaiApiKey: 'OPENAI',
        onProgress: null,
      }
    )
    expect(result.text).toBeNull()
    expect(result.metadata?.reason).toBe('no_enclosure_and_no_yt_dlp')
  })
})
