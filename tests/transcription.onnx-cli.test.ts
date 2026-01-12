import { randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  resolvePreferredOnnxModel,
  transcribeWithOnnxCliFile,
} from '../packages/core/src/transcription/onnx-cli.js'

const originalEnv = { ...process.env }

afterEach(() => {
  process.env = { ...originalEnv }
  vi.restoreAllMocks()
})

describe('onnx cli transcriber', () => {
  it('downloads huggingface artifacts on first run and substitutes placeholders', async () => {
    const cacheDir = join(tmpdir(), `onnx-cache-${randomUUID()}`)
    process.env.SUMMARIZE_ONNX_CACHE_DIR = cacheDir
    process.env.SUMMARIZE_ONNX_MODEL_BASE_URL = 'https://example.invalid/model'
    process.env.SUMMARIZE_ONNX_PARAKEET_CMD =
      "cat {model} {vocab} {input} >/dev/null; printf 'downloaded'"

    const responses = [new Response('dummy-model'), new Response('dummy-vocab')]
    const fetchMock = vi
      .spyOn(global, 'fetch')
      .mockImplementation(async () => responses.shift() ?? new Response('', { status: 404 }))

    const filePath = join(tmpdir(), `onnx-${randomUUID()}.wav`)
    await fs.writeFile(filePath, 'dummy')

    const result = await transcribeWithOnnxCliFile({
      model: 'parakeet',
      filePath,
      mediaType: 'audio/wav',
      totalDurationSeconds: null,
      onProgress: null,
    })

    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(result.text).toBe('downloaded')
    expect(await fs.readFile(join(cacheDir, 'parakeet', 'model.onnx'), 'utf8')).toBe('dummy-model')
    expect(await fs.readFile(join(cacheDir, 'parakeet', 'vocab.txt'), 'utf8')).toBe('dummy-vocab')

    await fs.rm(cacheDir, { recursive: true, force: true })
    await fs.unlink(filePath)
  })

  it('runs configured command with placeholder', async () => {
    const filePath = join(tmpdir(), `onnx-${randomUUID()}.bin`)
    await fs.writeFile(filePath, 'dummy')

    const cacheDir = join(tmpdir(), `onnx-cache-${randomUUID()}`)
    process.env.SUMMARIZE_ONNX_CACHE_DIR = cacheDir
    process.env.SUMMARIZE_ONNX_MODEL_BASE_URL = 'https://example.invalid/model'

    vi.spyOn(global, 'fetch').mockImplementation(async () => new Response('noop'))

    process.env.SUMMARIZE_ONNX_PARAKEET_CMD = "cat {input} >/dev/null; printf 'hello world'"

    const result = await transcribeWithOnnxCliFile({
      model: 'parakeet',
      filePath,
      mediaType: 'audio/mpeg',
      totalDurationSeconds: null,
      onProgress: null,
    })

    await fs.rm(cacheDir, { recursive: true, force: true })
    await fs.unlink(filePath)

    expect(result.provider).toBe('onnx-parakeet')
    expect(result.text).toBe('hello world')
    expect(result.error).toBeNull()
  })

  it('supports argv-style JSON command templates (no shell) and handles spaces in paths', async () => {
    const filePath = join(tmpdir(), `onnx ${randomUUID()}.wav`)
    await fs.writeFile(filePath, 'dummy')

    const cacheDir = join(tmpdir(), `onnx-cache-${randomUUID()}`)
    process.env.SUMMARIZE_ONNX_CACHE_DIR = cacheDir
    process.env.SUMMARIZE_ONNX_MODEL_BASE_URL = 'https://example.invalid/model'

    vi.spyOn(global, 'fetch').mockImplementation(async () => new Response('noop'))

    process.env.SUMMARIZE_ONNX_PARAKEET_CMD = JSON.stringify([
      'node',
      '-e',
      "process.stdout.write(process.argv[1] ?? '')",
      '{input}',
    ])

    const result = await transcribeWithOnnxCliFile({
      model: 'parakeet',
      filePath,
      mediaType: 'audio/wav',
      totalDurationSeconds: null,
      onProgress: null,
    })

    await fs.rm(cacheDir, { recursive: true, force: true })
    await fs.unlink(filePath)

    expect(result.text).toBe(filePath)
    expect(result.error).toBeNull()
  })

  it('escapes placeholders for shell templates (spaces in paths)', async () => {
    const filePath = join(tmpdir(), `onnx shell ${randomUUID()}.wav`)
    await fs.writeFile(filePath, 'dummy')

    const cacheDir = join(tmpdir(), `onnx-cache-${randomUUID()}`)
    process.env.SUMMARIZE_ONNX_CACHE_DIR = cacheDir
    process.env.SUMMARIZE_ONNX_MODEL_BASE_URL = 'https://example.invalid/model'

    vi.spyOn(global, 'fetch').mockImplementation(async () => new Response('noop'))

    process.env.SUMMARIZE_ONNX_PARAKEET_CMD =
      'node -e "process.stdout.write(process.argv[process.argv.length - 1] ?? \'\')" -- {input}'

    const result = await transcribeWithOnnxCliFile({
      model: 'parakeet',
      filePath,
      mediaType: 'audio/wav',
      totalDurationSeconds: null,
      onProgress: null,
    })

    await fs.rm(cacheDir, { recursive: true, force: true })
    await fs.unlink(filePath)

    expect(result.text).toBe(filePath)
    expect(result.error).toBeNull()
  })

  it('uses provided env instead of process.env (daemon-style override)', async () => {
    const filePath = join(tmpdir(), `onnx-${randomUUID()}.wav`)
    await fs.writeFile(filePath, 'dummy')

    delete process.env.SUMMARIZE_ONNX_PARAKEET_CMD

    const env = {
      ...process.env,
      SUMMARIZE_ONNX_CACHE_DIR: join(tmpdir(), `onnx-cache-${randomUUID()}`),
      SUMMARIZE_ONNX_MODEL_BASE_URL: 'https://example.invalid/model',
      SUMMARIZE_ONNX_PARAKEET_CMD: "cat {input} >/dev/null; printf 'ok'",
    }

    vi.spyOn(global, 'fetch').mockImplementation(async () => new Response('noop'))

    const result = await transcribeWithOnnxCliFile({
      model: 'parakeet',
      filePath,
      mediaType: 'audio/wav',
      totalDurationSeconds: null,
      onProgress: null,
      env,
    })

    const cacheDir = env.SUMMARIZE_ONNX_CACHE_DIR
    if (!cacheDir) throw new Error('missing SUMMARIZE_ONNX_CACHE_DIR')

    await fs.rm(cacheDir, { recursive: true, force: true })
    await fs.unlink(filePath)

    expect(result.text).toBe('ok')
    expect(result.error).toBeNull()
  })

  it('resolves preferred ONNX model from env', () => {
    expect(resolvePreferredOnnxModel({ SUMMARIZE_TRANSCRIBER: 'parakeet' })).toBe('parakeet')
    expect(resolvePreferredOnnxModel({ SUMMARIZE_TRANSCRIBER: '  CANARY ' })).toBe('canary')
    expect(resolvePreferredOnnxModel({ SUMMARIZE_TRANSCRIBER: 'whisper' })).toBeNull()
    expect(resolvePreferredOnnxModel({})).toBeNull()
  })

  it('reports missing command', async () => {
    const filePath = join(tmpdir(), `onnx-${randomUUID()}.bin`)
    await fs.writeFile(filePath, 'dummy')

    delete process.env.SUMMARIZE_ONNX_PARAKEET_CMD

    const result = await transcribeWithOnnxCliFile({
      model: 'parakeet',
      filePath,
      mediaType: 'audio/mpeg',
      totalDurationSeconds: null,
      onProgress: null,
    })

    await fs.unlink(filePath)

    expect(result.text).toBeNull()
    expect(result.error).toBeInstanceOf(Error)
    expect(result.provider).toBe('onnx-parakeet')
  })
})
