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

describe('podcast transcript provider - Spotify error modes', () => {
  it('handles non-OK Spotify embed fetch', async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url =
        typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      if (url === 'https://open.spotify.com/embed/episode/abc') {
        return new Response('nope', { status: 403, headers: { 'content-type': 'text/html' } })
      }
      throw new Error(`Unexpected fetch: ${url}`)
    })

    const result = await fetchTranscript(
      { url: 'https://open.spotify.com/episode/abc', html: '<html/>', resourceKey: null },
      { ...baseOptions, fetch: fetchImpl as unknown as typeof fetch }
    )

    expect(result.text).toBeNull()
    expect(result.notes).toContain('Spotify episode fetch failed')
    expect(result.notes).toContain('Spotify embed fetch failed (403)')
  })

  it('does not require Firecrawl when the embed page is blocked but Firecrawl is not configured', async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url =
        typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      if (url === 'https://open.spotify.com/embed/episode/abc') {
        return new Response('<html><body>captcha</body></html>', {
          status: 200,
          headers: { 'content-type': 'text/html' },
        })
      }
      throw new Error(`Unexpected fetch: ${url}`)
    })

    const result = await fetchTranscript(
      { url: 'https://open.spotify.com/episode/abc', html: '<html/>', resourceKey: null },
      { ...baseOptions, fetch: fetchImpl as unknown as typeof fetch, scrapeWithFirecrawl: null }
    )

    expect(result.text).toBeNull()
    expect(result.notes).toContain('Spotify episode fetch failed')
    expect(result.notes).toContain('blocked')
  })

  it('errors when Firecrawl fallback returns empty content', async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url =
        typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      if (url === 'https://open.spotify.com/embed/episode/abc') {
        return new Response('<html><body>captcha</body></html>', {
          status: 200,
          headers: { 'content-type': 'text/html' },
        })
      }
      throw new Error(`Unexpected fetch: ${url}`)
    })
    const scrapeWithFirecrawl = vi.fn(async () => ({ markdown: '', html: '' }))

    const result = await fetchTranscript(
      { url: 'https://open.spotify.com/episode/abc', html: '<html/>', resourceKey: null },
      {
        ...baseOptions,
        fetch: fetchImpl as unknown as typeof fetch,
        scrapeWithFirecrawl:
          scrapeWithFirecrawl as unknown as typeof baseOptions.scrapeWithFirecrawl,
      }
    )

    expect(result.text).toBeNull()
    expect(result.notes).toContain('Firecrawl returned empty content')
  })

  it('errors when Spotify embed is blocked even via Firecrawl', async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url =
        typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      if (url === 'https://open.spotify.com/embed/episode/abc') {
        return new Response('<html><body>captcha</body></html>', {
          status: 200,
          headers: { 'content-type': 'text/html' },
        })
      }
      throw new Error(`Unexpected fetch: ${url}`)
    })
    const scrapeWithFirecrawl = vi.fn(async () => ({
      markdown: '',
      html: '<html>recaptcha</html>',
    }))

    const result = await fetchTranscript(
      { url: 'https://open.spotify.com/episode/abc', html: '<html/>', resourceKey: null },
      {
        ...baseOptions,
        fetch: fetchImpl as unknown as typeof fetch,
        scrapeWithFirecrawl:
          scrapeWithFirecrawl as unknown as typeof baseOptions.scrapeWithFirecrawl,
      }
    )

    expect(result.text).toBeNull()
    expect(result.notes).toContain('blocked even via Firecrawl')
  })

  it('errors when embed HTML lacks usable titles in __NEXT_DATA__', async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url =
        typeof input === 'string' ? input : input instanceof URL ? input : new URL(input.url)
      if (url.toString() === 'https://open.spotify.com/embed/episode/abc') {
        return new Response(
          '<script id="__NEXT_DATA__" type="application/json">{"props":{"pageProps":{"state":{"data":{"entity":{"title":"","subtitle":""}}}}}}</script>',
          { status: 200, headers: { 'content-type': 'text/html' } }
        )
      }
      throw new Error(`Unexpected fetch: ${url}`)
    })

    const result = await fetchTranscript(
      { url: 'https://open.spotify.com/episode/abc', html: '<html/>', resourceKey: null },
      { ...baseOptions, fetch: fetchImpl as unknown as typeof fetch }
    )

    expect(result.text).toBeNull()
    expect(result.notes).toContain('Spotify embed data not found')
  })

  it('errors when iTunes Search fails to resolve an RSS feed', async () => {
    const showTitle = 'My Podcast Show'
    const episodeTitle = 'Episode 1'
    const embedHtml = `<script id="__NEXT_DATA__" type="application/json">${JSON.stringify({
      props: {
        pageProps: { state: { data: { entity: { title: episodeTitle, subtitle: showTitle } } } },
      },
    })}</script>`

    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url =
        typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      if (url === 'https://open.spotify.com/embed/episode/abc') {
        return new Response(embedHtml, { status: 200, headers: { 'content-type': 'text/html' } })
      }
      if (url.startsWith('https://itunes.apple.com/search')) {
        return new Response('nope', { status: 500, headers: { 'content-type': 'text/plain' } })
      }
      throw new Error(`Unexpected fetch: ${url}`)
    })

    const result = await fetchTranscript(
      { url: 'https://open.spotify.com/episode/abc', html: '<html/>', resourceKey: null },
      { ...baseOptions, fetch: fetchImpl as unknown as typeof fetch }
    )

    expect(result.text).toBeNull()
    expect(result.notes).toContain('could not resolve RSS feed')
  })
})
