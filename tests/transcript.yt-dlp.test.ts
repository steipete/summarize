import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const spawnMock = vi.hoisted(() => vi.fn())
const fsMock = vi.hoisted(() => ({
  stat: vi.fn(),
  readFile: vi.fn(),
  unlink: vi.fn(),
}))
const falMock = vi.hoisted(() => ({
  createFalClient: vi.fn(),
}))

vi.mock('node:child_process', () => ({ spawn: spawnMock }))
vi.mock('node:fs', () => ({ promises: fsMock }))
vi.mock('@fal-ai/client', () => falMock)

import { fetchTranscriptWithYtDlp } from '../packages/core/src/content/transcript/providers/youtube/yt-dlp.js'

const mockSpawnSuccess = () => {
  spawnMock.mockImplementation(() => {
    const proc = new EventEmitter() as unknown as {
      stderr?: PassThrough
      kill?: (signal?: string) => void
      on: (event: string, listener: (...args: unknown[]) => void) => void
      emit: (event: string, ...args: unknown[]) => void
    }
    proc.stderr = new PassThrough()
    proc.kill = vi.fn()
    process.nextTick(() => proc.emit('close', 0, null))
    return proc
  })
}

describe('yt-dlp transcript helper', () => {
  const originalFetch = globalThis.fetch

  beforeEach(() => {
    vi.clearAllMocks()
    vi.stubEnv('SUMMARIZE_DISABLE_LOCAL_WHISPER_CPP', '1')
    fsMock.stat.mockResolvedValue({ size: 5 })
    fsMock.readFile.mockResolvedValue(Buffer.from('audio'))
    fsMock.unlink.mockResolvedValue(undefined)
    globalThis.fetch = vi.fn() as unknown as typeof fetch
  })

  afterEach(() => {
    vi.unstubAllEnvs()
    globalThis.fetch = originalFetch
  })

  it('returns a helpful error when yt-dlp path is missing', async () => {
    const result = await fetchTranscriptWithYtDlp({
      ytDlpPath: null,
      openaiApiKey: 'OPENAI',
      falApiKey: null,
      url: 'https://youtu.be/dQw4w9WgXcQ',
    })

    expect(result.text).toBeNull()
    expect(result.error?.message).toMatch(/YT_DLP_PATH/)
  })

  it('returns a helpful error when transcription keys are missing', async () => {
    const result = await fetchTranscriptWithYtDlp({
      ytDlpPath: '/usr/bin/yt-dlp',
      openaiApiKey: null,
      falApiKey: null,
      url: 'https://youtu.be/dQw4w9WgXcQ',
    })

    expect(result.text).toBeNull()
    expect(result.error?.message).toMatch(/OPENAI_API_KEY or FAL_KEY/)
  })

  it('returns a helpful error when yt-dlp fails to download', async () => {
    spawnMock.mockImplementation(() => {
      const proc = new EventEmitter() as unknown as {
        stderr?: PassThrough
        kill?: (signal?: string) => void
        on: (event: string, listener: (...args: unknown[]) => void) => void
        emit: (event: string, ...args: unknown[]) => void
      }
      const stderr = new PassThrough()
      stderr.write('download failed')
      proc.stderr = stderr
      proc.kill = vi.fn()
      process.nextTick(() => proc.emit('close', 1, null))
      return proc
    })

    const result = await fetchTranscriptWithYtDlp({
      ytDlpPath: '/usr/bin/yt-dlp',
      openaiApiKey: 'OPENAI',
      falApiKey: null,
      url: 'https://youtu.be/dQw4w9WgXcQ',
    })

    expect(result.text).toBeNull()
    expect(result.error?.message).toMatch(/yt-dlp exited with code 1/)
  })

  it('passes --no-playlist to yt-dlp', async () => {
    mockSpawnSuccess()
    ;(globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(
      new Response(JSON.stringify({ text: 'OpenAI transcript' }), { status: 200 })
    )

    await fetchTranscriptWithYtDlp({
      ytDlpPath: '/usr/bin/yt-dlp',
      openaiApiKey: 'OPENAI',
      falApiKey: null,
      url: 'https://youtu.be/dQw4w9WgXcQ',
    })

    const args = spawnMock.mock.calls[0]?.[1] ?? []
    expect(args).toContain('--no-playlist')
  })

  it('uses OpenAI when available', async () => {
    mockSpawnSuccess()
    ;(globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(
      new Response(JSON.stringify({ text: 'OpenAI transcript' }), { status: 200 })
    )

    const result = await fetchTranscriptWithYtDlp({
      ytDlpPath: '/usr/bin/yt-dlp',
      openaiApiKey: 'OPENAI',
      falApiKey: 'FAL',
      url: 'https://youtu.be/dQw4w9WgXcQ',
    })

    expect(result.text).toBe('OpenAI transcript')
    expect(result.provider).toBe('openai')
    expect(result.error).toBeNull()
    expect(falMock.createFalClient).not.toHaveBeenCalled()
  })

  it('falls back to FAL when OpenAI fails', async () => {
    mockSpawnSuccess()
    ;(globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(
      new Response(JSON.stringify({ text: '' }), { status: 200 })
    )
    falMock.createFalClient.mockReturnValue({
      storage: { upload: vi.fn().mockResolvedValue('https://fal.ai/audio') },
      subscribe: vi.fn().mockResolvedValue({
        data: { chunks: [{ text: 'Fal' }, { text: 'transcript' }] },
      }),
    })

    const result = await fetchTranscriptWithYtDlp({
      ytDlpPath: '/usr/bin/yt-dlp',
      openaiApiKey: 'OPENAI',
      falApiKey: 'FAL',
      url: 'https://youtu.be/dQw4w9WgXcQ',
    })

    expect(result.text).toBe('Fal transcript')
    expect(result.provider).toBe('fal')
    expect(result.notes.join(' ')).toMatch(/falling back to FAL/i)
  })

  it('returns OpenAI error when OpenAI fails and no FAL key is present', async () => {
    mockSpawnSuccess()
    ;(globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(
      new Response('fail', { status: 500 })
    )

    const result = await fetchTranscriptWithYtDlp({
      ytDlpPath: '/usr/bin/yt-dlp',
      openaiApiKey: 'OPENAI',
      falApiKey: null,
      url: 'https://youtu.be/dQw4w9WgXcQ',
    })

    expect(result.text).toBeNull()
    expect(result.provider).toBe('openai')
    expect(result.error?.message).toMatch(/OpenAI transcription failed/)
  })

  it('returns an error when FAL returns empty text', async () => {
    mockSpawnSuccess()
    falMock.createFalClient.mockReturnValue({
      storage: { upload: vi.fn().mockResolvedValue('https://fal.ai/audio') },
      subscribe: vi.fn().mockResolvedValue({ data: { text: '' } }),
    })

    const result = await fetchTranscriptWithYtDlp({
      ytDlpPath: '/usr/bin/yt-dlp',
      openaiApiKey: null,
      falApiKey: 'FAL',
      url: 'https://youtu.be/dQw4w9WgXcQ',
    })

    expect(result.text).toBeNull()
    expect(result.provider).toBe('fal')
    expect(result.error?.message).toMatch(/FAL transcription returned empty text/)
  })
})
