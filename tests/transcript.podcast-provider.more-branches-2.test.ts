import { describe, expect, it, vi } from 'vitest'
import type { ScrapeWithFirecrawl } from '../packages/core/src/content/link-preview/deps.js'

async function importPodcastProvider() {
  vi.resetModules()

  const transcribeMediaWithWhisper = vi.fn(async () => ({
    text: 'ok',
    provider: 'openai',
    error: null,
    notes: [],
  }))
  const transcribeMediaFileWithWhisper = vi.fn(async () => ({
    text: 'ok-file',
    provider: 'openai',
    error: null,
    notes: [],
  }))

  vi.doMock('../packages/core/src/transcription/whisper.js', () => ({
    MAX_OPENAI_UPLOAD_BYTES: 100,
    isFfmpegAvailable: () => Promise.resolve(true),
    isWhisperCppReady: () => Promise.resolve(false),
    probeMediaDurationSecondsWithFfprobe: async () => null,
    resolveWhisperCppModelNameForDisplay: async () => null,
    transcribeMediaWithWhisper,
    transcribeMediaFileWithWhisper,
  }))

  const mod = await import('../packages/core/src/content/transcript/providers/podcast.js')
  return { ...mod, transcribeMediaWithWhisper, transcribeMediaFileWithWhisper }
}

const baseOptions = {
  apifyApiToken: null,
  youtubeTranscriptMode: 'auto' as const,
  ytDlpPath: null as string | null,
  groqApiKey: null as string | null,
  falApiKey: null as string | null,
  openaiApiKey: 'OPENAI' as string | null,
}

describe('podcast provider extra branches (spotify/apple/transcribe)', () => {
  it('Spotify: fails fast when embed fetch fails and Firecrawl is unavailable', async () => {
    const { fetchTranscript } = await importPodcastProvider()
    const episodeId = 'abc123'
    const pageUrl = `https://open.spotify.com/episode/${episodeId}`
    const embedUrl = `https://open.spotify.com/embed/episode/${episodeId}`

    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url =
        typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      const method = (init?.method ?? 'GET').toUpperCase()
      if (url === embedUrl && method === 'GET') {
        return new Response('no', { status: 503, headers: { 'content-type': 'text/html' } })
      }
      throw new Error(`Unexpected fetch: ${method} ${url}`)
    })

    const result = await fetchTranscript(
      { url: pageUrl, html: null, resourceKey: null },
      { ...baseOptions, fetch: fetchImpl as unknown as typeof fetch, scrapeWithFirecrawl: null }
    )

    expect(result.source).toBeNull()
    expect(String(result.notes)).toContain('Spotify episode fetch failed')
  })

  it('Spotify: uses Firecrawl fallback when embed HTML looks blocked but payload is empty', async () => {
    const { fetchTranscript } = await importPodcastProvider()
    const episodeId = 'abc123'
    const pageUrl = `https://open.spotify.com/episode/${episodeId}`
    const embedUrl = `https://open.spotify.com/embed/episode/${episodeId}`

    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url =
        typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      const method = (init?.method ?? 'GET').toUpperCase()
      if (url === embedUrl && method === 'GET') {
        return new Response('<html>captcha</html>', {
          status: 200,
          headers: { 'content-type': 'text/html' },
        })
      }
      throw new Error(`Unexpected fetch: ${method} ${url}`)
    })

    const scrapeWithFirecrawl = vi.fn(async () => null)

    const result = await fetchTranscript(
      { url: pageUrl, html: null, resourceKey: null },
      {
        ...baseOptions,
        fetch: fetchImpl as unknown as typeof fetch,
        scrapeWithFirecrawl: scrapeWithFirecrawl as unknown as ScrapeWithFirecrawl,
      }
    )

    expect(result.source).toBeNull()
    expect(String(result.notes)).toContain('Firecrawl returned empty content')
  })

  it('Spotify: fails when Firecrawl still returns blocked content', async () => {
    const { fetchTranscript } = await importPodcastProvider()
    const episodeId = 'abc123'
    const pageUrl = `https://open.spotify.com/episode/${episodeId}`
    const embedUrl = `https://open.spotify.com/embed/episode/${episodeId}`

    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url =
        typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      const method = (init?.method ?? 'GET').toUpperCase()
      if (url === embedUrl && method === 'GET') {
        return new Response('<html>captcha</html>', {
          status: 200,
          headers: { 'content-type': 'text/html' },
        })
      }
      throw new Error(`Unexpected fetch: ${method} ${url}`)
    })

    const scrapeWithFirecrawl = vi.fn(async () => ({
      html: '<html>recaptcha</html>',
      markdown: 'x',
    }))

    const result = await fetchTranscript(
      { url: pageUrl, html: null, resourceKey: null },
      {
        ...baseOptions,
        fetch: fetchImpl as unknown as typeof fetch,
        scrapeWithFirecrawl: scrapeWithFirecrawl as unknown as ScrapeWithFirecrawl,
      }
    )

    expect(result.source).toBeNull()
    expect(String(result.notes)).toContain('blocked even via Firecrawl')
  })

  it('Spotify: falls back to iTunes RSS when embed has no audio URL', async () => {
    const { fetchTranscript } = await importPodcastProvider()
    const episodeId = 'abc123'
    const pageUrl = `https://open.spotify.com/episode/${episodeId}`
    const embedUrl = `https://open.spotify.com/embed/episode/${episodeId}`
    const feedUrl = 'https://example.com/feed.xml'
    const enclosureUrl = 'https://example.com/ep.mp3'

    const embedHtml = `<!doctype html><script id="__NEXT_DATA__" type="application/json">${JSON.stringify(
      {
        props: {
          pageProps: {
            state: {
              data: {
                entity: { subtitle: 'Show', title: 'Ep', duration: 60_000 },
                defaultAudioFileObject: { url: [] },
              },
            },
          },
        },
      }
    )}</script>`

    const rss = `<rss><channel><item><title>Ep</title><enclosure url="${enclosureUrl}" type="audio/mpeg"/><itunes:duration>60</itunes:duration></item></channel></rss>`

    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url =
        typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      const method = (init?.method ?? 'GET').toUpperCase()

      if (url === embedUrl && method === 'GET') return new Response(embedHtml, { status: 200 })

      if (url.startsWith('https://itunes.apple.com/search') && method === 'GET') {
        return new Response(JSON.stringify({ results: [{ collectionName: 'Show', feedUrl }] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }

      if (url === feedUrl && method === 'GET') return new Response(rss, { status: 200 })

      if (url === enclosureUrl && method === 'HEAD') {
        return new Response(null, {
          status: 200,
          headers: { 'content-type': 'audio/mpeg', 'content-length': '10' },
        })
      }

      if (url === enclosureUrl && method === 'GET') {
        return new Response(new Uint8Array([1, 2, 3]), {
          status: 200,
          headers: { 'content-type': 'audio/mpeg' },
        })
      }

      throw new Error(`Unexpected fetch: ${method} ${url}`)
    })

    const result = await fetchTranscript(
      { url: pageUrl, html: null, resourceKey: null },
      { ...baseOptions, fetch: fetchImpl as unknown as typeof fetch, scrapeWithFirecrawl: null }
    )

    expect(result.source).toBe('whisper')
    expect(result.metadata?.kind).toBe('spotify_itunes_rss_enclosure')
  })

  it('Apple: picks newest episode when i= is missing', async () => {
    const { fetchTranscript } = await importPodcastProvider()
    const showId = '1794526548'
    const pageUrl = `https://podcasts.apple.com/us/podcast/test/id${showId}`
    const lookupUrl = `https://itunes.apple.com/lookup?id=${showId}&entity=podcastEpisode&limit=200`
    const olderUrl = 'https://cdn.example/older.mp3'
    const newerUrl = 'https://cdn.example/newer.mp3'

    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url =
        typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      const method = (init?.method ?? 'GET').toUpperCase()

      if (url === lookupUrl && method === 'GET') {
        return new Response(
          JSON.stringify({
            results: [
              { wrapperType: 'track', kind: 'podcast', feedUrl: 'https://example.com/feed.xml' },
              {
                wrapperType: 'podcastEpisode',
                trackId: 1,
                episodeUrl: olderUrl,
                releaseDate: '2025-01-01T00:00:00Z',
              },
              {
                wrapperType: 'podcastEpisode',
                trackId: 2,
                episodeUrl: newerUrl,
                releaseDate: '2025-12-01T00:00:00Z',
              },
            ],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        )
      }

      if (url === newerUrl && method === 'HEAD') {
        return new Response(null, {
          status: 200,
          headers: { 'content-type': 'audio/mpeg', 'content-length': '10' },
        })
      }
      if (url === newerUrl && method === 'GET') {
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
    const meta = result.metadata as unknown as { episodeUrl?: string }
    expect(meta.episodeUrl).toBe(newerUrl)
  })

  it('transcribes via temp file when HEAD has no content-length', async () => {
    const { fetchTranscript, transcribeMediaFileWithWhisper } = await importPodcastProvider()
    const enclosureUrl = 'https://example.com/episode.mp3'
    const xml = `<rss><channel><item><enclosure url="${enclosureUrl}" type="audio/mpeg"/></item></channel></rss>`

    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url =
        typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      const method = (init?.method ?? 'GET').toUpperCase()
      if (method === 'HEAD') {
        return new Response(null, { status: 200, headers: { 'content-type': 'audio/mpeg' } })
      }
      if (url === enclosureUrl && method === 'GET') {
        return new Response(new Uint8Array([1, 2, 3, 4, 5]), {
          status: 200,
          headers: { 'content-type': 'audio/mpeg' },
        })
      }
      throw new Error(`Unexpected fetch: ${method} ${url}`)
    })

    const result = await fetchTranscript(
      { url: 'https://example.com/feed.xml', html: xml, resourceKey: null },
      { ...baseOptions, fetch: fetchImpl as unknown as typeof fetch }
    )

    expect(result.source).toBe('whisper')
    expect(transcribeMediaFileWithWhisper).toHaveBeenCalled()
  })

  it('reports enclosure download errors cleanly', async () => {
    const { fetchTranscript } = await importPodcastProvider()
    const enclosureUrl = 'https://example.com/episode.mp3'
    const xml = `<rss><channel><item><enclosure url="${enclosureUrl}" type="audio/mpeg"/></item></channel></rss>`

    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url =
        typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      const method = (init?.method ?? 'GET').toUpperCase()
      if (method === 'HEAD') {
        return new Response(null, {
          status: 200,
          headers: { 'content-type': 'audio/mpeg', 'content-length': '10' },
        })
      }
      if (url === enclosureUrl && method === 'GET') {
        return new Response('nope', { status: 403 })
      }
      throw new Error(`Unexpected fetch: ${method} ${url}`)
    })

    const result = await fetchTranscript(
      { url: 'https://example.com/feed.xml', html: xml, resourceKey: null },
      { ...baseOptions, fetch: fetchImpl as unknown as typeof fetch }
    )

    expect(result.source).toBeNull()
    expect(String(result.notes)).toContain('Download failed')
  })
})
