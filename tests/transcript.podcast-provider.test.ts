import { describe, expect, it, vi } from 'vitest'

import { fetchTranscript } from '../packages/core/src/content/transcript/providers/podcast.js'

const baseOptions = {
  fetch: vi.fn() as unknown as typeof fetch,
  scrapeWithFirecrawl: null as unknown as ((...args: unknown[]) => unknown) | null,
  apifyApiToken: null,
  youtubeTranscriptMode: 'auto' as const,
  ytDlpPath: null,
  falApiKey: null,
  openaiApiKey: 'OPENAI',
}

describe('podcast transcript provider module', () => {
  it('returns a helpful message only when transcription is required but unavailable', async () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?><rss version="2.0"><channel><item><enclosure url="https://example.com/episode.mp3" type="audio/mpeg"/></item></channel></rss>`

    const result = await fetchTranscript(
      { url: 'https://example.com/feed.xml', html: xml, resourceKey: null },
      { ...baseOptions, openaiApiKey: null, falApiKey: null }
    )

    expect(result.text).toBeNull()
    expect(result.source).toBeNull()
    expect(result.attemptedProviders).toEqual([])
    expect(result.metadata?.reason).toBe('missing_transcription_keys')
    expect(result.notes).toContain('Missing transcription provider')
  })

  it('extracts Podcasting 2.0 transcript from RSS (JSON) without needing Whisper', async () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?><rss version="2.0" xmlns:podcast="https://podcastindex.org/namespace/1.0"><channel><item><title>Episode 1</title><podcast:transcript url="https://example.com/transcript.json" type="application/json"/></item></channel></rss>`

    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString()
      if (url === 'https://example.com/transcript.json') {
        return new Response(JSON.stringify([{ text: 'Hello' }, { text: 'world' }]), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }
      throw new Error(`Unexpected fetch: ${url}`)
    })

    const result = await fetchTranscript(
      { url: 'https://example.com/feed.xml', html: xml, resourceKey: null },
      {
        ...baseOptions,
        fetch: fetchImpl as unknown as typeof fetch,
        openaiApiKey: null,
        falApiKey: null,
      }
    )

    expect(result.source).toBe('podcastTranscript')
    expect(result.text).toBe('Hello\nworld')
    expect(result.attemptedProviders).toEqual(['podcastTranscript'])
  })

  it('resolves Apple Podcasts iTunes lookup → RSS transcript (VTT) and avoids preview audio', async () => {
    const appleUrl = 'https://podcasts.apple.com/us/podcast/x/id123?i=456'
    const feedUrl = 'https://example.com/feed.xml'
    const transcriptUrl = 'https://example.com/transcript.vtt'

    const itunesPayload = {
      resultCount: 2,
      results: [
        { wrapperType: 'track', kind: 'podcast', feedUrl },
        {
          wrapperType: 'podcastEpisode',
          trackId: 456,
          trackName: 'Episode 1',
          episodeUrl: 'https://example.com/preview.mp3',
          episodeFileExtension: 'mp3',
          trackTimeMillis: 60_000,
        },
      ],
    }

    const feedXml = `<?xml version="1.0" encoding="UTF-8"?><rss version="2.0" xmlns:podcast="https://podcastindex.org/namespace/1.0"><channel><item><title><![CDATA[Episode 1]]></title><podcast:transcript url="${transcriptUrl}" type="text/vtt"/></item></channel></rss>`
    const vtt = `WEBVTT

00:00:00.000 --> 00:00:01.000
Hello from VTT
`

    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString()
      if (url.startsWith('https://itunes.apple.com/lookup')) {
        return new Response(JSON.stringify(itunesPayload), {
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
        return new Response(vtt, { status: 200, headers: { 'content-type': 'text/vtt' } })
      }
      throw new Error(`Unexpected fetch: ${url}`)
    })

    const result = await fetchTranscript(
      { url: appleUrl, html: null, resourceKey: null },
      {
        ...baseOptions,
        fetch: fetchImpl as unknown as typeof fetch,
        openaiApiKey: null,
        falApiKey: null,
      }
    )

    expect(result.source).toBe('podcastTranscript')
    expect(result.text).toBe('Hello from VTT')
    expect(result.attemptedProviders).toEqual(['podcastTranscript'])
  })

  it('extracts RSS enclosure URL and decodes &amp;', async () => {
    const enclosureUrl = 'https://example.com/episode.mp3?p=1&amp;t=podcast&amp;size=123'
    const xml = `<?xml version="1.0" encoding="UTF-8"?><rss version="2.0"><channel><item><itunes:duration>12:34</itunes:duration><enclosure url="${enclosureUrl}" type="audio/mpeg"/></item></channel></rss>`

    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url =
        typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      expect(url).toBe('https://example.com/episode.mp3?p=1&t=podcast&size=123')
      return new Response(new Uint8Array([0, 1, 2, 3]), {
        status: 200,
        headers: { 'content-type': 'audio/mpeg' },
      })
    })

    const openaiFetch = vi.fn(async () => {
      return new Response(JSON.stringify({ text: 'hello world' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    })
    try {
      vi.stubGlobal('fetch', openaiFetch)
      const result = await fetchTranscript(
        { url: 'https://example.com/feed.xml', html: xml, resourceKey: null },
        { ...baseOptions, fetch: fetchImpl as unknown as typeof fetch }
      )

      expect(result.source).toBe('whisper')
      expect(result.text).toContain('hello')
      expect(result.attemptedProviders).toEqual(['whisper'])
      expect(result.metadata?.durationSeconds).toBe(12 * 60 + 34)
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('extracts Apple Podcasts streamUrl from HTML and decodes \\u0026', async () => {
    const html =
      '<html><head></head><body><script>{"playAction":{"episodeOffer":{"streamUrl":"https://example.com/episode.mp3?x=1\\u0026y=2"}}}</script></body></html>'

    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url =
        typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      const method = (init?.method ?? 'GET').toUpperCase()
      if (method === 'HEAD') {
        return new Response(null, {
          status: 200,
          headers: { 'content-type': 'audio/mpeg', 'content-length': '4' },
        })
      }
      expect(url).toBe('https://example.com/episode.mp3?x=1&y=2')
      return new Response(new Uint8Array([0, 1, 2, 3]), {
        status: 200,
        headers: { 'content-type': 'audio/mpeg', 'content-length': '4' },
      })
    })

    const openaiFetch = vi.fn(async () => {
      return new Response(JSON.stringify({ text: 'hello from apple' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    })

    try {
      vi.stubGlobal('fetch', openaiFetch)
      const result = await fetchTranscript(
        { url: 'https://podcasts.apple.com/us/podcast/x/id1?i=2', html, resourceKey: null },
        { ...baseOptions, fetch: fetchImpl as unknown as typeof fetch }
      )

      expect(result.source).toBe('whisper')
      expect(result.text).toContain('hello from apple')
      expect(result.attemptedProviders).toEqual(['whisper'])
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('resolves Spotify episode via iTunes RSS enclosure and ignores og:audio preview clips + DRM audio', async () => {
    const html =
      '<html><head><meta property="og:audio" content="https://example.com/clip.mp3"/></head><body></body></html>'

    const showTitle = 'My Podcast Show'
    const episodeTitle = 'Episode 1'
    const drmAudioUrl = 'https://audio4-fa.scdn.co/audio/abc123?token=1'
    const feedUrl = 'https://example.com/feed.xml'
    const enclosureUrl = 'https://example.com/episode.mp3'

    const nextData = {
      props: {
        pageProps: {
          state: {
            data: {
              entity: {
                title: episodeTitle,
                subtitle: showTitle,
                defaultAudioFileObject: {
                  format: 'MP4_128_CBCS',
                  url: [drmAudioUrl],
                },
              },
            },
          },
        },
      },
    }

    const embedHtml = `<html><head></head><body><script id="__NEXT_DATA__" type="application/json">${JSON.stringify(
      nextData
    )}</script></body></html>`

    const feedXml = `<?xml version="1.0" encoding="UTF-8"?><rss version="2.0"><channel><item><title><![CDATA[${episodeTitle}]]></title><itunes:duration>01:02:03</itunes:duration><enclosure url="${enclosureUrl}" type="audio/mpeg"/></item></channel></rss>`

    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url =
        typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      const method = (init?.method ?? 'GET').toUpperCase()

      if (url === 'https://open.spotify.com/embed/episode/abc') {
        return new Response(embedHtml, {
          status: 200,
          headers: { 'content-type': 'text/html' },
        })
      }

      if (url.startsWith('https://itunes.apple.com/search')) {
        return new Response(
          JSON.stringify({
            resultCount: 1,
            results: [{ collectionName: showTitle, feedUrl }],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        )
      }

      if (url === feedUrl) {
        return new Response(feedXml, {
          status: 200,
          headers: { 'content-type': 'application/xml' },
        })
      }

      if (url === enclosureUrl) {
        if (method === 'HEAD') {
          return new Response(null, {
            status: 200,
            headers: { 'content-type': 'audio/mpeg', 'content-length': '4' },
          })
        }
        return new Response(null, {
          status: 200,
          headers: { 'content-type': 'audio/mpeg', 'content-length': '4' },
        })
      }
      throw new Error(`Unexpected fetch: ${method} ${url}`)
    })

    const openaiFetch = vi.fn(async () => {
      return new Response(JSON.stringify({ text: 'hello from enclosure' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    })

    try {
      vi.stubGlobal('fetch', openaiFetch)
      const result = await fetchTranscript(
        { url: 'https://open.spotify.com/episode/abc', html, resourceKey: null },
        { ...baseOptions, fetch: fetchImpl as unknown as typeof fetch }
      )

      expect(result.source).toBe('whisper')
      expect(result.text).toContain('hello from enclosure')
      expect(result.attemptedProviders).toEqual(['whisper'])
      expect(result.metadata?.durationSeconds).toBe(1 * 3600 + 2 * 60 + 3)
      expect(
        fetchImpl.mock.calls.some(([callInput]) => {
          const calledUrl =
            typeof callInput === 'string'
              ? callInput
              : callInput instanceof URL
                ? callInput.toString()
                : callInput.url
          return calledUrl === 'https://example.com/clip.mp3' || calledUrl === drmAudioUrl
        })
      ).toBe(false)
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('falls back to Firecrawl when Spotify embed HTML is blocked (captcha)', async () => {
    const html =
      '<html><head><meta property="og:audio" content="https://example.com/clip.mp3"/></head><body></body></html>'

    const blockedEmbedHtml = '<html><body>captcha</body></html>'

    const showTitle = 'My Podcast Show'
    const episodeTitle = 'Episode 1'
    const feedUrl = 'https://example.com/feed.xml'
    const enclosureUrl = 'https://example.com/episode.mp3'

    const okEmbedHtml = `<html><head></head><body><script id="__NEXT_DATA__" type="application/json">${JSON.stringify(
      {
        props: {
          pageProps: { state: { data: { entity: { title: episodeTitle, subtitle: showTitle } } } },
        },
      }
    )}</script></body></html>`

    const feedXml = `<?xml version="1.0" encoding="UTF-8"?><rss version="2.0"><channel><item><title><![CDATA[${episodeTitle}]]></title><enclosure url="${enclosureUrl}" type="audio/mpeg"/></item></channel></rss>`

    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url =
        typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      const method = (init?.method ?? 'GET').toUpperCase()

      if (url === 'https://open.spotify.com/embed/episode/abc') {
        return new Response(blockedEmbedHtml, {
          status: 200,
          headers: { 'content-type': 'text/html' },
        })
      }

      if (url.startsWith('https://itunes.apple.com/search')) {
        return new Response(
          JSON.stringify({
            resultCount: 1,
            results: [{ collectionName: showTitle, feedUrl }],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        )
      }

      if (url === feedUrl) {
        return new Response(feedXml, {
          status: 200,
          headers: { 'content-type': 'application/xml' },
        })
      }

      if (url === enclosureUrl) {
        if (method === 'HEAD') {
          return new Response(null, {
            status: 200,
            headers: { 'content-type': 'audio/mpeg', 'content-length': '4' },
          })
        }
        return new Response(new Uint8Array([0, 1, 2, 3]), {
          status: 200,
          headers: { 'content-type': 'audio/mpeg', 'content-length': '4' },
        })
      }

      throw new Error(`Unexpected fetch: ${method} ${url}`)
    })

    const scrapeWithFirecrawl = vi.fn(async () => {
      return { markdown: '', html: okEmbedHtml }
    })

    const openaiFetch = vi.fn(async () => {
      return new Response(JSON.stringify({ text: 'hello from firecrawl' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    })

    try {
      vi.stubGlobal('fetch', openaiFetch)
      const result = await fetchTranscript(
        { url: 'https://open.spotify.com/episode/abc', html, resourceKey: null },
        {
          ...baseOptions,
          fetch: fetchImpl as unknown as typeof fetch,
          scrapeWithFirecrawl:
            scrapeWithFirecrawl as unknown as typeof baseOptions.scrapeWithFirecrawl,
        }
      )

      expect(result.source).toBe('whisper')
      expect(result.text).toContain('hello from firecrawl')
      expect(scrapeWithFirecrawl).toHaveBeenCalled()
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('extracts Apple Podcasts feedUrl from HTML and uses Atom <link rel="enclosure">', async () => {
    const feedUrl = 'https://example.com/feed.xml'
    const enclosureUrl = 'https://example.com/episode.ogg'
    const html = `<html><body><script>{"episode":{"feedUrl":"${feedUrl}"}}</script></body></html>`

    const atom = `<?xml version="1.0" encoding="UTF-8"?><feed xmlns="http://www.w3.org/2005/Atom"><title>Test</title><itunes:duration>59</itunes:duration><link rel="enclosure" href="${enclosureUrl}" /></feed>`

    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url =
        typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      const method = (init?.method ?? 'GET').toUpperCase()

      if (url === feedUrl) {
        return new Response(atom, { status: 200, headers: { 'content-type': 'application/xml' } })
      }
      if (url === enclosureUrl) {
        if (method === 'HEAD') {
          return new Response(null, {
            status: 200,
            headers: { 'content-type': 'audio/ogg', 'content-length': '4' },
          })
        }
        return new Response(new Uint8Array([0, 1, 2, 3]), {
          status: 200,
          headers: { 'content-type': 'audio/ogg', 'content-length': '4' },
        })
      }
      throw new Error(`Unexpected fetch: ${method} ${url}`)
    })

    const openaiFetch = vi.fn(async () => {
      return new Response(JSON.stringify({ text: 'hello from atom enclosure' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    })

    try {
      vi.stubGlobal('fetch', openaiFetch)
      const result = await fetchTranscript(
        { url: 'https://podcasts.apple.com/us/podcast/x/id1?i=2', html, resourceKey: null },
        { ...baseOptions, fetch: fetchImpl as unknown as typeof fetch }
      )

      expect(result.source).toBe('whisper')
      expect(result.text).toContain('hello from atom enclosure')
      expect(result.metadata?.kind).toBe('apple_feed_url')
      expect(result.metadata?.durationSeconds).toBe(59)
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('returns a structured Spotify error when the embed page lacks __NEXT_DATA__', async () => {
    const html = '<html><head></head><body></body></html>'
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url =
        typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      if (url === 'https://open.spotify.com/embed/episode/abc') {
        return new Response('<html><body>ok but no data</body></html>', {
          status: 200,
          headers: { 'content-type': 'text/html' },
        })
      }
      throw new Error(`Unexpected fetch: ${url}`)
    })

    const result = await fetchTranscript(
      { url: 'https://open.spotify.com/episode/abc', html, resourceKey: null },
      { ...baseOptions, fetch: fetchImpl as unknown as typeof fetch }
    )

    expect(result.text).toBeNull()
    expect(result.source).toBeNull()
    expect(result.attemptedProviders).toEqual([])
    expect(result.notes).toContain('Spotify episode fetch failed')
    expect(result.metadata?.kind).toBe('spotify_itunes_rss_enclosure')
  })

  it('uses og:audio as a last resort when no feed enclosure is found', async () => {
    const ogAudioUrl = 'https://example.com/clip.mp3'
    const html = `<html><head><meta property="og:audio" content="${ogAudioUrl}"/></head><body></body></html>`

    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url =
        typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      const method = (init?.method ?? 'GET').toUpperCase()
      if (url === ogAudioUrl) {
        if (method === 'HEAD') {
          return new Response(null, {
            status: 200,
            headers: { 'content-type': 'audio/mpeg', 'content-length': '4' },
          })
        }
        return new Response(new Uint8Array([0, 1, 2, 3]), {
          status: 200,
          headers: { 'content-type': 'audio/mpeg', 'content-length': '4' },
        })
      }
      throw new Error(`Unexpected fetch: ${method} ${url}`)
    })

    const openaiFetch = vi.fn(async () => {
      return new Response(JSON.stringify({ text: 'hello from og audio' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    })

    try {
      vi.stubGlobal('fetch', openaiFetch)
      const result = await fetchTranscript(
        { url: 'https://example.com/podcast/episode', html, resourceKey: null },
        { ...baseOptions, fetch: fetchImpl as unknown as typeof fetch }
      )

      expect(result.source).toBe('whisper')
      expect(result.text).toContain('hello from og audio')
      expect(result.metadata?.kind).toBe('og_audio')
      expect(String(result.notes)).toContain('preview clip')
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('returns a stable reason when no enclosure is found', async () => {
    const result = await fetchTranscript(
      { url: 'https://example.com/nope', html: '<html></html>', resourceKey: null },
      { ...baseOptions, ytDlpPath: null }
    )

    expect(result.text).toBeNull()
    expect(result.source).toBeNull()
    expect(result.metadata?.reason).toBe('no_enclosure_and_no_yt_dlp')
  })

  it('extracts a top-level <enclosure> and parses MM:SS durations + &#38; entities', async () => {
    const enclosureUrl = 'https://example.com/episode.mp3?p=1&#38;t=podcast'
    const xml = `<?xml version="1.0" encoding="UTF-8"?><rss version="2.0"><channel><itunes:duration>02:03</itunes:duration><enclosure url="${enclosureUrl}" type="audio/mpeg"/></channel></rss>`

    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url =
        typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      const method = (init?.method ?? 'GET').toUpperCase()
      if (method === 'HEAD') {
        return new Response(null, {
          status: 200,
          headers: { 'content-type': 'audio/mpeg', 'content-length': '4' },
        })
      }
      expect(url).toBe('https://example.com/episode.mp3?p=1&t=podcast')
      return new Response(new Uint8Array([0, 1, 2, 3]), {
        status: 200,
        headers: { 'content-type': 'audio/mpeg', 'content-length': '4' },
      })
    })

    const openaiFetch = vi.fn(async () => {
      return new Response(JSON.stringify({ text: 'hello' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    })

    try {
      vi.stubGlobal('fetch', openaiFetch)
      const result = await fetchTranscript(
        { url: 'https://example.com/feed.xml', html: xml, resourceKey: null },
        { ...baseOptions, fetch: fetchImpl as unknown as typeof fetch }
      )

      expect(result.source).toBe('whisper')
      expect(result.metadata?.durationSeconds).toBe(2 * 60 + 3)
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('ignores invalid embedded JSON URLs', async () => {
    const html =
      '<html><body><script>{"playAction":{"episodeOffer":{"streamUrl":"\\u00ZZ"}}}</script></body></html>'

    const result = await fetchTranscript(
      { url: 'https://podcasts.apple.com/us/podcast/x/id1?i=2', html, resourceKey: null },
      { ...baseOptions, ytDlpPath: null }
    )

    expect(result.text).toBeNull()
    expect(result.metadata?.reason).toBe('no_enclosure_and_no_yt_dlp')
  })
})
