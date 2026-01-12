import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { createWriteStream, promises as fs } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { basename, extname, join } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { isFfmpegAvailable, runFfmpegTranscodeToWav } from './whisper/ffmpeg.js'
import type { WhisperProgressEvent, WhisperTranscriptionResult } from './whisper/types.js'
import { wrapError } from './whisper/utils.js'

export type OnnxModelId = 'parakeet' | 'canary'

type Env = Record<string, string | undefined>

export function resolvePreferredOnnxModel(env: Env = process.env): OnnxModelId | null {
  const raw = env.SUMMARIZE_TRANSCRIBER?.trim().toLowerCase() ?? ''
  return raw === 'parakeet' || raw === 'canary' ? raw : null
}

export function isOnnxCliConfigured(model: OnnxModelId, env: Env = process.env): boolean {
  return resolveOnnxCommand(model, env) !== null
}

const COMMAND_ENV_VAR: Record<OnnxModelId, string> = {
  parakeet: 'SUMMARIZE_ONNX_PARAKEET_CMD',
  canary: 'SUMMARIZE_ONNX_CANARY_CMD',
}

const MODEL_SOURCES: Record<
  OnnxModelId,
  { repo: string; files: { name: string; path: string }[] }
> = {
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

export function resolveOnnxCommand(model: OnnxModelId, env: Env = process.env): string | null {
  const raw = env[COMMAND_ENV_VAR[model]]?.trim()
  return raw && raw.length > 0 ? raw : null
}

type ModelArtifacts = { modelDir: string; modelPath: string; vocabPath: string }

type CommandTemplate =
  | { kind: 'argv'; argvTemplate: string[] }
  | { kind: 'shell'; commandTemplate: string }

function parseCommandTemplate(raw: string): CommandTemplate {
  const trimmed = raw.trim()
  if (trimmed.startsWith('[')) {
    try {
      const parsed: unknown = JSON.parse(trimmed)
      if (
        Array.isArray(parsed) &&
        parsed.length > 0 &&
        parsed.every((v) => typeof v === 'string' && v.trim().length > 0)
      ) {
        return { kind: 'argv', argvTemplate: parsed as string[] }
      }
    } catch {
      // fall through to shell mode
    }
  }
  return { kind: 'shell', commandTemplate: trimmed }
}

function shellEscape(value: string): string {
  if (process.platform === 'win32') {
    // Best-effort: quote for cmd.exe-ish shells.
    return `"${value.replaceAll('"', '""')}"`
  }
  // POSIX shell-safe single-quote escaping.
  return `'${value.replaceAll("'", `'\\''`)}'`
}

function buildArgvCommand({
  argvTemplate,
  inputPath,
  artifacts,
}: {
  argvTemplate: string[]
  inputPath: string
  artifacts: ModelArtifacts
}): { command: string; args: string[] } {
  const inputPlaceholderPresent = argvTemplate.some((arg) => arg.includes('{input}'))
  const replacements: Record<string, string> = {
    '{input}': inputPath,
    '{model_dir}': artifacts.modelDir,
    '{model}': artifacts.modelPath,
    '{vocab}': artifacts.vocabPath,
  }

  const argv = argvTemplate.map((arg) => {
    let next = arg
    for (const [needle, replacement] of Object.entries(replacements)) {
      if (next.includes(needle)) next = next.replaceAll(needle, replacement)
    }
    return next
  })

  if (!inputPlaceholderPresent) argv.push(inputPath)

  const [command, ...args] = argv
  return { command, args }
}

function buildShellCommand({
  commandTemplate,
  inputPath,
  artifacts,
}: {
  commandTemplate: string
  inputPath: string
  artifacts: ModelArtifacts
}): string {
  const inputPlaceholderPresent = commandTemplate.includes('{input}')
  const replacements: Record<string, string> = {
    '{input}': shellEscape(inputPath),
    '{model_dir}': shellEscape(artifacts.modelDir),
    '{model}': shellEscape(artifacts.modelPath),
    '{vocab}': shellEscape(artifacts.vocabPath),
  }

  let command = commandTemplate
  for (const [needle, replacement] of Object.entries(replacements)) {
    if (command.includes(needle)) {
      command = command.replaceAll(needle, replacement)
    }
  }

  if (!inputPlaceholderPresent) {
    command = `${command} ${shellEscape(inputPath)}`
  }

  return command
}

function resolveCacheDir(env: Env) {
  const override = env.SUMMARIZE_ONNX_CACHE_DIR?.trim()
  if (override) return override
  const base = env.XDG_CACHE_HOME?.trim() || join(homedir(), '.cache')
  return join(base, 'summarize', 'onnx')
}

async function ensurePathExists(path: string) {
  await fs.mkdir(path, { recursive: true })
}

async function downloadFile(url: string, destination: string) {
  const response = await fetch(url)
  if (!response.ok || !response.body) {
    throw new Error(
      `download failed (${response.status}): ${response.statusText || 'unknown error'}`
    )
  }

  await pipeline(Readable.fromWeb(response.body), createWriteStream(destination))
}

async function ensureModelArtifactsDownloaded({
  model,
  notes,
  env,
}: {
  model: OnnxModelId
  notes: string[]
  env: Env
}): Promise<ModelArtifacts> {
  const cacheDir = resolveCacheDir(env)
  const modelDir = join(cacheDir, model)
  await ensurePathExists(modelDir)

  const source = MODEL_SOURCES[model]
  const mirrorOverride = env.SUMMARIZE_ONNX_MODEL_BASE_URL?.trim()?.replace(/\/$/, '') || null

  let downloaded = false
  for (const file of source.files) {
    const targetPath = join(modelDir, file.path)
    const exists = await fs
      .stat(targetPath)
      .then(() => true)
      .catch(() => false)
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
  env = process.env,
}: {
  model: OnnxModelId
  bytes: Uint8Array
  mediaType: string
  filename: string | null
  totalDurationSeconds?: number | null
  onProgress?: ((event: WhisperProgressEvent) => void) | null
  env?: Env
}): Promise<WhisperTranscriptionResult> {
  const nameHint = filename?.trim() || 'media'
  const baseName = basename(nameHint).replaceAll('/', '_').replaceAll('\\', '_').trim() || 'media'
  const safeName = extname(baseName) ? baseName : `${baseName}${extname(nameHint) || '.bin'}`
  const tempFile = join(tmpdir(), `summarize-onnx-${randomUUID()}-${safeName}`)
  try {
    await fs.writeFile(tempFile, bytes)
    return transcribeWithOnnxCliFile({
      model,
      filePath: tempFile,
      mediaType,
      totalDurationSeconds,
      onProgress,
      env,
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
  env = process.env,
}: {
  model: OnnxModelId
  filePath: string
  mediaType: string
  totalDurationSeconds?: number | null
  onProgress?: ((event: WhisperProgressEvent) => void) | null
  env?: Env
}): Promise<WhisperTranscriptionResult> {
  const notes: string[] = []
  const commandTemplate = resolveOnnxCommand(model, env)
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
    artifacts = await ensureModelArtifactsDownloaded({ model, notes, env })
  } catch (error) {
    return {
      text: null,
      provider,
      error: wrapError(`${provider} model download failed`, error),
      notes,
    }
  }

  const wavInput = await ensureWavInput({ filePath, mediaType, notes })
  const template = parseCommandTemplate(commandTemplate)
  const argvCommand =
    template.kind === 'argv'
      ? buildArgvCommand({
          argvTemplate: template.argvTemplate,
          inputPath: wavInput.path,
          artifacts,
        })
      : null
  const shellCommand =
    template.kind === 'shell'
      ? buildShellCommand({
          commandTemplate: template.commandTemplate,
          inputPath: wavInput.path,
          artifacts,
        })
      : null

  return new Promise<WhisperTranscriptionResult>((resolve) => {
    onProgress?.({
      partIndex: null,
      parts: null,
      processedDurationSeconds: null,
      totalDurationSeconds,
    })

    const proc = argvCommand
      ? spawn(argvCommand.command, argvCommand.args, { stdio: ['ignore', 'pipe', 'pipe'] })
      : spawn(shellCommand as string, { shell: true, stdio: ['ignore', 'pipe', 'pipe'] })
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
    proc.on('close', (code) => {
      void (async () => {
        if (wavInput.cleanup) await wavInput.cleanup()

        if (code !== 0) {
          resolve({
            text: null,
            provider,
            error: new Error(
              `${provider} failed (${code ?? 'unknown'}): ${stderr.trim() || 'unknown error'}`
            ),
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
      })()
    })
  })
}
