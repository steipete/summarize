import { describe, expect, it, vi } from 'vitest'

import { MAX_OPENAI_UPLOAD_BYTES } from '../packages/core/src/transcription/whisper.js'

type SpawnPlan = 'ffmpeg-ok' | 'ffmpeg-missing'

async function importPodcastProviderWithFfmpeg(plan: SpawnPlan) {
  vi.resetModules()
  vi.doMock('node:child_process', () => ({
    spawn: (_cmd: string, args: string[]) => {
      if (_cmd !== 'ffmpeg' || !args.includes('-version')) {
        throw new Error(`Unexpected spawn: ${_cmd} ${args.join(' ')}`)
      }
      const handlers = new Map<string, (value?: unknown) => void>()
      const proc = {
        on(event: string, handler: (value?: unknown) => void) {
          handlers.set(event, handler)
          return proc
        },
      } as unknown
      queueMicrotask(() => {
        if (plan === 'ffmpeg-ok') handlers.get('close')?.(0)
        else handlers.get('error')?.(new Error('spawn ENOENT'))
      })
      return proc
    },
  }))

  return await import('../packages/core/src/content/transcript/providers/podcast.js')
}

const baseOptions = {
  fetch: vi.fn() as unknown as typeof fetch,
  scrapeWithFirecrawl: null as unknown as ((...args: unknown[]) => unknown) | null,
  apifyApiToken: null,
  youtubeTranscriptMode: 'auto' as const,
  ytDlpPath: null,
  falApiKey: null,
  openaiApiKey: 'OPENAI',
  onProgress: null,
}

describe('podcast transcript provider - more branches 3', () => {
  it('returns a helpful message when transcription keys are missing', async () => {
    const { fetchTranscript } = await import(
      '../packages/core/src/content/transcript/providers/podcast.js'
    )
    const result = await fetchTranscript(
      { url: 'https://example.com/feed.xml', html: '<rss/>', resourceKey: null },
      { ...baseOptions, openaiApiKey: null, falApiKey: null }
    )
    expect(result.text).toBeNull()
    expect(result.metadata?.reason).toBe('missing_transcription_keys')
  })

  it('reports "remote media too large" via the Apple feedUrl fallback', async () => {
    const { fetchTranscript } = await importPodcastProviderWithFfmpeg('ffmpeg-ok')
    const appleHtml = `<html><body><script type="application/json">${JSON.stringify({
      props: {
        pageProps: { state: { data: { some: { feedUrl: 'https://example.com/feed.xml' } } } },
      },
    })}</script>feedUrl</body></html>`
    const xml = `<rss><channel><item><title>Ep</title><enclosure url="https://cdn.example.com/ep.mp3" type="audio/mpeg"/></item></channel></rss>`

    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url =
        typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      if (url === 'https://example.com/feed.xml') {
        return new Response(xml, { status: 200, headers: { 'content-type': 'application/xml' } })
      }
      if (
        url === 'https://cdn.example.com/ep.mp3' &&
        (init?.method ?? 'GET').toUpperCase() === 'HEAD'
      ) {
        return new Response(null, {
          status: 200,
          headers: {
            'content-type': 'audio/mpeg',
            'content-length': String(513 * 1024 * 1024),
          },
        })
      }
      throw new Error(`Unexpected fetch: ${url} ${String(init?.method ?? 'GET')}`)
    })

    const result = await fetchTranscript(
      {
        url: 'https://podcasts.apple.com/us/podcast/id123?i=456',
        html: appleHtml,
        resourceKey: null,
      },
      { ...baseOptions, fetch: fetchImpl as unknown as typeof fetch }
    )
    expect(result.text).toBeNull()
    expect(result.notes).toContain('Remote media too large')
  })

  it('covers the capped-bytes path when ffmpeg is unavailable', async () => {
    const { fetchTranscript } = await importPodcastProviderWithFfmpeg('ffmpeg-missing')
    const enclosureUrl = 'https://example.com/episode.mp3'
    const xml = `<rss><channel><item><title>Ep</title><enclosure url="${enclosureUrl}" type="audio/mpeg"/></item></channel></rss>`

    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const method = (init?.method ?? 'GET').toUpperCase()
      if (method === 'HEAD') {
        return new Response(null, {
          status: 200,
          headers: {
            'content-type': 'audio/mpeg',
            'content-length': String(MAX_OPENAI_UPLOAD_BYTES + 10),
          },
        })
      }
      return new Response(new Uint8Array([1, 2, 3, 4]), {
        status: 200,
        headers: { 'content-type': 'audio/mpeg' },
      })
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
        { url: 'https://example.com/feed.xml', html: xml, resourceKey: null },
        { ...baseOptions, fetch: fetchImpl as unknown as typeof fetch }
      )
      expect(result.source).toBe('whisper')
      expect(result.text).toBe('ok')
    } finally {
      vi.unstubAllGlobals()
      vi.doUnmock('node:child_process')
    }
  })

  it('reports enclosure download errors in rss_enclosure mode', async () => {
    const { fetchTranscript } = await importPodcastProviderWithFfmpeg('ffmpeg-ok')
    const enclosureUrl = 'https://example.com/episode.mp3'
    const xml = `<rss><channel><item><title>Ep</title><enclosure url="${enclosureUrl}" type="audio/mpeg"/></item></channel></rss>`

    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const url =
        typeof _input === 'string' ? _input : _input instanceof URL ? _input.toString() : _input.url
      const method = (init?.method ?? 'GET').toUpperCase()
      if (method === 'HEAD') {
        return new Response(null, {
          status: 200,
          headers: {
            'content-type': 'audio/mpeg',
            'content-length': String(MAX_OPENAI_UPLOAD_BYTES + 10),
          },
        })
      }
      if (url === enclosureUrl) {
        return new Response('nope', { status: 403, headers: { 'content-type': 'text/plain' } })
      }
      throw new Error(`Unexpected fetch: ${url}`)
    })

    const result = await fetchTranscript(
      { url: 'https://example.com/feed.xml', html: xml, resourceKey: null },
      { ...baseOptions, fetch: fetchImpl as unknown as typeof fetch }
    )
    expect(result.text).toBeNull()
    expect(result.notes).toContain('Podcast enclosure download failed')
  })
})
