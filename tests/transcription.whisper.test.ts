import type { ChildProcess } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { mkdtemp, rm, truncate, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'

const falMocks = vi.hoisted(() => ({
  createFalClient: vi.fn(),
}))

vi.mock('@fal-ai/client', () => ({
  createFalClient: falMocks.createFalClient,
}))

describe('transcription/whisper', () => {
  const resetModules = () => {
    vi.resetModules()
    vi.doMock('@fal-ai/client', () => ({
      createFalClient: falMocks.createFalClient,
    }))
  }

  const importWhisperWithNoFfmpeg = async () => {
    // Make tests stable across machines: don’t invoke real ffmpeg.
    resetModules()
    vi.doMock('node:child_process', () => ({
      spawn: () => {
        const handlers = new Map<string, (value?: unknown) => void>()
        const proc = {
          on(event: string, handler: (value?: unknown) => void) {
            handlers.set(event, handler)
            if (event === 'error') queueMicrotask(() => handler(new Error('spawn ENOENT')))
            return proc
          },
        } as unknown as ChildProcess
        return proc
      },
    }))
    return await import('../packages/core/src/transcription/whisper.js')
  }

  const importWhisperWithMockFfmpeg = async ({
    segmentPlan = 'two-parts',
  }: {
    segmentPlan?: 'two-parts' | 'no-parts'
  } = {}) => {
    resetModules()
    vi.doMock('node:child_process', () => ({
      spawn: (_cmd: string, args: string[]) => {
        if (_cmd !== 'ffmpeg') throw new Error(`Unexpected spawn: ${_cmd}`)

        const stderr = new EventEmitter() as EventEmitter & {
          setEncoding?: (encoding: string) => void
        }
        stderr.setEncoding = () => {}

        const handlers = new Map<string, (value?: unknown) => void>()
        const proc = {
          stderr,
          on(event: string, handler: (value?: unknown) => void) {
            handlers.set(event, handler)
            return proc
          },
        } as unknown as ChildProcess

        const close = (code: number) => queueMicrotask(() => handlers.get('close')?.(code))

        // ffmpeg -version
        if (args.includes('-version')) {
          close(0)
          return proc
        }

        // Segmenter: last arg is output pattern
        if (args.includes('-f') && args.includes('segment')) {
          const pattern = args[args.length - 1] ?? ''
          ;(async () => {
            if (segmentPlan === 'two-parts') {
              const part0 = pattern.replace('%03d', '000')
              const part1 = pattern.replace('%03d', '001')
              await writeFile(part0, new Uint8Array([1, 2, 3]))
              await writeFile(part1, new Uint8Array([4, 5, 6]))
            }
          })()
            .then(() => close(0))
            .catch((error) => {
              queueMicrotask(() => handlers.get('error')?.(error))
              close(1)
            })
          return proc
        }

        // Transcode: last arg is output file
        const output = args[args.length - 1] ?? ''
        ;(async () => {
          if (output) await writeFile(output, new Uint8Array([9, 9, 9]))
        })()
          .then(() => close(0))
          .catch((error) => {
            queueMicrotask(() => handlers.get('error')?.(error))
            close(1)
          })
        return proc
      },
    }))
    return await import('../packages/core/src/transcription/whisper.js')
  }

  it('maps media types to filename extensions for Whisper format detection', async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const form = init?.body as FormData
      const file = form.get('file') as unknown as { name?: unknown }
      if (typeof file?.name !== 'string') throw new Error('expected file.name')
      expect(file.name).toBe('audio.ogg')
      return new Response(JSON.stringify({ text: 'ok' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    })

    try {
      vi.stubGlobal('fetch', fetchMock)
      const { transcribeMediaWithWhisper } = await import(
        '../packages/core/src/transcription/whisper.js'
      )
      const result = await transcribeMediaWithWhisper({
        bytes: new Uint8Array([1, 2, 3]),
        mediaType: 'audio/ogg',
        filename: 'audio',
        groqApiKey: null,
        openaiApiKey: 'OPENAI',
        falApiKey: null,
      })

      expect(result.text).toBe('ok')
      expect(result.provider).toBe('openai')
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it.each([
    { mediaType: 'audio/x-wav', filename: 'audio', expected: 'audio.wav' },
    { mediaType: 'audio/wav', filename: 'audio', expected: 'audio.wav' },
    { mediaType: 'audio/flac', filename: 'audio', expected: 'audio.flac' },
    { mediaType: 'audio/webm', filename: 'audio', expected: 'audio.webm' },
    { mediaType: 'audio/mpeg', filename: 'audio', expected: 'audio.mp3' },
  ])('maps $mediaType to $expected for Whisper format detection', async (row) => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const form = init?.body as FormData
      const file = form.get('file') as unknown as { name?: unknown }
      if (typeof file?.name !== 'string') throw new Error('expected file.name')
      expect(file.name).toBe(row.expected)
      return new Response(JSON.stringify({ text: 'ok' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    })

    try {
      vi.stubGlobal('fetch', fetchMock)
      const { transcribeMediaWithWhisper } = await import(
        '../packages/core/src/transcription/whisper.js'
      )
      const result = await transcribeMediaWithWhisper({
        bytes: new Uint8Array([1, 2, 3]),
        mediaType: row.mediaType,
        filename: row.filename,
        groqApiKey: null,
        openaiApiKey: 'OPENAI',
        falApiKey: null,
      })

      expect(result.text).toBe('ok')
      expect(result.provider).toBe('openai')
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('returns an error when no transcription keys are provided', async () => {
    const { transcribeMediaWithWhisper } = await import(
      '../packages/core/src/transcription/whisper.js'
    )
    const result = await transcribeMediaWithWhisper({
      bytes: new Uint8Array([1, 2, 3]),
      mediaType: 'audio/mpeg',
      filename: 'audio.mp3',
      groqApiKey: null,
      openaiApiKey: null,
      falApiKey: null,
    })

    expect(result.text).toBeNull()
    expect(result.provider).toBeNull()
    expect(result.error?.message).toContain('GROQ_API_KEY, OPENAI_API_KEY, or FAL_KEY')
  })

  it('transcribes small files via transcribeMediaFileWithWhisper (no chunking)', async () => {
    const root = await mkdtemp(join(tmpdir(), 'summarize-whisper-file-small-'))
    const audioPath = join(root, 'audio.mp3')
    await writeFile(audioPath, new Uint8Array([1, 2, 3]))

    resetModules()
    vi.stubEnv('SUMMARIZE_DISABLE_LOCAL_WHISPER_CPP', '1')

    const openaiFetch = vi.fn(async () => {
      return new Response(JSON.stringify({ text: 'from file' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    })

    try {
      vi.stubGlobal('fetch', openaiFetch)
      const { transcribeMediaFileWithWhisper } = await import(
        '../packages/core/src/transcription/whisper.js'
      )
      const progress = vi.fn()
      const result = await transcribeMediaFileWithWhisper({
        filePath: audioPath,
        mediaType: 'audio/mpeg',
        filename: 'audio.mp3',
        groqApiKey: null,
        openaiApiKey: 'OPENAI',
        falApiKey: null,
        totalDurationSeconds: 10,
        onProgress: progress,
      })

      expect(result.text).toBe('from file')
      expect(result.provider).toBe('openai')
      expect(progress).toHaveBeenCalled()
    } finally {
      vi.unstubAllGlobals()
      await rm(root, { recursive: true, force: true }).catch(() => {})
    }
  })

  it('uses FAL chunk transcripts when the result has `chunks`', async () => {
    resetModules()
    vi.stubEnv('SUMMARIZE_DISABLE_LOCAL_WHISPER_CPP', '1')

    falMocks.createFalClient.mockReset().mockReturnValue({
      storage: {
        upload: vi.fn(async () => 'https://fal.example/audio'),
      },
      subscribe: vi.fn(async () => ({
        data: {
          chunks: [{ text: 'hello' }, { text: 'world' }],
        },
      })),
    })

    const { transcribeMediaWithWhisper } = await import(
      '../packages/core/src/transcription/whisper.js'
    )
    const result = await transcribeMediaWithWhisper({
      bytes: new Uint8Array([1, 2, 3]),
      mediaType: 'audio/mpeg',
      filename: 'audio.mp3',
      groqApiKey: null,
      openaiApiKey: null,
      falApiKey: 'FAL',
    })

    expect(result.text).toBe('hello world')
    expect(result.provider).toBe('fal')
  })

  it('falls back to FAL for audio when OpenAI fails (and truncates long error details)', async () => {
    const longError = 'x'.repeat(300)
    const openaiFetch = vi.fn(async () => {
      return new Response(longError, { status: 400, headers: { 'content-type': 'text/plain' } })
    })

    falMocks.createFalClient.mockReset().mockReturnValue({
      storage: {
        upload: vi.fn(async () => 'https://fal.example/audio'),
      },
      subscribe: vi.fn(async () => ({
        data: { chunks: [{ text: 'hello' }, { text: 'world' }] },
      })),
    })

    try {
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
        falApiKey: 'FAL',
      })

      expect(result.text).toBe('hello world')
      expect(result.provider).toBe('fal')
      expect(result.notes.join(' ')).toContain('falling back to FAL')
      expect(result.notes.join(' ')).toContain('OpenAI transcription failed')
      expect(result.notes.join(' ')).toContain('…')
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('suggests ffmpeg transcoding when OpenAI cannot decode media', async () => {
    const openaiFetch = vi.fn(async () => {
      return new Response('unrecognized file format', {
        status: 400,
        headers: { 'content-type': 'text/plain' },
      })
    })

    falMocks.createFalClient.mockReset().mockReturnValue({
      storage: {
        upload: vi.fn(async () => 'https://fal.example/audio'),
      },
      subscribe: vi.fn(async () => ({ data: { text: 'fallback ok' } })),
    })

    try {
      vi.stubGlobal('fetch', openaiFetch)
      const whisper = await importWhisperWithNoFfmpeg()

      const result = await whisper.transcribeMediaWithWhisper({
        bytes: new Uint8Array([1, 2, 3]),
        mediaType: 'audio/mpeg',
        filename: 'audio.mp3',
        groqApiKey: null,
        openaiApiKey: 'OPENAI',
        falApiKey: 'FAL',
      })

      expect(result.text).toBe('fallback ok')
      expect(result.provider).toBe('fal')
      expect(result.notes.join(' ')).toContain('install ffmpeg')
    } finally {
      vi.unstubAllGlobals()
      vi.doUnmock('node:child_process')
      vi.restoreAllMocks()
    }
  })

  it('wraps non-Error OpenAI failures', async () => {
    const openaiFetch = vi.fn(async () => {
      throw 'boom'
    })

    try {
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
      expect(result.error?.message).toContain('OpenAI transcription failed: boom')
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('chunks oversized files via ffmpeg and concatenates transcripts', async () => {
    const whisper = await importWhisperWithMockFfmpeg({ segmentPlan: 'two-parts' })
    const dir = await mkdtemp(join(tmpdir(), 'summarize-whisper-test-'))
    const path = join(dir, 'input.bin')

    // Sparse file: huge stat size, tiny actual data.
    await writeFile(path, new Uint8Array([1, 2, 3]))
    await truncate(path, whisper.MAX_OPENAI_UPLOAD_BYTES + 1)

    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const form = init?.body as FormData
      const file = form.get('file') as unknown as { name?: unknown }
      if (typeof file?.name !== 'string') throw new Error('expected file.name')
      return new Response(JSON.stringify({ text: `T:${file.name}` }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    })

    try {
      vi.stubGlobal('fetch', fetchMock)
      const onProgress = vi.fn()
      const result = await whisper.transcribeMediaFileWithWhisper({
        filePath: path,
        mediaType: 'audio/mpeg',
        filename: 'input.mp3',
        groqApiKey: null,
        openaiApiKey: 'OPENAI',
        falApiKey: null,
        segmentSeconds: 1,
        onProgress,
      })

      expect(result.text).toContain('T:part-000.mp3')
      expect(result.text).toContain('T:part-001.mp3')
      expect(result.text).toContain('\n\n')
      expect(result.notes.join(' ')).toContain('ffmpeg chunked media into 2 parts')
      expect(onProgress).toHaveBeenCalledWith({
        partIndex: null,
        parts: 2,
        processedDurationSeconds: null,
        totalDurationSeconds: null,
      })
      expect(onProgress).toHaveBeenCalledWith({
        partIndex: 1,
        parts: 2,
        processedDurationSeconds: null,
        totalDurationSeconds: null,
      })
      expect(onProgress).toHaveBeenCalledWith({
        partIndex: 2,
        parts: 2,
        processedDurationSeconds: null,
        totalDurationSeconds: null,
      })
    } finally {
      vi.unstubAllGlobals()
      vi.doUnmock('node:child_process')
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('reports an error when ffmpeg produces no segments', async () => {
    const whisper = await importWhisperWithMockFfmpeg({ segmentPlan: 'no-parts' })
    const dir = await mkdtemp(join(tmpdir(), 'summarize-whisper-test-'))
    const path = join(dir, 'input.bin')
    await writeFile(path, new Uint8Array([1, 2, 3]))
    await truncate(path, whisper.MAX_OPENAI_UPLOAD_BYTES + 1)

    try {
      const result = await whisper.transcribeMediaFileWithWhisper({
        filePath: path,
        mediaType: 'audio/mpeg',
        filename: 'input.mp3',
        groqApiKey: null,
        openaiApiKey: 'OPENAI',
        falApiKey: null,
        segmentSeconds: 1,
      })

      expect(result.text).toBeNull()
      expect(result.error?.message).toContain('ffmpeg produced no audio segments')
    } finally {
      vi.doUnmock('node:child_process')
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('transcribeMediaFileWithWhisper returns an error when no transcription keys are provided', async () => {
    const { transcribeMediaFileWithWhisper } = await import(
      '../packages/core/src/transcription/whisper.js'
    )
    const dir = await mkdtemp(join(tmpdir(), 'summarize-whisper-test-'))
    const path = join(dir, 'input.bin')
    await writeFile(path, new Uint8Array([1, 2, 3]))
    try {
      const result = await transcribeMediaFileWithWhisper({
        filePath: path,
        mediaType: 'audio/mpeg',
        filename: 'input.mp3',
        groqApiKey: null,
        openaiApiKey: null,
        falApiKey: null,
      })
      expect(result.text).toBeNull()
      expect(result.error?.message).toContain('GROQ_API_KEY, OPENAI_API_KEY, or FAL_KEY')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('falls back to partial reads when ffmpeg is missing for oversized files', async () => {
    const whisper = await importWhisperWithNoFfmpeg()
    const dir = await mkdtemp(join(tmpdir(), 'summarize-whisper-test-'))
    const path = join(dir, 'input.bin')
    await writeFile(path, new Uint8Array([1, 2, 3]))
    await truncate(path, whisper.MAX_OPENAI_UPLOAD_BYTES + 1)

    const fetchMock = vi.fn(async () => {
      return new Response(JSON.stringify({ text: 'ok' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    })

    try {
      vi.stubGlobal('fetch', fetchMock)
      const result = await whisper.transcribeMediaFileWithWhisper({
        filePath: path,
        mediaType: 'audio/mpeg',
        filename: 'input.mp3',
        groqApiKey: null,
        openaiApiKey: 'OPENAI',
        falApiKey: null,
      })

      expect(result.text).toBe('ok')
      expect(result.notes.join(' ')).toContain('install ffmpeg to enable chunked transcription')
    } finally {
      vi.unstubAllGlobals()
      vi.doUnmock('node:child_process')
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('retries OpenAI decode failures by transcoding via ffmpeg', async () => {
    let call = 0
    const fetchMock = vi.fn(async () => {
      call += 1
      if (call === 1) {
        return new Response('could not be decoded', {
          status: 400,
          headers: { 'content-type': 'text/plain' },
        })
      }
      return new Response(JSON.stringify({ text: 'after transcode' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    })

    try {
      vi.stubGlobal('fetch', fetchMock)
      const whisper = await importWhisperWithMockFfmpeg()
      const result = await whisper.transcribeMediaWithWhisper({
        bytes: new Uint8Array([1, 2, 3]),
        mediaType: 'video/mp4',
        filename: 'bad.mp4',
        groqApiKey: null,
        openaiApiKey: 'OPENAI',
        falApiKey: null,
      })

      expect(result.text).toBe('after transcode')
      expect(result.notes.join(' ')).toContain('transcoding via ffmpeg and retrying')
    } finally {
      vi.unstubAllGlobals()
      vi.doUnmock('node:child_process')
    }
  })

  it('skips FAL for non-audio media types', async () => {
    const { transcribeMediaWithWhisper } = await import(
      '../packages/core/src/transcription/whisper.js'
    )
    const result = await transcribeMediaWithWhisper({
      bytes: new Uint8Array([1, 2, 3]),
      mediaType: 'video/mp4',
      filename: 'video.mp4',
      groqApiKey: null,
      openaiApiKey: null,
      falApiKey: 'FAL',
    })

    expect(result.text).toBeNull()
    expect(result.provider).toBeNull()
    expect(result.error?.message).toContain('No transcription providers available')
    expect(result.notes.join(' ')).toContain('Skipping FAL transcription')
  })

  it('surfaces ffmpeg segment failures with stderr detail', async () => {
    const root = await mkdtemp(join(tmpdir(), 'summarize-whisper-ffmpeg-seg-fail-'))
    const audioPath = join(root, 'audio.bin')
    await writeFile(audioPath, new Uint8Array([1, 2, 3]))
    // Force the "oversized upload" branch so we hit the ffmpeg segmenter.
    await truncate(audioPath, 30 * 1024 * 1024)

    resetModules()
    vi.stubEnv('SUMMARIZE_DISABLE_LOCAL_WHISPER_CPP', '1')

    vi.doMock('node:child_process', () => ({
      spawn: (_cmd: string, args: string[]) => {
        if (_cmd !== 'ffmpeg') throw new Error(`Unexpected spawn: ${_cmd}`)

        const stderr = new EventEmitter() as EventEmitter & {
          setEncoding?: (encoding: string) => void
        }
        stderr.setEncoding = () => {}

        const handlers = new Map<string, (value?: unknown) => void>()
        const proc = {
          stderr,
          on(event: string, handler: (value?: unknown) => void) {
            handlers.set(event, handler)
            return proc
          },
        } as unknown as ChildProcess

        const close = (code: number) => queueMicrotask(() => handlers.get('close')?.(code))

        if (args.includes('-version')) {
          close(0)
          return proc
        }

        // Fail the segmenter run.
        stderr.emit('data', 'segment failed\n')
        close(1)
        return proc
      },
    }))

    try {
      const { transcribeMediaFileWithWhisper } = await import(
        '../packages/core/src/transcription/whisper.js'
      )
      await expect(
        transcribeMediaFileWithWhisper({
          filePath: audioPath,
          mediaType: 'audio/mpeg',
          filename: 'audio.mp3',
          groqApiKey: null,
          openaiApiKey: 'OPENAI',
          falApiKey: null,
          segmentSeconds: 1,
          totalDurationSeconds: 2,
        })
      ).rejects.toThrow(/ffmpeg failed/i)
    } finally {
      await rm(root, { recursive: true, force: true }).catch(() => {})
    }
  })

  it('notes ffmpeg transcode failures when retrying OpenAI decode errors', async () => {
    resetModules()
    vi.stubEnv('SUMMARIZE_DISABLE_LOCAL_WHISPER_CPP', '1')

    const originalFetch = globalThis.fetch
    try {
      globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
        const url = typeof input === 'string' ? input : input.toString()
        if (!url.includes('/v1/audio/transcriptions')) throw new Error(`Unexpected fetch: ${url}`)
        return new Response('Unrecognized file format', {
          status: 400,
          headers: { 'content-type': 'text/plain' },
        })
      }) as unknown as typeof fetch

      vi.doMock('node:child_process', () => ({
        spawn: (_cmd: string, args: string[]) => {
          if (_cmd !== 'ffmpeg') throw new Error(`Unexpected spawn: ${_cmd}`)
          const stderr = new EventEmitter() as EventEmitter & {
            setEncoding?: (encoding: string) => void
          }
          stderr.setEncoding = () => {}

          const handlers = new Map<string, (value?: unknown) => void>()
          const proc = {
            stderr,
            on(event: string, handler: (value?: unknown) => void) {
              handlers.set(event, handler)
              return proc
            },
          } as unknown as ChildProcess

          const close = (code: number) => queueMicrotask(() => handlers.get('close')?.(code))

          if (args.includes('-version')) {
            close(0)
            return proc
          }

          // Fail the transcode.
          stderr.emit('data', 'transcode failed\n')
          close(1)
          return proc
        },
      }))

      const { transcribeMediaWithWhisper } = await import(
        '../packages/core/src/transcription/whisper.js'
      )
      const result = await transcribeMediaWithWhisper({
        bytes: new Uint8Array([1, 2, 3]),
        mediaType: 'video/mp4',
        filename: 'clip.mp4',
        groqApiKey: null,
        openaiApiKey: 'OPENAI',
        falApiKey: null,
      })

      expect(result.text).toBeNull()
      expect(result.provider).toBe('openai')
      expect(result.notes.join(' ')).toContain('ffmpeg')
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it('notes when OpenAI upload is too large and ffmpeg is missing (truncates bytes)', async () => {
    const whisper = await importWhisperWithNoFfmpeg()
    const openaiFetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const form = init?.body as FormData
      const file = form.get('file') as unknown as { size?: unknown }
      if (typeof file?.size !== 'number') throw new Error('expected file.size')
      expect(file.size).toBe(whisper.MAX_OPENAI_UPLOAD_BYTES)
      return new Response(JSON.stringify({ text: 'ok' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    })
    const big = new Uint8Array(whisper.MAX_OPENAI_UPLOAD_BYTES + 1)

    try {
      vi.stubGlobal('fetch', openaiFetch)
      const result = await whisper.transcribeMediaWithWhisper({
        bytes: big,
        mediaType: 'audio/mpeg',
        filename: 'audio.mp3',
        groqApiKey: null,
        openaiApiKey: 'OPENAI',
        falApiKey: null,
      })

      expect(result.text).toBe('ok')
      expect(result.provider).toBe('openai')
      expect(result.notes.join(' ')).toContain('Media too large for Whisper upload')
    } finally {
      vi.unstubAllGlobals()
      vi.doUnmock('node:child_process')
      vi.restoreAllMocks()
    }
  })

  it('returns a helpful error when FAL returns empty content', async () => {
    falMocks.createFalClient.mockReset().mockReturnValue({
      storage: {
        upload: vi.fn(async () => 'https://fal.example/audio'),
      },
      subscribe: vi.fn(async () => ({
        data: { text: '' },
      })),
    })

    const { transcribeMediaWithWhisper } = await import(
      '../packages/core/src/transcription/whisper.js'
    )
    const result = await transcribeMediaWithWhisper({
      bytes: new Uint8Array([1, 2, 3]),
      mediaType: 'audio/mpeg',
      filename: 'audio.mp3',
      groqApiKey: null,
      openaiApiKey: null,
      falApiKey: 'FAL',
    })

    expect(result.text).toBeNull()
    expect(result.provider).toBe('fal')
    expect(result.error?.message).toContain('FAL transcription returned empty text')
  })

  it('extracts FAL text from data.text', async () => {
    falMocks.createFalClient.mockReset().mockReturnValue({
      storage: { upload: vi.fn(async () => 'https://fal.example/audio') },
      subscribe: vi.fn(async () => ({ data: { text: '  hello fal  ' } })),
    })

    const { transcribeMediaWithWhisper } = await import(
      '../packages/core/src/transcription/whisper.js'
    )
    const result = await transcribeMediaWithWhisper({
      bytes: new Uint8Array([1, 2, 3]),
      mediaType: 'audio/mpeg',
      filename: 'audio.mp3',
      groqApiKey: null,
      openaiApiKey: null,
      falApiKey: 'FAL',
    })

    expect(result.text).toBe('hello fal')
    expect(result.provider).toBe('fal')
    expect(result.error).toBeNull()
  })

  it('times out FAL subscriptions', async () => {
    vi.useFakeTimers()
    falMocks.createFalClient.mockReset().mockReturnValue({
      storage: { upload: vi.fn(async () => 'https://fal.example/audio') },
      subscribe: vi.fn(async () => new Promise(() => {})),
    })

    const { transcribeMediaWithWhisper } = await import(
      '../packages/core/src/transcription/whisper.js'
    )
    const promise = transcribeMediaWithWhisper({
      bytes: new Uint8Array([1, 2, 3]),
      mediaType: 'audio/mpeg',
      filename: 'audio.mp3',
      groqApiKey: null,
      openaiApiKey: null,
      falApiKey: 'FAL',
    })

    await vi.advanceTimersByTimeAsync(600_000)
    const result = await promise

    expect(result.text).toBeNull()
    expect(result.provider).toBe('fal')
    expect(result.error?.message.toLowerCase()).toContain('timeout')
    vi.useRealTimers()
  })

  it('prefers Groq over OpenAI when groqApiKey is provided', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString()
      expect(url).toContain('groq.com')
      const form = init?.body as FormData
      expect(form.get('model')).toBe('whisper-large-v3-turbo')
      return new Response(JSON.stringify({ text: 'groq result' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    })

    try {
      vi.stubGlobal('fetch', fetchMock)
      const { transcribeMediaWithWhisper } = await import(
        '../packages/core/src/transcription/whisper.js'
      )
      const result = await transcribeMediaWithWhisper({
        bytes: new Uint8Array([1, 2, 3]),
        mediaType: 'audio/mpeg',
        filename: 'audio.mp3',
        groqApiKey: 'GROQ',
        openaiApiKey: 'OPENAI',
        falApiKey: null,
      })

      expect(result.text).toBe('groq result')
      expect(result.provider).toBe('groq')
      expect(fetchMock).toHaveBeenCalledTimes(1)
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('falls back to OpenAI when Groq fails', async () => {
    let callCount = 0
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      callCount++
      const url = typeof input === 'string' ? input : input.toString()
      if (url.includes('groq.com')) {
        return new Response('rate limit exceeded', {
          status: 429,
          headers: { 'content-type': 'text/plain' },
        })
      }
      return new Response(JSON.stringify({ text: 'openai fallback' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    })

    try {
      vi.stubGlobal('fetch', fetchMock)
      const { transcribeMediaWithWhisper } = await import(
        '../packages/core/src/transcription/whisper.js'
      )
      const result = await transcribeMediaWithWhisper({
        bytes: new Uint8Array([1, 2, 3]),
        mediaType: 'audio/mpeg',
        filename: 'audio.mp3',
        groqApiKey: 'GROQ',
        openaiApiKey: 'OPENAI',
        falApiKey: null,
      })

      expect(result.text).toBe('openai fallback')
      expect(result.provider).toBe('openai')
      expect(callCount).toBeGreaterThanOrEqual(2)
      expect(result.notes.join(' ')).toContain('Groq')
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('returns null from Groq when payload has no text field', async () => {
    const fetchMock = vi.fn(async () => {
      return new Response(JSON.stringify({ foo: 'bar' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    })

    try {
      vi.stubGlobal('fetch', fetchMock)
      const { transcribeMediaWithWhisper } = await import(
        '../packages/core/src/transcription/whisper.js'
      )
      const result = await transcribeMediaWithWhisper({
        bytes: new Uint8Array([1, 2, 3]),
        mediaType: 'audio/mpeg',
        filename: 'audio.mp3',
        groqApiKey: 'GROQ',
        openaiApiKey: null,
        falApiKey: null,
      })

      expect(result.text).toBeNull()
      expect(result.provider).toBe('groq')
      expect(result.error?.message).toContain('Groq transcription returned empty text')
      expect(result.notes.join(' ')).toContain('Groq transcription returned empty text')
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('surfaces Groq as terminal provider when Groq-only transcription fails', async () => {
    const fetchMock = vi.fn(async () => {
      return new Response('rate limit exceeded', {
        status: 429,
        headers: { 'content-type': 'text/plain' },
      })
    })

    try {
      vi.stubGlobal('fetch', fetchMock)
      const { transcribeMediaWithWhisper } = await import(
        '../packages/core/src/transcription/whisper.js'
      )
      const result = await transcribeMediaWithWhisper({
        bytes: new Uint8Array([1, 2, 3]),
        mediaType: 'audio/mpeg',
        filename: 'audio.mp3',
        groqApiKey: 'GROQ',
        openaiApiKey: null,
        falApiKey: null,
      })

      expect(result.text).toBeNull()
      expect(result.provider).toBe('groq')
      expect(result.error?.message).toContain('Groq transcription failed')
      expect(result.error?.message).toContain('429')
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('retries Groq via ffmpeg on format errors', async () => {
    let call = 0
    const fetchMock = vi.fn(async () => {
      call += 1
      if (call === 1) {
        return new Response('could not be decoded', {
          status: 400,
          headers: { 'content-type': 'text/plain' },
        })
      }
      return new Response(JSON.stringify({ text: 'after transcode' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    })

    try {
      vi.stubGlobal('fetch', fetchMock)
      const whisper = await importWhisperWithMockFfmpeg()
      const result = await whisper.transcribeMediaWithWhisper({
        bytes: new Uint8Array([1, 2, 3]),
        mediaType: 'video/mp4',
        filename: 'bad.mp4',
        groqApiKey: 'GROQ',
        openaiApiKey: null,
        falApiKey: null,
      })

      expect(result.text).toBe('after transcode')
      expect(result.provider).toBe('groq')
      expect(result.notes.join(' ')).toContain('transcoding via ffmpeg and retrying')
    } finally {
      vi.unstubAllGlobals()
      vi.doUnmock('node:child_process')
    }
  })

  it('Groq returns null for empty trimmed text', async () => {
    const fetchMock = vi.fn(async () => {
      return new Response(JSON.stringify({ text: '   ' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    })

    try {
      vi.stubGlobal('fetch', fetchMock)
      const { transcribeMediaWithWhisper } = await import(
        '../packages/core/src/transcription/whisper.js'
      )
      const result = await transcribeMediaWithWhisper({
        bytes: new Uint8Array([1, 2, 3]),
        mediaType: 'audio/mpeg',
        filename: 'audio.mp3',
        groqApiKey: 'GROQ',
        openaiApiKey: null,
        falApiKey: null,
      })

      expect(result.text).toBeNull()
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('Groq error includes truncated detail for long error bodies', async () => {
    const longBody = 'x'.repeat(300)
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString()
      if (url.includes('groq.com')) {
        return new Response(longBody, {
          status: 500,
          headers: { 'content-type': 'text/plain' },
        })
      }
      return new Response(JSON.stringify({ text: 'openai ok' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    })

    try {
      vi.stubGlobal('fetch', fetchMock)
      const { transcribeMediaWithWhisper } = await import(
        '../packages/core/src/transcription/whisper.js'
      )
      const result = await transcribeMediaWithWhisper({
        bytes: new Uint8Array([1, 2, 3]),
        mediaType: 'audio/mpeg',
        filename: 'audio.mp3',
        groqApiKey: 'GROQ',
        openaiApiKey: 'OPENAI',
        falApiKey: null,
      })

      expect(result.text).toBe('openai ok')
      expect(result.provider).toBe('openai')
      expect(result.notes.join(' ')).toContain('…')
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('Groq error with empty response body', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString()
      if (url.includes('groq.com')) {
        return new Response('', {
          status: 500,
          headers: { 'content-type': 'text/plain' },
        })
      }
      return new Response(JSON.stringify({ text: 'openai ok' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    })

    try {
      vi.stubGlobal('fetch', fetchMock)
      const { transcribeMediaWithWhisper } = await import(
        '../packages/core/src/transcription/whisper.js'
      )
      const result = await transcribeMediaWithWhisper({
        bytes: new Uint8Array([1, 2, 3]),
        mediaType: 'audio/mpeg',
        filename: 'audio.mp3',
        groqApiKey: 'GROQ',
        openaiApiKey: 'OPENAI',
        falApiKey: null,
      })

      expect(result.text).toBe('openai ok')
      expect(result.provider).toBe('openai')
      expect(result.notes.join(' ')).toContain('Groq transcription failed')
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('shouldRetryGroqViaFfmpeg detects retryable errors', async () => {
    const { shouldRetryGroqViaFfmpeg } = await import(
      '../packages/core/src/transcription/whisper/groq.js'
    )
    expect(shouldRetryGroqViaFfmpeg(new Error('Unrecognized file format'))).toBe(true)
    expect(shouldRetryGroqViaFfmpeg(new Error('could not be decoded'))).toBe(true)
    expect(shouldRetryGroqViaFfmpeg(new Error('format is not supported'))).toBe(true)
    expect(shouldRetryGroqViaFfmpeg(new Error('rate limit exceeded'))).toBe(false)
  })

  it('uses Groq with default filename when none provided', async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const form = init?.body as FormData
      const file = form.get('file') as unknown as { name?: unknown }
      expect(typeof file?.name).toBe('string')
      expect((file?.name as string).startsWith('media')).toBe(true)
      return new Response(JSON.stringify({ text: 'ok' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    })

    try {
      vi.stubGlobal('fetch', fetchMock)
      const { transcribeMediaWithWhisper } = await import(
        '../packages/core/src/transcription/whisper.js'
      )
      const result = await transcribeMediaWithWhisper({
        bytes: new Uint8Array([1, 2, 3]),
        mediaType: 'audio/mpeg',
        filename: null,
        groqApiKey: 'GROQ',
        openaiApiKey: null,
        falApiKey: null,
      })

      expect(result.text).toBe('ok')
      expect(result.provider).toBe('groq')
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('does not retry Groq in file flow after initial Groq failure', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'summarize-whisper-groq-file-'))
    const inputPath = join(dir, 'input.mp3')
    await writeFile(inputPath, new Uint8Array([1, 2, 3]))

    let groqCalls = 0
    let openaiCalls = 0
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString()
      if (url.includes('groq.com')) {
        groqCalls += 1
        return new Response('rate limit exceeded', {
          status: 429,
          headers: { 'content-type': 'text/plain' },
        })
      }
      if (url.includes('openai.com')) {
        openaiCalls += 1
        return new Response(JSON.stringify({ text: 'openai fallback' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }
      throw new Error(`Unexpected fetch URL: ${url}`)
    })

    try {
      vi.stubGlobal('fetch', fetchMock)
      const whisper = await importWhisperWithNoFfmpeg()
      const result = await whisper.transcribeMediaFileWithWhisper({
        filePath: inputPath,
        mediaType: 'audio/mpeg',
        filename: 'input.mp3',
        groqApiKey: 'GROQ',
        openaiApiKey: 'OPENAI',
        falApiKey: null,
      })

      expect(result.text).toBe('openai fallback')
      expect(result.provider).toBe('openai')
      expect(groqCalls).toBe(1)
      expect(openaiCalls).toBe(1)
    } finally {
      vi.unstubAllGlobals()
      vi.doUnmock('node:child_process')
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('returns a Groq-specific error for oversized files with only Groq configured', async () => {
    const whisper = await importWhisperWithNoFfmpeg()
    const dir = await mkdtemp(join(tmpdir(), 'summarize-whisper-groq-large-'))
    const path = join(dir, 'input.bin')
    await writeFile(path, new Uint8Array([1, 2, 3]))
    await truncate(path, whisper.MAX_OPENAI_UPLOAD_BYTES + 1)

    const fetchMock = vi.fn(async () => {
      throw new Error('Groq should not be called for oversized file in file flow')
    })

    try {
      vi.stubGlobal('fetch', fetchMock)
      const result = await whisper.transcribeMediaFileWithWhisper({
        filePath: path,
        mediaType: 'audio/mpeg',
        filename: 'input.mp3',
        groqApiKey: 'GROQ',
        openaiApiKey: null,
        falApiKey: null,
      })

      expect(result.text).toBeNull()
      expect(result.provider).toBe('groq')
      expect(result.error?.message).toContain('File too large for Groq upload')
      expect(fetchMock).not.toHaveBeenCalled()
    } finally {
      vi.unstubAllGlobals()
      vi.doUnmock('node:child_process')
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('maps additional media types to stable Whisper filename extensions', async () => {
    const cases = [
      { mediaType: 'audio/x-wav', expected: 'clip.wav' },
      { mediaType: 'audio/flac', expected: 'clip.flac' },
      { mediaType: 'audio/webm', expected: 'clip.webm' },
      { mediaType: 'video/webm', expected: 'clip.webm' },
      { mediaType: 'audio/mpga', expected: 'clip.mp3' },
      { mediaType: 'audio/mp4', expected: 'clip.mp4' },
      { mediaType: 'application/mp4', expected: 'clip.mp4' },
      { mediaType: 'application/ogg', expected: 'clip.ogg' },
      { mediaType: 'audio/oga', expected: 'clip.ogg' },
    ] as const

    for (const c of cases) {
      const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        const form = init?.body as FormData
        const file = form.get('file') as unknown as { name?: unknown }
        if (typeof file?.name !== 'string') throw new Error('expected file.name')
        expect(file.name).toBe(c.expected)
        return new Response(JSON.stringify({ text: 'ok' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      })

      try {
        vi.stubGlobal('fetch', fetchMock)
        const { transcribeMediaWithWhisper } = await import(
          '../packages/core/src/transcription/whisper.js'
        )
        const result = await transcribeMediaWithWhisper({
          bytes: new Uint8Array([1, 2, 3]),
          mediaType: c.mediaType,
          filename: 'clip',
          groqApiKey: null,
          openaiApiKey: 'OPENAI',
          falApiKey: null,
        })
        expect(result.text).toBe('ok')
      } finally {
        vi.unstubAllGlobals()
      }
    }
  })
})
