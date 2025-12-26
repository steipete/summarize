import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  DISABLE_LOCAL_WHISPER_CPP_ENV,
  WHISPER_CPP_BINARY_ENV,
  WHISPER_CPP_MODEL_PATH_ENV,
} from './constants.js'
import {
  isFfmpegAvailable,
  runFfmpegTranscodeToMp3,
  runFfmpegTranscodeToMp3Lenient,
} from './ffmpeg.js'
import type { WhisperProgressEvent, WhisperTranscriptionResult } from './types.js'
import { wrapError } from './utils.js'

export async function isWhisperCppReady(): Promise<boolean> {
  if (!isWhisperCppEnabled()) return false
  if (!(await isWhisperCliAvailable())) return false
  const model = await resolveWhisperCppModelPath()
  return Boolean(model)
}

export async function resolveWhisperCppModelNameForDisplay(): Promise<string | null> {
  const modelPath = await resolveWhisperCppModelPath()
  return modelPath ? resolveWhisperCppModelLabelFromPath(modelPath) : null
}

export async function transcribeWithWhisperCppFile({
  filePath,
  mediaType,
  totalDurationSeconds,
  onProgress,
}: {
  filePath: string
  mediaType: string
  totalDurationSeconds: number | null
  onProgress?: ((event: WhisperProgressEvent) => void) | null
}): Promise<WhisperTranscriptionResult> {
  const notes: string[] = []
  const modelPath = await resolveWhisperCppModelPath()
  if (!modelPath) {
    return {
      text: null,
      provider: null,
      error: new Error('whisper.cpp model not found (set SUMMARIZE_WHISPER_CPP_MODEL_PATH)'),
      notes,
    }
  }

  const canUseDirectly = isWhisperCppSupportedMediaType(mediaType)
  const canTranscode = !canUseDirectly && (await isFfmpegAvailable())
  if (!canUseDirectly && !canTranscode) {
    return {
      text: null,
      provider: 'whisper.cpp',
      error: new Error(
        `whisper.cpp supports only flac/mp3/ogg/wav (mediaType=${mediaType}); install ffmpeg to transcode`
      ),
      notes,
    }
  }
  const effectivePath = (() => {
    if (canUseDirectly) return { path: filePath, cleanup: null as (() => Promise<void>) | null }
    if (!canTranscode) return { path: filePath, cleanup: null as (() => Promise<void>) | null }
    const mp3Path = join(tmpdir(), `summarize-whisper-cpp-${randomUUID()}.mp3`)
    return {
      path: mp3Path,
      cleanup: async () => {
        await fs.unlink(mp3Path).catch(() => {})
      },
    }
  })()

  try {
    if (!canUseDirectly && canTranscode) {
      // whisper-cli supports only a few audio formats. We transcode via ffmpeg when possible to
      // keep “any media file” working locally too.
      try {
        await runFfmpegTranscodeToMp3({ inputPath: filePath, outputPath: effectivePath.path })
        notes.push('whisper.cpp: transcoded media to MP3 via ffmpeg')
      } catch (error) {
        await runFfmpegTranscodeToMp3Lenient({
          inputPath: filePath,
          outputPath: effectivePath.path,
        })
        notes.push('whisper.cpp: transcoded media to MP3 via ffmpeg (lenient)')
        notes.push(`whisper.cpp: strict transcode failed: ${wrapError('ffmpeg', error).message}`)
      }
      onProgress?.({
        partIndex: null,
        parts: null,
        processedDurationSeconds: null,
        totalDurationSeconds,
      })
    }

    const outputBase = join(tmpdir(), `summarize-whisper-cpp-out-${randomUUID()}`)
    const outputTxt = `${outputBase}.txt`

    const args = [
      '--model',
      modelPath,
      '--language',
      'auto',
      '--no-timestamps',
      '--no-prints',
      '--print-progress',
      '--output-txt',
      '--output-file',
      outputBase,
      effectivePath.path,
    ]

    try {
      await new Promise<void>((resolve, reject) => {
        const proc = spawn(resolveWhisperCppBinary(), args, { stdio: ['ignore', 'ignore', 'pipe'] })
        let stderr = ''
        proc.stderr?.setEncoding('utf8')
        let lastProgressPercent = -1
        proc.stderr?.on('data', (chunk: string) => {
          if (stderr.length <= 8192) {
            stderr += chunk
          }

          // Progress output from `whisper-cli --print-progress` arrives on stderr. We parse it
          // best-effort and map to seconds when we know the total duration.
          const lines = chunk.split(/\r?\n/)
          for (const line of lines) {
            const match = line.match(/progress\s*=\s*(\d{1,3})%/i)
            if (!match) continue
            const raw = Number(match[1])
            if (!Number.isFinite(raw)) continue
            const pct = Math.max(0, Math.min(100, Math.round(raw)))
            if (pct === lastProgressPercent) continue
            lastProgressPercent = pct
            const processed =
              typeof totalDurationSeconds === 'number' && totalDurationSeconds > 0
                ? (totalDurationSeconds * pct) / 100
                : null
            onProgress?.({
              partIndex: null,
              parts: null,
              processedDurationSeconds: processed,
              totalDurationSeconds,
            })
          }
        })
        proc.on('error', reject)
        proc.on('close', (code) => {
          if (code === 0) {
            resolve()
            return
          }
          reject(new Error(`whisper.cpp failed (${code ?? 'unknown'}): ${stderr.trim()}`))
        })
      })
    } catch (error) {
      return {
        text: null,
        provider: 'whisper.cpp',
        error: wrapError('whisper.cpp failed', error),
        notes,
      }
    }

    const raw = await fs.readFile(outputTxt, 'utf8').catch(() => '')
    await fs.unlink(outputTxt).catch(() => {})
    const text = raw.trim()
    if (!text) {
      return {
        text: null,
        provider: 'whisper.cpp',
        error: new Error('whisper.cpp returned empty text'),
        notes,
      }
    }
    notes.push(`whisper.cpp: model=${resolveWhisperCppModelLabelFromPath(modelPath)}`)
    return { text, provider: 'whisper.cpp', error: null, notes }
  } finally {
    await effectivePath.cleanup?.().catch(() => {})
  }
}

function isWhisperCppEnabled(): boolean {
  return (process.env[DISABLE_LOCAL_WHISPER_CPP_ENV] ?? '').trim() !== '1'
}

async function isWhisperCliAvailable(): Promise<boolean> {
  const bin = resolveWhisperCppBinary()
  return new Promise((resolve) => {
    const proc = spawn(bin, ['--help'], { stdio: ['ignore', 'ignore', 'ignore'] })
    proc.on('error', () => resolve(false))
    proc.on('close', (code) => resolve(code === 0))
  })
}

function resolveWhisperCppBinary(): string {
  const override = (process.env[WHISPER_CPP_BINARY_ENV] ?? '').trim()
  return override.length > 0 ? override : 'whisper-cli'
}

async function resolveWhisperCppModelPath(): Promise<string | null> {
  const override = (process.env[WHISPER_CPP_MODEL_PATH_ENV] ?? '').trim()
  if (override) {
    try {
      const stat = await fs.stat(override)
      return stat.isFile() ? override : null
    } catch {
      return null
    }
  }

  const home = (process.env.HOME ?? process.env.USERPROFILE ?? '').trim()
  const cacheCandidate = home
    ? join(home, '.summarize', 'cache', 'whisper-cpp', 'models', 'ggml-base.bin')
    : null
  if (cacheCandidate) {
    try {
      const stat = await fs.stat(cacheCandidate)
      if (stat.isFile()) return cacheCandidate
    } catch {
      // ignore
    }
  }

  return null
}

function resolveWhisperCppModelLabelFromPath(modelPath: string): string {
  const base = modelPath.split('/').pop() ?? modelPath
  let name = base
    .replace(/^ggml-/, '')
    .replace(/\.bin$/i, '')
    .replace(/\.en$/i, '')
  name = name.trim()
  return name.length > 0 ? name : base
}

function isWhisperCppSupportedMediaType(mediaType: string): boolean {
  const type = mediaType.toLowerCase().split(';')[0]?.trim() ?? ''
  return (
    type === 'audio/mpeg' ||
    type === 'audio/mp3' ||
    type === 'audio/mpga' ||
    type === 'audio/ogg' ||
    type === 'audio/oga' ||
    type === 'application/ogg' ||
    type === 'audio/flac' ||
    type === 'audio/x-wav' ||
    type === 'audio/wav'
  )
}
