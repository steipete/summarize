import { describe, expect, it, vi } from 'vitest'

import { fetchLinkContent } from '../packages/core/src/content/link-preview/content/index.js'

describe('Spotify episode short-circuit', () => {
  it('skips fetching the Spotify episode HTML page and returns transcript content (URL variations)', async () => {
    const episodeId = '5auotqWAXhhKyb9ymCuBJY'
    const urls = [
      `https://open.spotify.com/episode/${episodeId}`,
      `https://open.spotify.com/episode/${episodeId}?si=deadbeef`,
      `https://open.spotify.com/episode/${episodeId}/`,
      `https://open.spotify.com/embed/episode/${episodeId}`,
    ]
    const showTitle = 'My Podcast Show'
    const episodeTitle = 'Episode 1'
    const feedUrl = 'https://example.com/feed.xml'
    const enclosureUrl = 'https://example.com/episode.mp3'

    const embedHtml = `<html><body><script id="__NEXT_DATA__" type="application/json">${JSON.stringify(
      {
        props: {
          pageProps: { state: { data: { entity: { title: episodeTitle, subtitle: showTitle } } } },
        },
      }
    )}</script></body></html>`

    const feedXml = `<?xml version="1.0" encoding="UTF-8"?><rss version="2.0"><channel><item><title><![CDATA[${episodeTitle}]]></title><enclosure url="${enclosureUrl}" type="audio/mpeg"/></item></channel></rss>`

    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const resolved =
        typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      const method = (init?.method ?? 'GET').toUpperCase()

      if (resolved.startsWith('https://open.spotify.com/episode/')) {
        throw new Error('should not fetch episode HTML')
      }

      if (resolved === `https://open.spotify.com/embed/episode/${episodeId}`) {
        return new Response(embedHtml, { status: 200, headers: { 'content-type': 'text/html' } })
      }

      if (resolved.startsWith('https://itunes.apple.com/search')) {
        return new Response(
          JSON.stringify({
            resultCount: 1,
            results: [{ collectionName: showTitle, feedUrl }],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        )
      }

      if (resolved === feedUrl) {
        return new Response(feedXml, {
          status: 200,
          headers: { 'content-type': 'application/xml' },
        })
      }

      if (resolved === enclosureUrl) {
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

      throw new Error(`unexpected fetch: ${method} ${resolved}`)
    })

    const openaiFetch = vi.fn(async (input: RequestInfo | URL) => {
      const resolved =
        typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      expect(resolved).toContain('https://api.openai.com/v1/audio/transcriptions')
      return new Response(JSON.stringify({ text: 'hello world from spotify' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    })

    try {
      vi.stubGlobal('fetch', openaiFetch as unknown as typeof fetch)

      for (const url of urls) {
        const result = await fetchLinkContent(
          url,
          { cacheMode: 'bypass', timeoutMs: 60_000 },
          {
            fetch: fetchImpl as unknown as typeof fetch,
            scrapeWithFirecrawl: null,
            apifyApiToken: null,
            ytDlpPath: null,
            groqApiKey: null,
            falApiKey: null,
            openaiApiKey: 'OPENAI',
            convertHtmlToMarkdown: null,
            transcriptCache: null,
          }
        )

        expect(result.transcriptSource).toBe('whisper')
        expect(result.content).toContain('Transcript:')
        expect(result.content).toContain('hello world from spotify')
      }
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('fails loudly when no transcription keys are configured', async () => {
    await expect(
      fetchLinkContent(
        'https://open.spotify.com/episode/5auotqWAXhhKyb9ymCuBJY',
        { cacheMode: 'bypass', timeoutMs: 60_000 },
        {
          fetch: vi.fn() as unknown as typeof fetch,
          scrapeWithFirecrawl: null,
          apifyApiToken: null,
          ytDlpPath: null,
          groqApiKey: null,
          falApiKey: null,
          openaiApiKey: null,
          convertHtmlToMarkdown: null,
          transcriptCache: null,
        }
      )
    ).rejects.toThrow(/OPENAI_API_KEY or FAL_KEY/i)
  })
})
