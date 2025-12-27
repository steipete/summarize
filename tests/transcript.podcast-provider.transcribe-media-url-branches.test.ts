import { describe, expect, it, vi } from 'vitest'

type SpawnPlan = 'ffmpeg-missing' | 'ffmpeg-ok'

async function importPodcastProvider({ spawnPlan }: { spawnPlan: SpawnPlan }) {
  vi.resetModules()

  vi.doMock('node:child_process', () => ({
    spawn: (_cmd: string, args: string[]) => {
      if (_cmd === 'ffprobe') {
        const handlers = new Map<string, (value?: unknown) => void>()
        const proc = {
          on(event: string, handler: (value?: unknown) => void) {
            handlers.set(event, handler)
            if (event === 'error') queueMicrotask(() => handler(new Error('spawn ENOENT')))
            return proc
          },
          stdout: { setEncoding: () => proc, on: () => proc },
        } as unknown
        return proc
      }

      if (_cmd !== 'ffmpeg' || !args.includes('-version')) {
        throw new Error(`Unexpected spawn: ${_cmd} ${args.join(' ')}`)
      }

      const handlers = new Map<string, (value?: unknown) => void>()
      const proc = {
        on(event: string, handler: (value?: unknown) => void) {
          handlers.set(event, handler)
          if (spawnPlan === 'ffmpeg-missing' && event === 'error') {
            queueMicrotask(() => handler(new Error('spawn ENOENT')))
          }
          if (spawnPlan === 'ffmpeg-ok' && event === 'close') {
            queueMicrotask(() => handler(0))
          }
          if (spawnPlan === 'ffmpeg-missing' && event === 'close') {
            queueMicrotask(() => handler(1))
          }
          return proc
        },
      } as unknown
      return proc
    },
  }))

  const mod = await import('../packages/core/src/content/transcript/providers/podcast.js')
  return mod
}

const baseOptions = {
  fetch: vi.fn() as unknown as typeof fetch,
  scrapeWithFirecrawl: null as unknown as ((...args: unknown[]) => unknown) | null,
  apifyApiToken: null,
  youtubeTranscriptMode: 'auto' as const,
  ytDlpPath: null as string | null,
  falApiKey: null as string | null,
  openaiApiKey: 'OPENAI' as string | null,
}

describe('podcast provider - transcribeMediaUrl branch coverage', () => {
  it('handles ffmpeg missing by downloading capped bytes and noting the limitation', async () => {
    const { fetchTranscript } = await importPodcastProvider({ spawnPlan: 'ffmpeg-missing' })
    const enclosureUrl = 'https://example.com/episode.mp3'
    const xml = `<rss><channel><item><enclosure url="${enclosureUrl}" type="audio/mpeg"/></item></channel></rss>`

    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url =
        typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      const method = (init?.method ?? 'GET').toUpperCase()
      if (method === 'HEAD') {
        return new Response(null, {
          status: 200,
          headers: { 'content-type': 'audio/mpeg', 'content-length': String(30 * 1024 * 1024) },
        })
      }
      expect(init?.headers).toMatchObject({ Range: expect.stringMatching(/^bytes=0-/) })
      expect(url).toBe(enclosureUrl)
      return new Response(new Uint8Array([1, 2, 3]), {
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
      expect(String(result.notes)).toContain('ffmpeg not available')
    } finally {
      vi.unstubAllGlobals()
      vi.doUnmock('node:child_process')
    }
  })

  it('falls back when HEAD fails by downloading to a temp file', async () => {
    const { fetchTranscript } = await importPodcastProvider({ spawnPlan: 'ffmpeg-ok' })
    const enclosureUrl = 'https://example.com/episode.mp3'
    const xml = `<rss><channel><item><enclosure url="${enclosureUrl}" type="audio/mpeg"/></item></channel></rss>`

    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url =
        typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      const method = (init?.method ?? 'GET').toUpperCase()
      if (method === 'HEAD') {
        throw new Error('no head')
      }
      expect(url).toBe(enclosureUrl)
      return new Response(new Uint8Array([1, 2, 3]), {
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

  it('rejects remote media that exceeds MAX_REMOTE_MEDIA_BYTES', async () => {
    const { fetchTranscript } = await importPodcastProvider({ spawnPlan: 'ffmpeg-ok' })
    const enclosureUrl = 'https://example.com/episode.mp3'
    const xml = `<rss><channel><item><enclosure url="${enclosureUrl}" type="audio/mpeg"/></item></channel></rss>`

    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const method = (init?.method ?? 'GET').toUpperCase()
      if (method === 'HEAD') {
        return new Response(null, {
          status: 200,
          headers: { 'content-type': 'audio/mpeg', 'content-length': String(999 * 1024 * 1024) },
        })
      }
      throw new Error('should not download')
    })

    const result = await fetchTranscript(
      { url: 'https://example.com/feed.xml', html: xml, resourceKey: null },
      { ...baseOptions, fetch: fetchImpl as unknown as typeof fetch }
    )

    expect(result.text).toBeNull()
    expect(result.source).toBeNull()
    expect(result.notes).toContain('Remote media too large')
  })

  it('handles capped downloads even when Response.body is null', async () => {
    const { fetchTranscript } = await importPodcastProvider({ spawnPlan: 'ffmpeg-missing' })
    const enclosureUrl = 'https://example.com/episode.mp3'
    const xml = `<rss><channel><item><enclosure url="${enclosureUrl}" type="audio/mpeg"/></item></channel></rss>`

    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const method = (init?.method ?? 'GET').toUpperCase()
      if (method === 'HEAD') {
        return new Response(null, {
          status: 200,
          headers: { 'content-type': 'audio/mpeg', 'content-length': String(30 * 1024 * 1024) },
        })
      }

      return {
        ok: true,
        status: 200,
        headers: new Headers({ 'content-type': 'audio/mpeg' }),
        body: null,
        async arrayBuffer() {
          return new Uint8Array([1, 2, 3]).buffer
        },
      } as unknown as Response
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
      expect(String(result.notes)).toContain('ffmpeg not available')
    } finally {
      vi.unstubAllGlobals()
      vi.doUnmock('node:child_process')
    }
  })

  it('handles file downloads even when Response.body is null', async () => {
    const { fetchTranscript } = await importPodcastProvider({ spawnPlan: 'ffmpeg-ok' })
    const enclosureUrl = 'https://example.com/episode.mp3'
    const xml = `<rss><channel><item><enclosure url="${enclosureUrl}" type="audio/mpeg"/></item></channel></rss>`

    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const method = (init?.method ?? 'GET').toUpperCase()
      if (method === 'HEAD') {
        // Force the temp-file path even though the download itself is tiny.
        return new Response(null, {
          status: 200,
          headers: { 'content-type': 'audio/mpeg', 'content-length': String(50 * 1024 * 1024) },
        })
      }
      return {
        ok: true,
        status: 200,
        headers: new Headers({ 'content-type': 'audio/mpeg' }),
        body: null,
        async arrayBuffer() {
          return new Uint8Array([1, 2, 3]).buffer
        },
      } as unknown as Response
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
})
