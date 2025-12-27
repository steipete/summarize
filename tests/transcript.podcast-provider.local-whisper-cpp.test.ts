import { describe, expect, it, vi } from 'vitest'

describe('podcast transcript provider: local whisper.cpp', () => {
  it('transcribes without API keys when whisper.cpp is available', async () => {
    vi.resetModules()

    vi.doMock('../packages/core/src/transcription/whisper.js', () => ({
      MAX_OPENAI_UPLOAD_BYTES: 24 * 1024 * 1024,
      isFfmpegAvailable: async () => false,
      isWhisperCppReady: async () => true,
      probeMediaDurationSecondsWithFfprobe: async () => null,
      resolveWhisperCppModelNameForDisplay: async () => 'base',
      transcribeMediaWithWhisper: async () => ({
        text: 'local transcript ok',
        provider: 'whisper.cpp',
        error: null,
        notes: ['whisper.cpp: used local'],
      }),
      transcribeMediaFileWithWhisper: async () => ({
        text: 'local transcript ok',
        provider: 'whisper.cpp',
        error: null,
        notes: ['whisper.cpp: used local'],
      }),
    }))

    try {
      const { fetchTranscript } = await import(
        '../packages/core/src/content/transcript/providers/podcast.js'
      )

      const enclosureUrl = 'https://example.com/episode.mp3'
      const xml = `<?xml version="1.0" encoding="UTF-8"?><rss version="2.0"><channel><item><itunes:duration>12:34</itunes:duration><enclosure url="${enclosureUrl}" type="audio/mpeg"/></item></channel></rss>`

      const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url =
          typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
        const method = (init?.method ?? 'GET').toUpperCase()
        if (url !== enclosureUrl) throw new Error(`Unexpected fetch: ${method} ${url}`)

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
      })

      const result = await fetchTranscript(
        { url: 'https://example.com/feed.xml', html: xml, resourceKey: null },
        {
          fetch: fetchImpl as unknown as typeof fetch,
          scrapeWithFirecrawl: null,
          apifyApiToken: null,
          youtubeTranscriptMode: 'auto',
          ytDlpPath: null,
          falApiKey: null,
          openaiApiKey: null,
        }
      )

      expect(result.text).toContain('local transcript ok')
      expect(result.source).toBe('whisper')
      expect(result.attemptedProviders).toEqual(['whisper'])
      expect(result.metadata?.durationSeconds).toBe(12 * 60 + 34)
    } finally {
      vi.doUnmock('../packages/core/src/transcription/whisper.js')
      vi.resetModules()
    }
  })
})
