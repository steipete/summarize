import { describe, expect, it, vi } from 'vitest'

import { fetchTranscript } from '../packages/core/src/content/transcript/providers/podcast.js'

const baseOptions = {
  fetch: vi.fn() as unknown as typeof fetch,
  scrapeWithFirecrawl: null as unknown as ((...args: unknown[]) => unknown) | null,
  apifyApiToken: null,
  youtubeTranscriptMode: 'auto' as const,
  ytDlpPath: null,
  groqApiKey: null,
  falApiKey: null,
  openaiApiKey: 'OPENAI',
}

describe('podcast transcript provider - Spotify iTunes feed resolution', () => {
  it('prefers an exact iTunes title match (after normalization)', async () => {
    const showTitle = 'Café Ünicode'
    const episodeTitle = 'Episode 1'
    const feedUrl1 = 'https://example.com/feed1.xml'
    const feedUrl2 = 'https://example.com/feed2.xml'
    const enclosureUrl = 'https://example.com/episode.mp3'

    const embedHtml = `<script id="__NEXT_DATA__" type="application/json">${JSON.stringify({
      props: {
        pageProps: { state: { data: { entity: { title: episodeTitle, subtitle: showTitle } } } },
      },
    })}</script>`

    const feedXml = `<rss><channel><item><title><![CDATA[${episodeTitle}]]></title><enclosure url="${enclosureUrl}" type="audio/mpeg"/></item></channel></rss>`

    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url =
        typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      const method = (init?.method ?? 'GET').toUpperCase()

      if (url === 'https://open.spotify.com/embed/episode/abc') {
        return new Response(embedHtml, { status: 200, headers: { 'content-type': 'text/html' } })
      }
      if (url.startsWith('https://itunes.apple.com/search')) {
        return new Response(
          JSON.stringify({
            resultCount: 2,
            results: [
              { collectionName: 'Cafe Unicode Something', feedUrl: feedUrl1 },
              { collectionName: 'Cafe Unicode', feedUrl: feedUrl2 },
            ],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        )
      }
      if (url === feedUrl2) {
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

    const openaiFetch = vi.fn(async () => {
      return new Response(JSON.stringify({ text: 'ok' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    })

    try {
      vi.stubGlobal('fetch', openaiFetch)
      const result = await fetchTranscript(
        { url: 'https://open.spotify.com/episode/abc', html: '<html/>', resourceKey: null },
        { ...baseOptions, fetch: fetchImpl as unknown as typeof fetch }
      )

      expect(result.source).toBe('whisper')
      expect(result.metadata?.feedUrl).toBe(feedUrl2)
      expect(fetchImpl.mock.calls.some(([callInput]) => String(callInput).includes(feedUrl1))).toBe(
        false
      )
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('extracts episode enclosures from Atom-style <link rel="enclosure"> inside <item>', async () => {
    const showTitle = 'My Show'
    const episodeTitle = 'Episode 2'
    const feedUrl = 'https://example.com/feed.xml'
    const enclosureUrl = 'https://example.com/episode2.mp3'

    const embedHtml = `<script id="__NEXT_DATA__" type="application/json">${JSON.stringify({
      props: {
        pageProps: { state: { data: { entity: { title: episodeTitle, subtitle: showTitle } } } },
      },
    })}</script>`

    const feedXml = `<rss><channel><item><title>${episodeTitle}</title><itunes:duration>44</itunes:duration><link rel="enclosure" href="${enclosureUrl}" /></item></channel></rss>`

    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url =
        typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      const method = (init?.method ?? 'GET').toUpperCase()

      if (url === 'https://open.spotify.com/embed/episode/abc') {
        return new Response(embedHtml, { status: 200, headers: { 'content-type': 'text/html' } })
      }
      if (url.startsWith('https://itunes.apple.com/search')) {
        return new Response(
          JSON.stringify({ resultCount: 1, results: [{ collectionName: showTitle, feedUrl }] }),
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

    const openaiFetch = vi.fn(async () => {
      return new Response(JSON.stringify({ text: 'ok' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    })

    try {
      vi.stubGlobal('fetch', openaiFetch)
      const result = await fetchTranscript(
        { url: 'https://open.spotify.com/episode/abc', html: '<html/>', resourceKey: null },
        { ...baseOptions, fetch: fetchImpl as unknown as typeof fetch }
      )

      expect(result.source).toBe('whisper')
      expect(result.metadata?.durationSeconds).toBe(44)
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('falls back to iTunes episode search when feed lacks enclosure', async () => {
    const showTitle = 'Show Name'
    const episodeTitle = 'Episode Missing in Feed'
    const feedUrl = 'https://example.com/feed.xml'
    const episodeUrl = 'https://example.com/episode.mp3'

    const embedHtml = `<script id="__NEXT_DATA__" type="application/json">${JSON.stringify({
      props: {
        pageProps: { state: { data: { entity: { title: episodeTitle, subtitle: showTitle } } } },
      },
    })}</script>`

    const feedXml = `<rss><channel><item><title>Other episode</title></item></channel></rss>`

    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url =
        typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      const method = (init?.method ?? 'GET').toUpperCase()

      if (url === 'https://open.spotify.com/embed/episode/abc') {
        return new Response(embedHtml, { status: 200, headers: { 'content-type': 'text/html' } })
      }
      if (url.startsWith('https://itunes.apple.com/search')) {
        if (url.includes('entity=podcastEpisode')) {
          return new Response(
            JSON.stringify({
              resultCount: 1,
              results: [
                {
                  trackName: episodeTitle,
                  collectionName: showTitle,
                  episodeUrl,
                  trackTimeMillis: 90000,
                },
              ],
            }),
            { status: 200, headers: { 'content-type': 'application/json' } }
          )
        }
        return new Response(
          JSON.stringify({ resultCount: 1, results: [{ collectionName: showTitle, feedUrl }] }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        )
      }
      if (url === feedUrl) {
        return new Response(feedXml, {
          status: 200,
          headers: { 'content-type': 'application/xml' },
        })
      }
      if (url === episodeUrl) {
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
      return new Response(JSON.stringify({ text: 'ok' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    })

    try {
      vi.stubGlobal('fetch', openaiFetch)
      const result = await fetchTranscript(
        { url: 'https://open.spotify.com/episode/abc', html: '<html/>', resourceKey: null },
        { ...baseOptions, fetch: fetchImpl as unknown as typeof fetch }
      )

      expect(result.source).toBe('whisper')
      expect(result.metadata?.kind).toBe('spotify_itunes_search_episode')
      expect(result.metadata?.episodeUrl).toBe(episodeUrl)
    } finally {
      vi.unstubAllGlobals()
    }
  })
})
