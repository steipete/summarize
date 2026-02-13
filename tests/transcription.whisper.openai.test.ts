import { describe, expect, it, vi } from 'vitest'

describe('transcription/whisper openai', () => {
  it('calls OpenAI Whisper and preserves/ensures a filename extension', async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = init?.body as unknown
      expect(body).toBeInstanceOf(FormData)

      const form = body as FormData
      expect(form.get('model')).toBe('whisper-1')

      const file = form.get('file') as unknown as { name?: unknown }
      expect(file).toBeTruthy()
      expect(typeof file.name).toBe('string')
      expect(file.name).toBe('clip.mp4')

      return new Response(JSON.stringify({ text: 'hello' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    })

    try {
      vi.stubEnv('SUMMARIZE_DISABLE_LOCAL_WHISPER_CPP', '1')
      vi.stubGlobal('fetch', fetchMock)
      const { transcribeMediaWithWhisper } = await import(
        '../packages/core/src/transcription/whisper.js'
      )

      const result = await transcribeMediaWithWhisper({
        bytes: new Uint8Array([1, 2, 3]),
        mediaType: 'video/mp4',
        filename: 'clip',
        groqApiKey: null,
        openaiApiKey: 'OPENAI',
        falApiKey: null,
      })

      expect(result.text).toBe('hello')
      expect(result.provider).toBe('openai')
      expect(result.error).toBeNull()
    } finally {
      vi.unstubAllGlobals()
      vi.unstubAllEnvs()
    }
  })

  it.each([
    {
      label: 'prefers OPENAI_WHISPER_BASE_URL over OPENAI_BASE_URL',
      env: {
        OPENAI_WHISPER_BASE_URL: 'http://127.0.0.1:8080/v1/',
        OPENAI_BASE_URL: 'http://127.0.0.1:9090/v1',
      },
      expectedUrl: 'http://127.0.0.1:8080/v1/audio/transcriptions',
    },
    {
      label: 'uses OPENAI_BASE_URL when OPENAI_WHISPER_BASE_URL is missing',
      env: {
        OPENAI_BASE_URL: 'http://127.0.0.1:11434/v1',
      },
      expectedUrl: 'http://127.0.0.1:11434/v1/audio/transcriptions',
    },
    {
      label: 'falls back to OpenAI default for OpenRouter base URL',
      env: {
        OPENAI_BASE_URL: 'https://openrouter.ai/api/v1',
      },
      expectedUrl: 'https://api.openai.com/v1/audio/transcriptions',
    },
    {
      label: 'falls back to OpenAI default for empty base URL env values',
      env: {
        OPENAI_WHISPER_BASE_URL: '   ',
        OPENAI_BASE_URL: '',
      },
      expectedUrl: 'https://api.openai.com/v1/audio/transcriptions',
    },
  ])('$label', async ({ env, expectedUrl }) => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString()
      expect(url).toBe(expectedUrl)
      return new Response(JSON.stringify({ text: 'ok' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    })

    try {
      vi.stubEnv('SUMMARIZE_DISABLE_LOCAL_WHISPER_CPP', '1')
      vi.stubGlobal('fetch', fetchMock)
      const { transcribeMediaWithWhisper } = await import(
        '../packages/core/src/transcription/whisper.js'
      )

      const result = await transcribeMediaWithWhisper({
        bytes: new Uint8Array([1, 2, 3]),
        mediaType: 'audio/mpeg',
        filename: 'audio.mp3',
        groqApiKey: null,
        openaiApiKey: 'OPENAI',
        falApiKey: null,
        env,
      })

      expect(result.text).toBe('ok')
      expect(result.provider).toBe('openai')
    } finally {
      vi.unstubAllGlobals()
      vi.unstubAllEnvs()
    }
  })

  it('returns an OpenAI error when the payload has no usable text', async () => {
    const openaiFetch = vi.fn(async () => {
      return new Response(JSON.stringify({ foo: 'bar' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    })

    try {
      vi.stubEnv('SUMMARIZE_DISABLE_LOCAL_WHISPER_CPP', '1')
      vi.stubGlobal('fetch', openaiFetch)
      const { transcribeMediaWithWhisper } = await import(
        '../packages/core/src/transcription/whisper.js'
      )
      const result = await transcribeMediaWithWhisper({
        bytes: new Uint8Array([1, 2, 3]),
        mediaType: 'audio/mpeg',
        filename: 'audio.mp3',
        groqApiKey: null,
        openaiApiKey: 'OPENAI',
        falApiKey: null,
      })

      expect(result.text).toBeNull()
      expect(result.provider).toBe('openai')
      expect(result.error?.message).toContain('empty text')
    } finally {
      vi.unstubAllGlobals()
      vi.unstubAllEnvs()
    }
  })
})
