import { describe, expect, it, vi } from 'vitest'

async function importPodcastProvider() {
  vi.resetModules()

  const longTranscript = 'hello from spotify '.repeat(20).trim()

  vi.doMock('../packages/core/src/transcription/whisper.js', () => ({
    MAX_OPENAI_UPLOAD_BYTES: 1024 * 1024,
    isFfmpegAvailable: () => Promise.resolve(true),
    isWhisperCppReady: () => Promise.resolve(false),
    probeMediaDurationSecondsWithFfprobe: async () => null,
    resolveWhisperCppModelNameForDisplay: async () => null,
    transcribeMediaWithWhisper: vi.fn(async () => ({
      text: longTranscript,
      provider: 'openai',
      error: null,
      notes: [],
    })),
    transcribeMediaFileWithWhisper: vi.fn(async () => ({
      text: `${longTranscript} (file)`,
      provider: 'openai',
      error: null,
      notes: [],
    })),
  }))

  return await import('../packages/core/src/content/transcript/providers/podcast.js')
}

const baseOptions = {
  scrapeWithFirecrawl: null as unknown as ((...args: unknown[]) => unknown) | null,
  apifyApiToken: null,
  youtubeTranscriptMode: 'auto' as const,
  ytDlpPath: null as string | null,
  groqApiKey: null as string | null,
  falApiKey: null as string | null,
  openaiApiKey: 'OPENAI' as string | null,
}

describe('podcast provider - Spotify embed audio', () => {
  it('transcribes Spotify embed audio when available (no recaptcha)', async () => {
    const { fetchTranscript } = await importPodcastProvider()
    const episodeId = '5auotqWAXhhKyb9ymCuBJY'
    const pageUrl = `https://open.spotify.com/episode/${episodeId}`
    const embedUrl = `https://open.spotify.com/embed/episode/${episodeId}`
    const audioUrl = 'https://audio4-fa.scdn.co/audio/abc?token=x'

    const embedHtml = `<!doctype html><script id="__NEXT_DATA__" type="application/json">${JSON.stringify(
      {
        props: {
          pageProps: {
            state: {
              data: {
                entity: { subtitle: 'My Show', title: 'My Episode', duration: 90_000 },
                defaultAudioFileObject: { url: [audioUrl], format: 'MP4_128_CBCS' },
              },
            },
          },
        },
      }
    )}</script>`

    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url =
        typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      const method = (init?.method ?? 'GET').toUpperCase()

      if (url === embedUrl && method === 'GET') {
        return new Response(embedHtml, { status: 200, headers: { 'content-type': 'text/html' } })
      }

      if (url === audioUrl && method === 'HEAD') {
        return new Response(null, {
          status: 200,
          headers: { 'content-type': 'video/mp4', 'content-length': String(1000) },
        })
      }

      if (url === audioUrl && method === 'GET') {
        return new Response(new Uint8Array([1, 2, 3]), {
          status: 200,
          headers: { 'content-type': 'video/mp4' },
        })
      }

      throw new Error(`Unexpected fetch: ${method} ${url}`)
    })

    const result = await fetchTranscript(
      { url: pageUrl, html: null, resourceKey: null },
      { ...baseOptions, fetch: fetchImpl as unknown as typeof fetch }
    )

    expect(result.source).toBe('whisper')
    expect(result.text).toContain('hello from spotify')
    expect(result.metadata?.kind).toBe('spotify_embed_audio')
    const meta = result.metadata as unknown as { audioUrl?: string; durationSeconds?: number }
    expect(meta.audioUrl).toBe(audioUrl)
    expect(meta.durationSeconds).toBe(90)
  })
})
