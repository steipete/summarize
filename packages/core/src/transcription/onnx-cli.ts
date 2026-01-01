import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { createWriteStream, promises as fs } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { extname, join } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import {
  isFfmpegAvailable,
  runFfmpegTranscodeToWav,
} from './whisper/ffmpeg.js'
import type { WhisperProgressEvent, WhisperTranscriptionResult } from './whisper/types.js'
import { wrapError } from './whisper/utils.js'

export type OnnxModelId = 'parakeet' | 'canary'

const COMMAND_ENV_VAR: Record<OnnxModelId, string> = {
  parakeet: 'SUMMARIZE_ONNX_PARAKEET_CMD',
  canary: 'SUMMARIZE_ONNX_CANARY_CMD',
}

const MODEL_SOURCES: Record<OnnxModelId, { repo: string; files: { name: string; path: string }[] }> = {
  parakeet: {
    repo: 'istupakov/parakeet-tdt-0.6b-v3-onnx',
    files: [
      { name: 'model', path: 'model.onnx' },
      { name: 'vocab', path: 'vocab.txt' },
    ],
  },
  canary: {
    repo: 'istupakov/canary-1b-v2-onnx',
    files: [
      { name: 'model', path: 'model.onnx' },
      { name: 'vocab', path: 'vocab.txt' },
    ],
  },
}

export function resolveOnnxProviderId(model: OnnxModelId): WhisperTranscriptionResult['provider'] {
  return model === 'parakeet' ? 'onnx-parakeet' : 'onnx-canary'
}

export function resolveOnnxCommand(model: OnnxModelId): string | null {
  const raw = process.env[COMMAND_ENV_VAR[model]]?.trim()
  return raw && raw.length > 0 ? raw : null
}

type ModelArtifacts = { modelDir: string; modelPath: string; vocabPath: string }

function resolveCacheDir() {
  const override = process.env.SUMMARIZE_ONNX_CACHE_DIR?.trim()
  if (override) return override
  const base = process.env.XDG_CACHE_HOME?.trim() || join(homedir(), '.cache')
  return join(base, 'summarize', 'onnx')
}

async function ensurePathExists(path: string) {
  await fs.mkdir(path, { recursive: true })
}

async function downloadFile(url: string, destination: string) {
  const response = await fetch(url)
  if (!response.ok || !response.body) {
    throw new Error(`download failed (${response.status}): ${response.statusText || 'unknown error'}`)
  }

  await pipeline(Readable.fromWeb(response.body), createWriteStream(destination))
}

async function ensureModelArtifactsDownloaded({
  model,
  notes,
}: {
  model: OnnxModelId
  notes: string[]
}): Promise<ModelArtifacts> {
  const cacheDir = resolveCacheDir()
  const modelDir = join(cacheDir, model)
  await ensurePathExists(modelDir)

  const source = MODEL_SOURCES[model]
  const mirrorOverride = process.env.SUMMARIZE_ONNX_MODEL_BASE_URL?.trim()?.replace(/\/$/, '') || null

  let downloaded = false
  for (const file of source.files) {
    const targetPath = join(modelDir, file.path)
    const exists = await fs.stat(targetPath).then(() => true).catch(() => false)
    if (exists) continue

    const baseUrl = mirrorOverride || `https://huggingface.co/${source.repo}/resolve/main`
    const url = `${baseUrl}/${file.path}`
    await downloadFile(url, targetPath)
    downloaded = true
  }

  if (downloaded) {
    notes.push(`Downloaded ${model} ONNX files to ${modelDir}`)
  }

  return {
    modelDir,
    modelPath: join(modelDir, 'model.onnx'),
    vocabPath: join(modelDir, 'vocab.txt'),
  }
}

function buildCommand(commandTemplate: string, inputPath: string, artifacts: ModelArtifacts): string {
  const inputPlaceholderPresent = commandTemplate.includes('{input}')
  const replacements: Record<string, string> = {
    '{input}': inputPath,
    '{model_dir}': artifacts.modelDir,
    '{model}': artifacts.modelPath,
    '{vocab}': artifacts.vocabPath,
  }

  let command = commandTemplate
  for (const [needle, replacement] of Object.entries(replacements)) {
    if (command.includes(needle)) {
      command = command.replaceAll(needle, replacement)
    }
  }

  if (!inputPlaceholderPresent) {
    command = `${command} ${inputPath}`
  }

  return command
}

async function ensureWavInput({
  filePath,
  mediaType,
  notes,
}: {
  filePath: string
  mediaType: string
  notes: string[]
}): Promise<{ path: string; cleanup: (() => Promise<void>) | null }> {
  const lower = mediaType.toLowerCase()
  if (lower.includes('wav') || lower.includes('wave')) {
    return { path: filePath, cleanup: null }
  }

  const ffmpegAvailable = await isFfmpegAvailable()
  if (!ffmpegAvailable) {
    notes.push('ONNX transcriber: proceeding without ffmpeg transcode (input not WAV)')
    return { path: filePath, cleanup: null }
  }

  const outputPath = join(tmpdir(), `summarize-onnx-${randomUUID()}.wav`)
  try {
    await runFfmpegTranscodeToWav({ inputPath: filePath, outputPath })
    notes.push('ONNX transcriber: transcoded media to 16kHz WAV via ffmpeg')
    return {
      path: outputPath,
      cleanup: async () => {
        await fs.unlink(outputPath).catch(() => {})
      },
    }
  } catch (error) {
    notes.push(
      `ONNX transcriber: ffmpeg transcode to WAV failed (${wrapError('ffmpeg', error).message}); using original input`
    )
    return { path: filePath, cleanup: null }
  }
}

export async function transcribeWithOnnxCli({
  model,
  bytes,
  mediaType,
  filename,
  totalDurationSeconds = null,
  onProgress = null,
}: {
  model: OnnxModelId
  bytes: Uint8Array
  mediaType: string
  filename: string | null
  totalDurationSeconds?: number | null
  onProgress?: ((event: WhisperProgressEvent) => void) | null
}): Promise<WhisperTranscriptionResult> {
  const tempFile = join(
    tmpdir(),
    `summarize-onnx-${randomUUID()}-${filename?.trim() || 'media'}${
      extname(filename ?? '') || '.bin'
    }`
  )
  try {
    await fs.writeFile(tempFile, bytes)
    return transcribeWithOnnxCliFile({
      model,
      filePath: tempFile,
      mediaType,
      totalDurationSeconds,
      onProgress,
    })
  } finally {
    await fs.unlink(tempFile).catch(() => {})
  }
}

export async function transcribeWithOnnxCliFile({
  model,
  filePath,
  mediaType,
  totalDurationSeconds = null,
  onProgress = null,
}: {
  model: OnnxModelId
  filePath: string
  mediaType: string
  totalDurationSeconds?: number | null
  onProgress?: ((event: WhisperProgressEvent) => void) | null
}): Promise<WhisperTranscriptionResult> {
  const notes: string[] = []
  const commandTemplate = resolveOnnxCommand(model)
  const provider = resolveOnnxProviderId(model)

  if (!commandTemplate) {
    return {
      text: null,
      provider,
      error: new Error(
        `${provider}: command not configured (set ${COMMAND_ENV_VAR[model]} to a CLI that emits text from WAV audio)`
      ),
      notes,
    }
  }

  let artifacts: ModelArtifacts
  try {
    artifacts = await ensureModelArtifactsDownloaded({ model, notes })
  } catch (error) {
    return {
      text: null,
      provider,
      error: wrapError(`${provider} model download failed`, error),
      notes,
    }
  }

  const wavInput = await ensureWavInput({ filePath, mediaType, notes })
  const command = buildCommand(commandTemplate, wavInput.path, artifacts)

  return new Promise<WhisperTranscriptionResult>((resolve) => {
    onProgress?.({
      partIndex: null,
      parts: null,
      processedDurationSeconds: null,
      totalDurationSeconds,
    })

    const proc = spawn(command, { shell: true, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    proc.stdout?.setEncoding('utf8')
    proc.stdout?.on('data', (chunk: string) => {
      if (stdout.length > 256_000) return
      stdout += chunk
    })
    proc.stderr?.setEncoding('utf8')
    proc.stderr?.on('data', (chunk: string) => {
      if (stderr.length > 16_000) return
      stderr += chunk
    })
    proc.on('error', (error) => {
      if (wavInput.cleanup) {
        void wavInput.cleanup()
      }
      resolve({ text: null, provider, error: wrapError(`${provider} failed`, error), notes })
    })
    proc.on('close', async (code) => {
      if (wavInput.cleanup) await wavInput.cleanup()

      if (code !== 0) {
        resolve({
          text: null,
          provider,
          error: new Error(`${provider} failed (${code ?? 'unknown'}): ${stderr.trim() || 'unknown error'}`),
          notes,
        })
        return
      }

      const trimmed = stdout.trim()
      if (!trimmed) {
        resolve({
          text: null,
          provider,
          error: new Error(`${provider} returned empty text`),
          notes,
        })
        return
      }

      resolve({ text: trimmed, provider, error: null, notes })
    })
  })
}
