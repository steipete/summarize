import { beforeEach, describe, expect, it, vi } from 'vitest'

const api = vi.hoisted(() => ({
  extractYoutubeiTranscriptConfig: vi.fn(),
  fetchTranscriptFromTranscriptEndpoint: vi.fn(),
}))
const captions = vi.hoisted(() => ({
  fetchTranscriptFromCaptionTracks: vi.fn(),
}))
const apify = vi.hoisted(() => ({
  fetchTranscriptWithApify: vi.fn(),
}))
const ytdlp = vi.hoisted(() => ({
  fetchTranscriptWithYtDlp: vi.fn(),
}))

vi.mock('../packages/core/src/content/link-preview/transcript/providers/youtube/api.js', () => api)
vi.mock(
  '../packages/core/src/content/link-preview/transcript/providers/youtube/captions.js',
  () => captions
)
vi.mock(
  '../packages/core/src/content/link-preview/transcript/providers/youtube/apify.js',
  () => apify
)
vi.mock(
  '../packages/core/src/content/link-preview/transcript/providers/youtube/yt-dlp.js',
  () => ytdlp
)

import { fetchTranscript } from '../packages/core/src/content/link-preview/transcript/providers/youtube.js'

const baseOptions = {
  fetch: vi.fn() as unknown as typeof fetch,
  apifyApiToken: null,
  youtubeTranscriptMode: 'auto' as const,
  ytDlpPath: null,
  falApiKey: null,
  openaiApiKey: null,
}

describe('YouTube transcript provider module', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    api.extractYoutubeiTranscriptConfig.mockReturnValue(null)
    api.fetchTranscriptFromTranscriptEndpoint.mockResolvedValue(null)
    captions.fetchTranscriptFromCaptionTracks.mockResolvedValue(null)
    apify.fetchTranscriptWithApify.mockResolvedValue(null)
    ytdlp.fetchTranscriptWithYtDlp.mockResolvedValue({
      text: null,
      provider: null,
      error: null,
      notes: [],
    })
  })

  it('returns null when HTML is missing or video id cannot be resolved', async () => {
    expect(
      await fetchTranscript(
        { url: 'https://www.youtube.com/watch?v=abcdefghijk', html: null, resourceKey: null },
        baseOptions
      )
    ).toEqual({ text: null, source: null, attemptedProviders: [] })

    expect(
      await fetchTranscript(
        { url: 'https://www.youtube.com/watch', html: '<html></html>', resourceKey: null },
        baseOptions
      )
    ).toEqual({ text: null, source: null, attemptedProviders: [] })
  })

  it('uses apify-only mode and skips web + yt-dlp', async () => {
    apify.fetchTranscriptWithApify.mockResolvedValue('Hello from apify')

    const result = await fetchTranscript(
      {
        url: 'https://www.youtube.com/watch?v=abcdefghijk',
        html: '<html></html>',
        resourceKey: null,
      },
      {
        ...baseOptions,
        apifyApiToken: 'TOKEN',
        youtubeTranscriptMode: 'apify',
      }
    )

    expect(result.text).toBe('Hello from apify')
    expect(result.source).toBe('apify')
    expect(result.attemptedProviders).toEqual(['apify'])
    expect(api.extractYoutubeiTranscriptConfig).not.toHaveBeenCalled()
    expect(captions.fetchTranscriptFromCaptionTracks).not.toHaveBeenCalled()
    expect(ytdlp.fetchTranscriptWithYtDlp).not.toHaveBeenCalled()
  })

  it('uses web-only mode and skips apify + yt-dlp', async () => {
    const result = await fetchTranscript(
      {
        url: 'https://www.youtube.com/watch?v=abcdefghijk',
        html: '<html></html>',
        resourceKey: null,
      },
      {
        ...baseOptions,
        apifyApiToken: 'TOKEN',
        youtubeTranscriptMode: 'web',
      }
    )

    expect(result.source).toBe('unavailable')
    expect(result.attemptedProviders).toEqual(['captionTracks', 'unavailable'])
    expect(apify.fetchTranscriptWithApify).not.toHaveBeenCalled()
    expect(ytdlp.fetchTranscriptWithYtDlp).not.toHaveBeenCalled()
  })

  it('attempts providers in order for auto mode', async () => {
    api.extractYoutubeiTranscriptConfig.mockReturnValue({
      apiKey: 'KEY',
      context: {},
      params: 'PARAMS',
    })

    const result = await fetchTranscript(
      {
        url: 'https://www.youtube.com/watch?v=abcdefghijk',
        html: '<html></html>',
        resourceKey: null,
      },
      {
        ...baseOptions,
        youtubeTranscriptMode: 'auto',
        ytDlpPath: '/usr/bin/yt-dlp',
        openaiApiKey: 'OPENAI',
      }
    )

    expect(result.attemptedProviders).toEqual([
      'youtubei',
      'captionTracks',
      'yt-dlp',
      'unavailable',
    ])
  })

  it('skips yt-dlp in auto mode when credentials are missing', async () => {
    api.extractYoutubeiTranscriptConfig.mockReturnValue(null)

    const result = await fetchTranscript(
      {
        url: 'https://www.youtube.com/watch?v=abcdefghijk',
        html: '<html></html>',
        resourceKey: null,
      },
      {
        ...baseOptions,
        youtubeTranscriptMode: 'auto',
      }
    )

    expect(result.attemptedProviders).toEqual(['captionTracks', 'unavailable'])
    expect(ytdlp.fetchTranscriptWithYtDlp).not.toHaveBeenCalled()
    expect(apify.fetchTranscriptWithApify).not.toHaveBeenCalled()
  })

  it('tries yt-dlp before apify in auto mode (apify last resort)', async () => {
    api.extractYoutubeiTranscriptConfig.mockReturnValue(null)
    apify.fetchTranscriptWithApify.mockResolvedValue('Hello from apify')

    const result = await fetchTranscript(
      {
        url: 'https://www.youtube.com/watch?v=abcdefghijk',
        html: '<html></html>',
        resourceKey: null,
      },
      {
        ...baseOptions,
        apifyApiToken: 'TOKEN',
        youtubeTranscriptMode: 'auto',
        ytDlpPath: '/usr/bin/yt-dlp',
        openaiApiKey: 'OPENAI',
      }
    )

    expect(result.source).toBe('apify')
    expect(result.attemptedProviders).toEqual(['captionTracks', 'yt-dlp', 'apify'])
  })

  it('errors in yt-dlp mode when transcription keys are missing', async () => {
    await expect(
      fetchTranscript(
        {
          url: 'https://www.youtube.com/watch?v=abcdefghijk',
          html: '<html></html>',
          resourceKey: null,
        },
        {
          ...baseOptions,
          youtubeTranscriptMode: 'yt-dlp',
          ytDlpPath: '/usr/bin/yt-dlp',
          falApiKey: null,
          openaiApiKey: null,
        }
      )
    ).rejects.toThrow(/Missing transcription provider for --youtube yt-dlp/i)
  })
})
