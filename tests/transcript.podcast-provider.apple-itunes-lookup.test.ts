import { describe, expect, it, vi } from 'vitest'

async function importPodcastProvider() {
  vi.resetModules()

  vi.doMock('../packages/core/src/transcription/whisper.js', () => ({
    MAX_OPENAI_UPLOAD_BYTES: 1024 * 1024,
    isFfmpegAvailable: () => Promise.resolve(true),
    isWhisperCppReady: () => Promise.resolve(false),
    probeMediaDurationSecondsWithFfprobe: async () => null,
    resolveWhisperCppModelNameForDisplay: async () => null,
    transcribeMediaWithWhisper: vi.fn(async () => ({
      text: 'hello from apple',
      provider: 'openai',
      error: null,
      notes: [],
    })),
    transcribeMediaFileWithWhisper: vi.fn(async () => ({
      text: 'hello from apple (file)',
      provider: 'openai',
      error: null,
      notes: [],
    })),
  }))

  return await import('../packages/core/src/content/link-preview/transcript/providers/podcast.js')
}

const baseOptions = {
  scrapeWithFirecrawl: null as unknown as ((...args: unknown[]) => unknown) | null,
  apifyApiToken: null,
  youtubeTranscriptMode: 'auto' as const,
  ytDlpPath: null as string | null,
  falApiKey: null as string | null,
  openaiApiKey: 'OPENAI' as string | null,
}

describe('podcast provider - Apple Podcasts iTunes lookup', () => {
  it('resolves episodeUrl via iTunes lookup when HTML is missing', async () => {
    const { fetchTranscript } = await importPodcastProvider()

    const showId = '1794526548'
    const episodeId = '1000741457032'
    const pageUrl = `https://podcasts.apple.com/us/podcast/test/id${showId}?i=${episodeId}`
    const lookupUrl = `https://itunes.apple.com/lookup?id=${showId}&entity=podcastEpisode&limit=200`
    const episodeUrl = 'https://cdn.example/episode.mp3?source=feed'

    const lookupPayload = {
      resultCount: 2,
      results: [
        { wrapperType: 'track', kind: 'podcast', feedUrl: 'https://example.com/feed.xml' },
        {
          wrapperType: 'podcastEpisode',
          trackId: Number(episodeId),
          episodeUrl,
          episodeFileExtension: 'mp3',
          trackTimeMillis: 96_000,
          releaseDate: '2025-12-01T00:00:00Z',
        },
      ],
    }

    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url =
        typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      const method = (init?.method ?? 'GET').toUpperCase()

      if (url === lookupUrl && method === 'GET') {
        return new Response(JSON.stringify(lookupPayload), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }

      if (url === episodeUrl && method === 'HEAD') {
        return new Response(null, {
          status: 200,
          headers: { 'content-type': 'audio/mpeg', 'content-length': String(1234) },
        })
      }

      if (url === episodeUrl && method === 'GET') {
        return new Response(new Uint8Array([1, 2, 3]), {
          status: 200,
          headers: { 'content-type': 'audio/mpeg' },
        })
      }

      throw new Error(`Unexpected fetch: ${method} ${url}`)
    })

    const result = await fetchTranscript(
      { url: pageUrl, html: null, resourceKey: null },
      { ...baseOptions, fetch: fetchImpl as unknown as typeof fetch }
    )

    expect(result.source).toBe('whisper')
    expect(result.text).toContain('hello from apple')
    expect(result.metadata?.kind).toBe('apple_itunes_episode')
    const meta = result.metadata as unknown as {
      showId?: string
      episodeId?: string
      episodeUrl?: string
      durationSeconds?: number
    }
    expect(meta.showId).toBe(showId)
    expect(meta.episodeId).toBe(episodeId)
    expect(meta.episodeUrl).toBe(episodeUrl)
    expect(meta.durationSeconds).toBe(96)
  })
})
