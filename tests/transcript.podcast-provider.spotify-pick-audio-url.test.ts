import { describe, expect, it, vi } from 'vitest'

vi.mock('node:child_process', () => ({
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
    queueMicrotask(() => handlers.get('close')?.(0))
    return proc
  },
}))

import { fetchTranscript } from '../packages/core/src/content/transcript/providers/podcast.js'

describe('podcast transcript provider - spotify audio url selection branches', () => {
  it('falls back to the first embed audio URL when no scdn URL is present', async () => {
    const longTranscript = 'hello from spotify '.repeat(20).trim()

    const embedHtml = `<script id="__NEXT_DATA__" type="application/json">${JSON.stringify({
      props: {
        pageProps: {
          state: {
            data: {
              entity: { title: 'Ep 1', subtitle: 'Show', duration: 120_000 },
              defaultAudioFileObject: { url: ['https://cdn.example.com/a.mp4'] },
            },
          },
        },
      },
    })}</script>`

    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url =
        typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      const method = (init?.method ?? 'GET').toUpperCase()
      if (url === 'https://open.spotify.com/embed/episode/abc') {
        return new Response(embedHtml, { status: 200, headers: { 'content-type': 'text/html' } })
      }
      if (url === 'https://cdn.example.com/a.mp4' && method === 'HEAD') {
        return new Response(null, {
          status: 200,
          headers: { 'content-type': 'audio/mp4', 'content-length': '1024' },
        })
      }
      if (url === 'https://cdn.example.com/a.mp4' && method === 'GET') {
        return new Response(new Uint8Array([1, 2, 3]), {
          status: 200,
          headers: { 'content-type': 'audio/mp4' },
        })
      }
      throw new Error(`Unexpected fetch: ${url} ${method}`)
    })

    const openaiFetch = vi.fn(async () => {
      return new Response(JSON.stringify({ text: longTranscript }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    })

    try {
      vi.stubGlobal('fetch', openaiFetch)
      const result = await fetchTranscript(
        { url: 'https://open.spotify.com/episode/abc', html: '<html/>', resourceKey: null },
        {
          fetch: fetchImpl as unknown as typeof fetch,
          scrapeWithFirecrawl: null,
          apifyApiToken: null,
          youtubeTranscriptMode: 'auto',
          ytDlpPath: null,
          groqApiKey: null,
          falApiKey: null,
          openaiApiKey: 'OPENAI',
          onProgress: null,
        }
      )
      expect(result.text).toBe(longTranscript)
      expect(result.metadata?.kind).toBe('spotify_embed_audio')
      expect(result.metadata?.audioUrl).toBe('https://cdn.example.com/a.mp4')
      expect(result.notes).toContain('Resolved Spotify embed audio')
    } finally {
      vi.unstubAllGlobals()
    }
  })
})
