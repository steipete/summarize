import { describe, expect, it, vi } from 'vitest'

type WhisperResult = {
  text: string | null
  provider: string | null
  notes: string[]
  error: Error | null
}

async function importPodcastProvider({ ffmpegAvailable }: { ffmpegAvailable: boolean }) {
  vi.resetModules()

  const transcribeMediaWithWhisper = vi.fn(
    async (): Promise<WhisperResult> => ({
      text: 'ok',
      provider: 'openai',
      notes: [],
      error: null,
    })
  )
  const transcribeMediaFileWithWhisper = vi.fn(
    async (): Promise<WhisperResult> => ({
      text: 'ok',
      provider: 'openai',
      notes: [],
      error: null,
    })
  )

  vi.doMock('../packages/core/src/transcription/whisper.js', () => ({
    MAX_OPENAI_UPLOAD_BYTES: 25 * 1024 * 1024,
    isFfmpegAvailable: async () => ffmpegAvailable,
    isWhisperCppReady: () => Promise.resolve(false),
    probeMediaDurationSecondsWithFfprobe: async () => null,
    resolveWhisperCppModelNameForDisplay: async () => null,
    transcribeMediaWithWhisper,
    transcribeMediaFileWithWhisper,
  }))

  const provider = await import(
    '../packages/core/src/content/link-preview/transcript/providers/podcast.js'
  )
  return { ...provider, transcribeMediaWithWhisper, transcribeMediaFileWithWhisper }
}

const baseOptions = {
  scrapeWithFirecrawl: null as unknown as ((...args: unknown[]) => unknown) | null,
  apifyApiToken: null,
  youtubeTranscriptMode: 'auto' as const,
  ytDlpPath: null,
  falApiKey: null,
  openaiApiKey: 'OPENAI',
}

describe('podcast transcript provider extra branches', () => {
  it('parses itunes:duration as seconds and decodes &amp; in enclosure URLs', async () => {
    const { fetchTranscript, transcribeMediaWithWhisper } = await importPodcastProvider({
      ffmpegAvailable: false,
    })
    const enclosureUrl = 'https://example.com/episode.mp3?p=1&amp;t=podcast'
    const xml = `<?xml version="1.0" encoding="UTF-8"?><rss version="2.0"><channel><item><itunes:duration>123</itunes:duration><enclosure url="${enclosureUrl}" type="audio/mpeg"/></item></channel></rss>`

    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url =
        typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      const method = (init?.method ?? 'GET').toUpperCase()
      if (method === 'HEAD') {
        return new Response(null, {
          status: 200,
          headers: { 'content-type': 'audio/mpeg; charset=utf-8', 'content-length': '4' },
        })
      }
      expect(url).toBe('https://example.com/episode.mp3?p=1&t=podcast')
      return new Response(new Uint8Array([1, 2, 3, 4]), { status: 200 })
    })

    const result = await fetchTranscript(
      { url: 'https://example.com/feed.xml', html: xml, resourceKey: null },
      { ...baseOptions, fetch: fetchImpl as unknown as typeof fetch }
    )

    expect(result.source).toBe('whisper')
    expect(result.text).toBe('ok')
    expect(result.metadata?.durationSeconds).toBe(123)
    expect(transcribeMediaWithWhisper).toHaveBeenCalled()
  })

  it('treats itunes:duration 00:00 as unavailable', async () => {
    const { fetchTranscript } = await importPodcastProvider({ ffmpegAvailable: false })
    const enclosureUrl = 'https://example.com/episode.mp3'
    const xml = `<?xml version="1.0" encoding="UTF-8"?><rss version="2.0"><channel><item><itunes:duration>00:00</itunes:duration><enclosure url="${enclosureUrl}" type="audio/mpeg"/></item></channel></rss>`

    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const method = (init?.method ?? 'GET').toUpperCase()
      if (method === 'HEAD') {
        return new Response(null, {
          status: 200,
          headers: { 'content-type': 'audio/mpeg', 'content-length': '4' },
        })
      }
      return new Response(new Uint8Array([1, 2, 3, 4]), { status: 200 })
    })

    const result = await fetchTranscript(
      { url: 'https://example.com/feed.xml', html: xml, resourceKey: null },
      { ...baseOptions, fetch: fetchImpl as unknown as typeof fetch }
    )

    expect(result.source).toBe('whisper')
    expect(result.metadata?.durationSeconds).toBeNull()
  })

  it('errors when remote media exceeds the hard size cap', async () => {
    const { fetchTranscript } = await importPodcastProvider({ ffmpegAvailable: true })
    const enclosureUrl = 'https://example.com/huge.mp3'
    const xml = `<rss><channel><item><enclosure url="${enclosureUrl}" type="audio/mpeg"/></item></channel></rss>`

    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const method = (init?.method ?? 'GET').toUpperCase()
      if (method === 'HEAD') {
        return new Response(null, {
          status: 200,
          headers: { 'content-type': 'audio/mpeg', 'content-length': String(600 * 1024 * 1024) },
        })
      }
      throw new Error('unexpected download')
    })

    const result = await fetchTranscript(
      { url: 'https://example.com/feed.xml', html: xml, resourceKey: null },
      { ...baseOptions, fetch: fetchImpl as unknown as typeof fetch }
    )

    expect(result.text).toBeNull()
    expect(result.notes).toContain('Remote media too large')
  })

  it('falls back to temp-file transcription when HEAD fails and ffmpeg is available', async () => {
    const { fetchTranscript, transcribeMediaFileWithWhisper } = await importPodcastProvider({
      ffmpegAvailable: true,
    })
    const enclosureUrl = 'https://example.com/episode.mp3'
    const xml = `<rss><channel><item><enclosure url="${enclosureUrl}" type="audio/mpeg"/></item></channel></rss>`

    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const method = (init?.method ?? 'GET').toUpperCase()
      if (method === 'HEAD') {
        throw new Error('head failed')
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

    const result = await fetchTranscript(
      { url: 'https://example.com/feed.xml', html: xml, resourceKey: null },
      { ...baseOptions, fetch: fetchImpl as unknown as typeof fetch }
    )

    expect(result.source).toBe('whisper')
    expect(transcribeMediaFileWithWhisper).toHaveBeenCalled()
  })

  it('propagates download errors when the enclosure request is non-OK', async () => {
    const { fetchTranscript } = await importPodcastProvider({ ffmpegAvailable: false })
    const enclosureUrl = 'https://example.com/episode.mp3'
    const xml = `<rss><channel><item><enclosure url="${enclosureUrl}" type="audio/mpeg"/></item></channel></rss>`

    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const method = (init?.method ?? 'GET').toUpperCase()
      if (method === 'HEAD') {
        return new Response(null, {
          status: 200,
          headers: { 'content-type': 'audio/mpeg', 'content-length': '4' },
        })
      }
      return new Response('nope', { status: 500 })
    })

    const result = await fetchTranscript(
      { url: 'https://example.com/feed.xml', html: xml, resourceKey: null },
      { ...baseOptions, fetch: fetchImpl as unknown as typeof fetch }
    )

    expect(result.text).toBeNull()
    expect(result.notes).toContain('Download failed (500)')
  })

  it('extracts enclosures from Atom feeds via <link rel="enclosure">', async () => {
    const { fetchTranscript } = await importPodcastProvider({ ffmpegAvailable: false })
    const enclosureUrl = 'https://example.com/episode.mp3'
    const atom = `<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom"><entry><link rel="enclosure" href="${enclosureUrl}" type="audio/mpeg"/></entry></feed>`

    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const method = (init?.method ?? 'GET').toUpperCase()
      if (method === 'HEAD') {
        return new Response(null, {
          status: 200,
          headers: { 'content-type': 'audio/mpeg', 'content-length': '4' },
        })
      }
      return new Response(new Uint8Array([1, 2, 3, 4]), { status: 200 })
    })

    const result = await fetchTranscript(
      { url: 'https://example.com/feed.xml', html: atom, resourceKey: null },
      { ...baseOptions, fetch: fetchImpl as unknown as typeof fetch }
    )

    expect(result.source).toBe('whisper')
    expect(result.text).toBe('ok')
  })

  it('canHandle recognizes common podcast hosts and RSS hints', async () => {
    const { canHandle } = await importPodcastProvider({ ffmpegAvailable: false })
    expect(
      canHandle({
        url: 'https://podcasts.apple.com/us/podcast/x/id1?i=2',
        html: null,
        resourceKey: null,
      })
    ).toBe(true)
    expect(canHandle({ url: 'https://example.com/feed.xml', html: null, resourceKey: null })).toBe(
      true
    )
    expect(canHandle({ url: 'https://example.com/page', html: '<html/>', resourceKey: null })).toBe(
      false
    )
  })
})
