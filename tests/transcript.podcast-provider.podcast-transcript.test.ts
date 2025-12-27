import { describe, expect, it, vi } from 'vitest'

async function importPodcastProviderWithoutTranscription() {
  vi.resetModules()
  vi.doMock('../packages/core/src/transcription/whisper.js', () => ({
    MAX_OPENAI_UPLOAD_BYTES: 24 * 1024 * 1024,
    isFfmpegAvailable: async () => false,
    isWhisperCppReady: async () => false,
    probeMediaDurationSecondsWithFfprobe: async () => null,
    resolveWhisperCppModelNameForDisplay: async () => null,
    transcribeMediaWithWhisper: async () => {
      throw new Error('unexpected transcription call')
    },
    transcribeMediaFileWithWhisper: async () => {
      throw new Error('unexpected transcription call')
    },
  }))

  try {
    return await import('../packages/core/src/content/transcript/providers/podcast.js')
  } finally {
    vi.doUnmock('../packages/core/src/transcription/whisper.js')
  }
}

const baseOptions = {
  fetch: vi.fn() as unknown as typeof fetch,
  scrapeWithFirecrawl: null as unknown as ((...args: unknown[]) => unknown) | null,
  apifyApiToken: null,
  youtubeTranscriptMode: 'auto' as const,
  ytDlpPath: null,
  falApiKey: null,
  openaiApiKey: null,
}

describe('podcast transcript provider: RSS <podcast:transcript>', () => {
  it('uses JSON transcript from RSS without requiring transcription providers', async () => {
    const { fetchTranscript } = await importPodcastProviderWithoutTranscription()

    const transcriptUrl = 'https://example.com/transcript.json'
    const feedXml = `<?xml version="1.0" encoding="UTF-8"?>
      <rss version="2.0" xmlns:podcast="https://podcastindex.org/namespace/1.0">
        <channel>
          <item>
            <title>Ep</title>
            <podcast:transcript url="${transcriptUrl}" type="application/json" />
          </item>
        </channel>
      </rss>`

    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url =
        typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      if (url !== transcriptUrl) throw new Error(`Unexpected fetch: ${url}`)
      return new Response(
        JSON.stringify([
          { start: 0.1, end: 0.2, text: 'Hello' },
          { start: 0.2, end: 0.3, text: 'world' },
        ]),
        { status: 200, headers: { 'content-type': 'application/json' } }
      )
    })

    const result = await fetchTranscript(
      { url: 'https://example.com/feed.xml', html: feedXml, resourceKey: null },
      { ...baseOptions, fetch: fetchImpl as unknown as typeof fetch }
    )

    expect(result.source).toBe('podcastTranscript')
    expect(result.text).toContain('Hello')
    expect(result.text).toContain('world')
    expect(result.attemptedProviders).toEqual(['podcastTranscript'])
  })

  it('uses RSS transcript for Apple Podcasts episode (iTunes lookup → feed)', async () => {
    const { fetchTranscript } = await importPodcastProviderWithoutTranscription()

    const showId = '1794526548'
    const episodeId = '1000741457032'
    const feedUrl = 'https://example.com/feed.xml'
    const transcriptUrl = 'https://example.com/transcript.vtt'

    const lookupResponse = JSON.stringify({
      resultCount: 2,
      results: [
        { wrapperType: 'track', kind: 'podcast', feedUrl },
        {
          wrapperType: 'podcastEpisode',
          trackId: Number(episodeId),
          trackName: 'Reengineering Europe – KI, Werte und die Zukunft Europas',
          episodeUrl: 'https://example.com/episode.mp3',
          episodeFileExtension: 'mp3',
          trackTimeMillis: 1000,
        },
      ],
    })

    const feedXml = `<?xml version="1.0" encoding="UTF-8"?>
      <rss version="2.0" xmlns:podcast="https://podcastindex.org/namespace/1.0">
        <channel>
          <item>
            <title><![CDATA[Reengineering Europe – KI, Werte und die Zukunft Europas]]></title>
            <podcast:transcript url="${transcriptUrl}" type="text/vtt" />
          </item>
        </channel>
      </rss>`

    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url =
        typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      if (url.startsWith('https://itunes.apple.com/lookup')) {
        return new Response(lookupResponse, {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }
      if (url === feedUrl) {
        return new Response(feedXml, {
          status: 200,
          headers: { 'content-type': 'application/xml' },
        })
      }
      if (url === transcriptUrl) {
        return new Response(
          `WEBVTT

00:00:00.000 --> 00:00:01.000
Hello from VTT
`,
          { status: 200, headers: { 'content-type': 'text/vtt' } }
        )
      }
      throw new Error(`Unexpected fetch: ${url}`)
    })

    const result = await fetchTranscript(
      {
        url: `https://podcasts.apple.com/us/podcast/test/id${showId}?i=${episodeId}`,
        html: null,
        resourceKey: null,
      },
      { ...baseOptions, fetch: fetchImpl as unknown as typeof fetch }
    )

    expect(result.source).toBe('podcastTranscript')
    expect(result.text).toContain('Hello from VTT')
    expect(result.attemptedProviders).toEqual(['podcastTranscript'])
  })
})
