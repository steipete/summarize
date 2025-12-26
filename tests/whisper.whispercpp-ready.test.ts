import { EventEmitter } from 'node:events'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

type MockProc = EventEmitter & {
  stderr: EventEmitter & { setEncoding: () => void }
}

vi.mock('node:child_process', () => {
  return {
    spawn: (_bin: string, args: string[]) => {
      const proc: MockProc = Object.assign(new EventEmitter(), {
        stderr: Object.assign(new EventEmitter(), { setEncoding: () => {} }),
      })

      // Validate we only use this mock for availability checks in these tests.
      if (!args.includes('--help')) {
        throw new Error(`Unexpected whisper-cli invocation in test: ${args.join(' ')}`)
      }

      process.nextTick(() => {
        const mode = (process.env.VITEST_WHISPER_SPAWN_MODE ?? 'ok').trim()
        if (mode === 'error') {
          proc.emit('error', new Error('spawn failed'))
          return
        }
        proc.emit('close', mode === 'nonzero' ? 1 : 0)
      })

      return proc
    },
  }
})

const ENV_KEYS = [
  'SUMMARIZE_DISABLE_LOCAL_WHISPER_CPP',
  'SUMMARIZE_WHISPER_CPP_BINARY',
  'SUMMARIZE_WHISPER_CPP_MODEL_PATH',
  'VITEST_WHISPER_SPAWN_MODE',
  'HOME',
  'USERPROFILE',
]

function snapshotEnv(): Record<string, string | undefined> {
  return Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]))
}

function restoreEnv(snapshot: Record<string, string | undefined>) {
  for (const k of ENV_KEYS) {
    const v = snapshot[k]
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
}

describe('whisper.cpp readiness', () => {
  const envSnapshot = snapshotEnv()

  afterEach(() => {
    restoreEnv(envSnapshot)
  })

  it('returns false when local whisper.cpp is disabled', async () => {
    process.env.SUMMARIZE_DISABLE_LOCAL_WHISPER_CPP = '1'
    process.env.VITEST_WHISPER_SPAWN_MODE = 'ok'

    const mod = await import('../packages/core/src/transcription/whisper')
    expect(await mod.isWhisperCppReady()).toBe(false)
  })

  it('returns false when whisper-cli is not available (spawn error)', async () => {
    process.env.SUMMARIZE_DISABLE_LOCAL_WHISPER_CPP = '0'
    process.env.VITEST_WHISPER_SPAWN_MODE = 'error'

    const mod = await import('../packages/core/src/transcription/whisper')
    expect(await mod.isWhisperCppReady()).toBe(false)
  })

  it('returns false when whisper-cli exists but model is missing', async () => {
    process.env.SUMMARIZE_DISABLE_LOCAL_WHISPER_CPP = '0'
    process.env.VITEST_WHISPER_SPAWN_MODE = 'ok'
    process.env.SUMMARIZE_WHISPER_CPP_MODEL_PATH = join(tmpdir(), `missing-${Date.now()}.bin`)

    const mod = await import('../packages/core/src/transcription/whisper')
    expect(await mod.isWhisperCppReady()).toBe(false)
  })

  it('returns true when whisper-cli exists and model path is valid', async () => {
    process.env.SUMMARIZE_DISABLE_LOCAL_WHISPER_CPP = '0'
    process.env.VITEST_WHISPER_SPAWN_MODE = 'ok'

    const dir = mkdtempSync(join(tmpdir(), 'summarize-whisper-test-'))
    const modelPath = join(dir, 'ggml-base.en.bin')
    writeFileSync(modelPath, 'x')
    process.env.SUMMARIZE_WHISPER_CPP_MODEL_PATH = modelPath

    const mod = await import('../packages/core/src/transcription/whisper')
    expect(await mod.isWhisperCppReady()).toBe(true)
    expect(await mod.resolveWhisperCppModelNameForDisplay()).toBe('base')
  })

  it('supports fallback model discovery under ~/.summarize/cache/whisper-cpp/models', async () => {
    process.env.SUMMARIZE_DISABLE_LOCAL_WHISPER_CPP = '0'
    process.env.VITEST_WHISPER_SPAWN_MODE = 'ok'
    delete process.env.SUMMARIZE_WHISPER_CPP_MODEL_PATH

    const home = mkdtempSync(join(tmpdir(), 'summarize-home-'))
    process.env.HOME = home
    delete process.env.USERPROFILE

    const modelPath = join(home, '.summarize', 'cache', 'whisper-cpp', 'models', 'ggml-base.bin')
    mkdirSync(join(home, '.summarize', 'cache', 'whisper-cpp', 'models'), { recursive: true })
    writeFileSync(modelPath, 'x')

    const mod = await import('../packages/core/src/transcription/whisper')
    expect(await mod.isWhisperCppReady()).toBe(true)
    expect(await mod.resolveWhisperCppModelNameForDisplay()).toBe('base')
  })
})
