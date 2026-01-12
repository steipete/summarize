import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  isOnnxCliConfigured,
  resolvePreferredOnnxModel,
} from '../../../../transcription/onnx-cli.js'
import {
  isWhisperCppReady,
  probeMediaDurationSecondsWithFfprobe,
  type TranscriptionProvider,
  transcribeMediaFileWithWhisper,
} from '../../../../transcription/whisper.js'
import type { LinkPreviewProgressEvent } from '../../../link-preview/deps.js'
import { ProgressKind } from '../../../link-preview/deps.js'

const YT_DLP_TIMEOUT_MS = 300_000
const MAX_STDERR_BYTES = 8192

type YtDlpTranscriptResult = {
  text: string | null
  provider: TranscriptionProvider | null
  error: Error | null
  notes: string[]
}

type YtDlpRequest = {
  ytDlpPath: string | null
  env?: Record<string, string | undefined>
  openaiApiKey: string | null
  falApiKey: string | null
  url: string
  onProgress?: ((event: LinkPreviewProgressEvent) => void) | null
  service?: 'youtube' | 'podcast' | 'generic'
  extraArgs?: string[]
}

type YtDlpDurationRequest = {
  ytDlpPath: string | null
  url: string
}

export const fetchTranscriptWithYtDlp = async ({
  ytDlpPath,
  env,
  openaiApiKey,
  falApiKey,
  url,
  onProgress,
  service = 'youtube',
  extraArgs,
}: YtDlpRequest): Promise<YtDlpTranscriptResult> => {
  const notes: string[] = []

  if (!ytDlpPath) {
    return {
      text: null,
      provider: null,
      error: new Error('yt-dlp is not configured (set YT_DLP_PATH or ensure yt-dlp is on PATH)'),
      notes,
    }
  }
  const hasLocalWhisper = await isWhisperCppReady()
  if (!openaiApiKey && !falApiKey && !hasLocalWhisper) {
    return {
      text: null,
      provider: null,
      error: new Error(
        'No transcription providers available (install whisper-cpp or set OPENAI_API_KEY or FAL_KEY)'
      ),
      notes,
    }
  }

  const progress = typeof onProgress === 'function' ? onProgress : null
  const effectiveEnv = env ?? process.env
  const preferredOnnxModel = resolvePreferredOnnxModel(effectiveEnv)
  const onnxReady = preferredOnnxModel
    ? isOnnxCliConfigured(preferredOnnxModel, effectiveEnv)
    : false
  const providerHint: 'cpp' | 'onnx' | 'openai' | 'fal' | 'openai->fal' | 'unknown' = onnxReady
    ? 'onnx'
    : hasLocalWhisper
      ? 'cpp'
      : openaiApiKey && falApiKey
        ? 'openai->fal'
        : openaiApiKey
          ? 'openai'
          : falApiKey
            ? 'fal'
            : 'unknown'
  const modelId = hasLocalWhisper
    ? 'whisper.cpp'
    : openaiApiKey && falApiKey
      ? 'whisper-1->fal-ai/wizper'
      : openaiApiKey
        ? 'whisper-1'
        : falApiKey
          ? 'fal-ai/wizper'
          : null

  const outputFile = join(tmpdir(), `summarize-${randomUUID()}.mp3`)
  try {
    progress?.({
      kind: ProgressKind.TranscriptMediaDownloadStart,
      url,
      service,
      mediaUrl: url,
      totalBytes: null,
    })
    await downloadAudio(
      ytDlpPath,
      url,
      outputFile,
      extraArgs,
      progress
        ? (downloadedBytes, totalBytes) => {
            progress({
              kind: ProgressKind.TranscriptMediaDownloadProgress,
              url,
              service,
              downloadedBytes,
              totalBytes,
            })
          }
        : null
    )
    const stat = await fs.stat(outputFile)
    progress?.({
      kind: ProgressKind.TranscriptMediaDownloadDone,
      url,
      service,
      downloadedBytes: stat.size,
      totalBytes: null,
    })

    const probedDurationSeconds = await probeMediaDurationSecondsWithFfprobe(outputFile)
    progress?.({
      kind: ProgressKind.TranscriptWhisperStart,
      url,
      service,
      providerHint,
      modelId,
      totalDurationSeconds: probedDurationSeconds,
      parts: null,
    })
    const result = await transcribeMediaFileWithWhisper({
      filePath: outputFile,
      mediaType: 'audio/mpeg',
      filename: 'audio.mp3',
      openaiApiKey,
      falApiKey,
      totalDurationSeconds: probedDurationSeconds,
      env: effectiveEnv,
      onProgress: (event) => {
        progress?.({
          kind: ProgressKind.TranscriptWhisperProgress,
          url,
          service,
          processedDurationSeconds: event.processedDurationSeconds,
          totalDurationSeconds: event.totalDurationSeconds,
          partIndex: event.partIndex,
          parts: event.parts,
        })
      },
    })
    if (result.notes.length > 0) notes.push(...result.notes)
    return { text: result.text, provider: result.provider, error: result.error, notes }
  } catch (error) {
    return {
      text: null,
      provider: null,
      error: wrapError('yt-dlp failed to download audio', error),
      notes,
    }
  } finally {
    await fs.unlink(outputFile).catch(() => {})
  }
}

export const fetchDurationSecondsWithYtDlp = async ({
  ytDlpPath,
  url,
}: YtDlpDurationRequest): Promise<number | null> => {
  if (!ytDlpPath) return null

  return new Promise((resolve) => {
    const args = ['--skip-download', '--dump-json', '--no-playlist', '--no-warnings', url]
    const proc = spawn(ytDlpPath, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''

    const timeout = setTimeout(() => {
      proc.kill('SIGKILL')
      resolve(null)
    }, 30_000)

    proc.stdout.on('data', (chunk) => {
      stdout += chunk.toString()
    })

    proc.stderr.on('data', (chunk) => {
      stderr += chunk.toString()
      if (stderr.length > MAX_STDERR_BYTES) {
        stderr = stderr.slice(-MAX_STDERR_BYTES)
      }
    })

    proc.on('close', (code) => {
      clearTimeout(timeout)
      if (code !== 0) {
        resolve(null)
        return
      }
      const jsonLine = stdout
        .split(/\r?\n/)
        .map((line) => line.trim())
        .find((line) => line.startsWith('{'))
      if (!jsonLine) {
        resolve(null)
        return
      }
      try {
        const parsed = JSON.parse(jsonLine) as { duration?: unknown }
        const duration = typeof parsed.duration === 'number' ? parsed.duration : Number.NaN
        resolve(Number.isFinite(duration) && duration > 0 ? duration : null)
      } catch {
        resolve(null)
      }
    })

    proc.on('error', () => {
      clearTimeout(timeout)
      resolve(null)
    })
  })
}

async function downloadAudio(
  ytDlpPath: string,
  url: string,
  outputFile: string,
  extraArgs?: string[],
  onProgress?: ((downloadedBytes: number, totalBytes: number | null) => void) | null
): Promise<void> {
  return new Promise((resolve, reject) => {
    const progressTemplate =
      'progress:%(progress.downloaded_bytes)s|%(progress.total_bytes)s|%(progress.total_bytes_estimate)s'
    const args = [
      '-x',
      '--audio-format',
      'mp3',
      '--no-playlist',
      '--retries',
      '3',
      '--no-warnings',
      ...(onProgress ? ['--progress', '--newline', '--progress-template', progressTemplate] : []),
      ...(extraArgs?.length ? extraArgs : []),
      '-o',
      outputFile,
      url,
    ]

    const proc = spawn(ytDlpPath, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    let stderr = ''
    let progressBuffer = ''
    let lastTotalBytes: number | null = null

    const reportProgress = (downloadedBytes: number, totalBytes: number | null): void => {
      if (!onProgress) return
      let normalizedTotal = totalBytes
      if (typeof normalizedTotal === 'number' && Number.isFinite(normalizedTotal)) {
        if (normalizedTotal > 0) {
          if (lastTotalBytes === null || normalizedTotal > lastTotalBytes) {
            lastTotalBytes = normalizedTotal
          } else if (normalizedTotal < lastTotalBytes) {
            normalizedTotal = lastTotalBytes
          }
        }
      } else if (lastTotalBytes !== null) {
        normalizedTotal = lastTotalBytes
      }
      onProgress(downloadedBytes, normalizedTotal)
    }

    const handleProgressChunk = (chunk: string) => {
      if (!onProgress) return
      progressBuffer += chunk
      const lines = progressBuffer.split(/\r?\n/)
      progressBuffer = lines.pop() ?? ''
      for (const line of lines) {
        emitProgressFromLine(line, reportProgress)
      }
    }

    if (proc.stdout) {
      proc.stdout.setEncoding('utf8')
      proc.stdout.on('data', (chunk: string) => {
        handleProgressChunk(chunk)
      })
    }

    if (proc.stderr) {
      proc.stderr.setEncoding('utf8')
      proc.stderr.on('data', (chunk: string) => {
        if (stderr.length < MAX_STDERR_BYTES) {
          const remaining = MAX_STDERR_BYTES - stderr.length
          stderr += chunk.slice(0, remaining)
        }
        handleProgressChunk(chunk)
      })
    }

    const timeout = setTimeout(() => {
      proc.kill('SIGTERM')
      reject(new Error('yt-dlp download timeout'))
    }, YT_DLP_TIMEOUT_MS)

    proc.on('close', (code, signal) => {
      if (onProgress && progressBuffer.trim().length > 0) {
        emitProgressFromLine(progressBuffer, reportProgress)
      }
      clearTimeout(timeout)
      if (code === 0) {
        resolve()
        return
      }
      const detail = stderr.trim()
      const suffix = detail ? `: ${detail}` : ''
      if (code === null) {
        reject(new Error(`yt-dlp terminated (${signal ?? 'unknown'})${suffix}`))
        return
      }
      reject(new Error(`yt-dlp exited with code ${code}${suffix}`))
    })

    proc.on('error', (error) => {
      clearTimeout(timeout)
      reject(error)
    })
  })
}

function emitProgressFromLine(
  line: string,
  onProgress: (downloadedBytes: number, totalBytes: number | null) => void
): void {
  const trimmed = line.trim()
  if (!trimmed.startsWith('progress:')) return
  const payload = trimmed.slice('progress:'.length)
  const [downloadedRaw, totalRaw, estimateRaw] = payload.split('|')
  const downloaded = Number.parseFloat(downloadedRaw)
  if (!Number.isFinite(downloaded) || downloaded < 0) return
  const totalCandidate = Number.parseFloat(totalRaw)
  const estimateCandidate = Number.parseFloat(estimateRaw)
  const totalBytes =
    Number.isFinite(totalCandidate) && totalCandidate > 0
      ? totalCandidate
      : Number.isFinite(estimateCandidate) && estimateCandidate > 0
        ? estimateCandidate
        : null
  onProgress(downloaded, totalBytes)
}

function wrapError(prefix: string, error: unknown): Error {
  if (error instanceof Error) {
    return new Error(`${prefix}: ${error.message}`, { cause: error })
  }
  return new Error(`${prefix}: ${String(error)}`)
}
