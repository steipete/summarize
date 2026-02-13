import { beforeEach, describe, expect, it, vi } from 'vitest'

import type {
  ProviderContext,
  ProviderFetchOptions,
} from '../packages/core/src/content/transcript/types.js'

const mocks = vi.hoisted(() => ({
  fetchTranscriptWithYtDlp: vi.fn(),
  isWhisperCppReady: vi.fn(),
}))

vi.mock('../packages/core/src/content/transcript/providers/youtube/yt-dlp.js', () => ({
  fetchTranscriptWithYtDlp: mocks.fetchTranscriptWithYtDlp,
}))

vi.mock('../packages/core/src/transcription/whisper.js', () => ({
  isWhisperCppReady: mocks.isWhisperCppReady,
}))

const noopFetch = vi.fn(async () => new Response('nope', { status: 500 }))

const contextFor = (url: string): ProviderContext => ({ url, html: null, resourceKey: null })

describe('placeholder transcript providers', () => {
  beforeEach(() => {
    mocks.fetchTranscriptWithYtDlp.mockReset()
    mocks.isWhisperCppReady.mockReset()
  })

  it('matches podcast URLs', async () => {
    const podcast = await import('../packages/core/src/content/transcript/providers/podcast.js')
    expect(podcast.canHandle(contextFor('https://example.com/podcast/123'))).toBe(true)
    expect(podcast.canHandle(contextFor('https://open.spotify.com/show/abc'))).toBe(true)
    expect(podcast.canHandle(contextFor('https://example.com/article'))).toBe(false)
  })

  it('matches generic URLs', async () => {
    const generic = await import('../packages/core/src/content/transcript/providers/generic.js')
    expect(generic.canHandle(contextFor('https://example.com/article'))).toBe(true)
  })

  it('returns not_implemented provider metadata', async () => {
    const podcast = await import('../packages/core/src/content/transcript/providers/podcast.js')
    const generic = await import('../packages/core/src/content/transcript/providers/generic.js')
    const options: ProviderFetchOptions = {
      fetch: noopFetch as unknown as typeof fetch,
      apifyApiToken: null,
      youtubeTranscriptMode: 'auto',
      mediaTranscriptMode: 'auto',
      ytDlpPath: null,
      groqApiKey: null,
      falApiKey: null,
      openaiApiKey: null,
    }

    const podcastResult = await podcast.fetchTranscript(
      contextFor('https://example.com/podcast'),
      options
    )
    expect(podcastResult.text).toBeNull()
    expect(podcastResult.metadata).toEqual({
      provider: 'podcast',
      reason: 'missing_transcription_keys',
    })

    const genericResult = await generic.fetchTranscript(contextFor('https://example.com'), options)
    expect(genericResult.text).toBeNull()
    expect(genericResult.metadata).toEqual({ provider: 'generic', reason: 'not_implemented' })
  })

  it('returns missing yt-dlp metadata for tweet URLs', async () => {
    const generic = await import('../packages/core/src/content/transcript/providers/generic.js')
    const options: ProviderFetchOptions = {
      fetch: noopFetch as unknown as typeof fetch,
      apifyApiToken: null,
      youtubeTranscriptMode: 'auto',
      mediaTranscriptMode: 'prefer',
      ytDlpPath: null,
      groqApiKey: null,
      falApiKey: null,
      openaiApiKey: null,
    }

    const genericResult = await generic.fetchTranscript(
      contextFor('https://x.com/example/status/123'),
      options
    )
    expect(genericResult.text).toBeNull()
    expect(genericResult.metadata).toEqual({
      provider: 'generic',
      kind: 'twitter',
      reason: 'missing_yt_dlp',
    })
    expect(mocks.fetchTranscriptWithYtDlp).not.toHaveBeenCalled()
  })

  it('passes X cookies to yt-dlp when available', async () => {
    const generic = await import('../packages/core/src/content/transcript/providers/generic.js')

    mocks.isWhisperCppReady.mockResolvedValue(false)
    mocks.fetchTranscriptWithYtDlp.mockResolvedValue({
      text: 'hello world',
      provider: 'openai',
      error: null,
      notes: [],
    })

    const options: ProviderFetchOptions = {
      fetch: noopFetch as unknown as typeof fetch,
      apifyApiToken: null,
      youtubeTranscriptMode: 'auto',
      mediaTranscriptMode: 'prefer',
      ytDlpPath: '/usr/local/bin/yt-dlp',
      groqApiKey: null,
      falApiKey: null,
      openaiApiKey: 'sk-test',
      resolveTwitterCookies: async () => ({
        cookiesFromBrowser: 'chrome',
        source: 'env AUTH_TOKEN',
        warnings: [],
      }),
    }

    const result: Awaited<ReturnType<typeof generic.fetchTranscript>> =
      await generic.fetchTranscript(contextFor('https://x.com/example/status/123'), options)

    expect(mocks.fetchTranscriptWithYtDlp).toHaveBeenCalledWith(
      expect.objectContaining({
        service: 'generic',
        extraArgs: ['--cookies-from-browser', 'chrome'],
      })
    )
    expect(result.text).toBe('hello world')
    expect(result.source).toBe('yt-dlp')
    expect(result.metadata).toMatchObject({
      provider: 'generic',
      kind: 'twitter',
      transcriptionProvider: 'openai',
      cookieSource: 'env AUTH_TOKEN',
    })
  })
})
