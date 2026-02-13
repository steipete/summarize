import { beforeEach, describe, expect, it, vi } from 'vitest'

const api = vi.hoisted(() => ({
  extractYoutubeiTranscriptConfig: vi.fn(),
  fetchTranscriptFromTranscriptEndpoint: vi.fn(),
}))
const captions = vi.hoisted(() => ({
  fetchTranscriptFromCaptionTracks: vi.fn(),
  extractYoutubeDurationSeconds: vi.fn(),
  fetchYoutubeDurationSecondsViaPlayer: vi.fn(),
}))
const apify = vi.hoisted(() => ({
  fetchTranscriptWithApify: vi.fn(),
}))
const ytdlp = vi.hoisted(() => ({
  fetchTranscriptWithYtDlp: vi.fn(),
  fetchDurationSecondsWithYtDlp: vi.fn(),
}))

vi.mock('../packages/core/src/content/transcript/providers/youtube/api.js', () => api)
vi.mock('../packages/core/src/content/transcript/providers/youtube/captions.js', () => captions)
vi.mock('../packages/core/src/content/transcript/providers/youtube/apify.js', () => apify)
vi.mock('../packages/core/src/content/transcript/providers/youtube/yt-dlp.js', () => ytdlp)

import { fetchTranscript } from '../packages/core/src/content/transcript/providers/youtube.js'

const baseOptions = {
  fetch: vi.fn() as unknown as typeof fetch,
  apifyApiToken: null,
  youtubeTranscriptMode: 'auto' as const,
  ytDlpPath: null,
  groqApiKey: null,
  falApiKey: null,
  openaiApiKey: null,
}

describe('YouTube transcript provider module', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    api.extractYoutubeiTranscriptConfig.mockReturnValue(null)
    api.fetchTranscriptFromTranscriptEndpoint.mockResolvedValue(null)
    captions.fetchTranscriptFromCaptionTracks.mockResolvedValue(null)
    captions.extractYoutubeDurationSeconds.mockReturnValue(null)
    captions.fetchYoutubeDurationSecondsViaPlayer.mockResolvedValue(null)
    apify.fetchTranscriptWithApify.mockResolvedValue(null)
    ytdlp.fetchTranscriptWithYtDlp.mockResolvedValue({
      text: null,
      provider: null,
      error: null,
      notes: [],
    })
    ytdlp.fetchDurationSecondsWithYtDlp.mockResolvedValue(null)
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

  it('uses apify mode even when HTML is null (fixes #51)', async () => {
    apify.fetchTranscriptWithApify.mockResolvedValue('Hello from apify')

    const result = await fetchTranscript(
      {
        url: 'https://www.youtube.com/watch?v=abcdefghijk',
        html: null,
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

  it('returns unavailable when apify mode fails with null HTML', async () => {
    apify.fetchTranscriptWithApify.mockResolvedValue(null)

    const result = await fetchTranscript(
      {
        url: 'https://www.youtube.com/watch?v=abcdefghijk',
        html: null,
        resourceKey: null,
      },
      {
        ...baseOptions,
        apifyApiToken: 'TOKEN',
        youtubeTranscriptMode: 'apify',
      }
    )

    expect(result.text).toBeNull()
    expect(result.source).toBe('unavailable')
    expect(result.attemptedProviders).toEqual(['apify', 'unavailable'])
  })

  it('throws when apify mode used without token and HTML is null', async () => {
    await expect(
      fetchTranscript(
        {
          url: 'https://www.youtube.com/watch?v=abcdefghijk',
          html: null,
          resourceKey: null,
        },
        {
          ...baseOptions,
          apifyApiToken: null,
          youtubeTranscriptMode: 'apify',
        }
      )
    ).rejects.toThrow(/Missing APIFY_API_TOKEN/i)
  })

  it('uses apify-only mode and skips web + yt-dlp', async () => {
    apify.fetchTranscriptWithApify.mockResolvedValue('Hello from apify')
    captions.extractYoutubeDurationSeconds.mockReturnValue(1872)

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
    expect(result.metadata).toEqual({ provider: 'apify', durationSeconds: 1872 })
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

  it('uses no-auto mode with skipAutoGenerated flag', async () => {
    captions.fetchTranscriptFromCaptionTracks.mockResolvedValue({
      text: 'Creator caption',
      segments: null,
    })
    captions.extractYoutubeDurationSeconds.mockReturnValue(1872)

    const result = await fetchTranscript(
      {
        url: 'https://www.youtube.com/watch?v=abcdefghijk',
        html: '<html></html>',
        resourceKey: null,
      },
      {
        ...baseOptions,
        youtubeTranscriptMode: 'no-auto',
      }
    )

    expect(result.text).toBe('Creator caption')
    expect(result.source).toBe('captionTracks')
    expect(result.metadata).toEqual({
      provider: 'captionTracks',
      manualOnly: true,
      durationSeconds: 1872,
    })
    expect(captions.fetchTranscriptFromCaptionTracks).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ skipAutoGenerated: true })
    )
    expect(api.extractYoutubeiTranscriptConfig).not.toHaveBeenCalled()
    expect(apify.fetchTranscriptWithApify).not.toHaveBeenCalled()
    expect(ytdlp.fetchTranscriptWithYtDlp).not.toHaveBeenCalled()
  })

  it('falls back to player duration when html lacks lengthSeconds', async () => {
    captions.fetchTranscriptFromCaptionTracks.mockResolvedValue({
      text: 'Creator caption',
      segments: null,
    })
    captions.extractYoutubeDurationSeconds.mockReturnValue(null)
    captions.fetchYoutubeDurationSecondsViaPlayer.mockResolvedValue(2220)

    const result = await fetchTranscript(
      {
        url: 'https://www.youtube.com/watch?v=abcdefghijk',
        html: '<html></html>',
        resourceKey: null,
      },
      {
        ...baseOptions,
        youtubeTranscriptMode: 'no-auto',
      }
    )

    expect(result.metadata).toEqual({
      provider: 'captionTracks',
      manualOnly: true,
      durationSeconds: 2220,
    })
    expect(captions.fetchYoutubeDurationSecondsViaPlayer).toHaveBeenCalled()
  })

  it('uses yt-dlp duration when player duration is unavailable', async () => {
    captions.fetchTranscriptFromCaptionTracks.mockResolvedValue({
      text: 'Creator caption',
      segments: null,
    })
    captions.extractYoutubeDurationSeconds.mockReturnValue(null)
    captions.fetchYoutubeDurationSecondsViaPlayer.mockResolvedValue(null)
    ytdlp.fetchDurationSecondsWithYtDlp.mockResolvedValue(3300)

    const result = await fetchTranscript(
      {
        url: 'https://www.youtube.com/watch?v=abcdefghijk',
        html: '<html></html>',
        resourceKey: null,
      },
      {
        ...baseOptions,
        youtubeTranscriptMode: 'no-auto',
        ytDlpPath: '/usr/bin/yt-dlp',
      }
    )

    expect(result.metadata).toEqual({
      provider: 'captionTracks',
      manualOnly: true,
      durationSeconds: 3300,
    })
    expect(ytdlp.fetchDurationSecondsWithYtDlp).toHaveBeenCalled()
  })

  it('falls back to yt-dlp in no-auto mode when no creator captions found', async () => {
    captions.fetchTranscriptFromCaptionTracks.mockResolvedValue(null)
    ytdlp.fetchTranscriptWithYtDlp.mockResolvedValue({
      text: 'Transcribed audio',
      provider: 'openai',
      error: null,
      notes: [],
    })

    const result = await fetchTranscript(
      {
        url: 'https://www.youtube.com/watch?v=abcdefghijk',
        html: '<html></html>',
        resourceKey: null,
      },
      {
        ...baseOptions,
        youtubeTranscriptMode: 'no-auto',
        ytDlpPath: '/usr/bin/yt-dlp',
        openaiApiKey: 'OPENAI',
      }
    )

    expect(result.text).toBe('Transcribed audio')
    expect(result.source).toBe('yt-dlp')
    expect(result.attemptedProviders).toEqual(['captionTracks', 'yt-dlp'])
    expect(result.notes).toContain('No creator captions found, using yt-dlp transcription')
    expect(api.extractYoutubeiTranscriptConfig).not.toHaveBeenCalled()
    expect(apify.fetchTranscriptWithApify).not.toHaveBeenCalled()
  })

  it('returns segments when timestamps are requested', async () => {
    captions.fetchTranscriptFromCaptionTracks.mockResolvedValue({
      text: 'Creator caption',
      segments: [{ startMs: 1000, endMs: 2000, text: 'Hello' }],
    })

    const result = await fetchTranscript(
      {
        url: 'https://www.youtube.com/watch?v=abcdefghijk',
        html: '<html></html>',
        resourceKey: null,
      },
      {
        ...baseOptions,
        youtubeTranscriptMode: 'web',
        transcriptTimestamps: true,
      }
    )

    expect(result.segments).toEqual([{ startMs: 1000, endMs: 2000, text: 'Hello' }])
  })

  it('errors in no-auto mode when yt-dlp fallback is not available', async () => {
    await expect(
      fetchTranscript(
        {
          url: 'https://www.youtube.com/watch?v=abcdefghijk',
          html: '<html></html>',
          resourceKey: null,
        },
        {
          ...baseOptions,
          youtubeTranscriptMode: 'no-auto',
          ytDlpPath: null,
          falApiKey: null,
          openaiApiKey: null,
        }
      )
    ).rejects.toThrow(/--youtube no-auto requires yt-dlp/i)

    expect(captions.fetchTranscriptFromCaptionTracks).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ skipAutoGenerated: true })
    )
    expect(api.extractYoutubeiTranscriptConfig).not.toHaveBeenCalled()
    expect(apify.fetchTranscriptWithApify).not.toHaveBeenCalled()
    expect(ytdlp.fetchTranscriptWithYtDlp).not.toHaveBeenCalled()
  })
})
