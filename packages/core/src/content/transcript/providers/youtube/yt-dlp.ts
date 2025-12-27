import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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
  openaiApiKey: string | null
  falApiKey: string | null
  url: string
  onProgress?: ((event: LinkPreviewProgressEvent) => void) | null
}

export const fetchTranscriptWithYtDlp = async ({
  ytDlpPath,
  openaiApiKey,
  falApiKey,
  url,
  onProgress,
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
  const providerHint: 'cpp' | 'openai' | 'fal' | 'openai->fal' | 'unknown' = hasLocalWhisper
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
      service: 'youtube',
      mediaUrl: url,
      totalBytes: null,
    })
    await downloadAudio(ytDlpPath, url, outputFile)
    const stat = await fs.stat(outputFile)
    progress?.({
      kind: ProgressKind.TranscriptMediaDownloadDone,
      url,
      service: 'youtube',
      downloadedBytes: stat.size,
      totalBytes: null,
    })

    const probedDurationSeconds = await probeMediaDurationSecondsWithFfprobe(outputFile)
    progress?.({
      kind: ProgressKind.TranscriptWhisperStart,
      url,
      service: 'youtube',
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
      onProgress: (event) => {
        progress?.({
          kind: ProgressKind.TranscriptWhisperProgress,
          url,
          service: 'youtube',
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

async function downloadAudio(ytDlpPath: string, url: string, outputFile: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const args = [
      '-x',
      '--audio-format',
      'mp3',
      '--no-playlist',
      '--retries',
      '3',
      '--no-warnings',
      '-o',
      outputFile,
      url,
    ]

    const proc = spawn(ytDlpPath, args, { stdio: ['ignore', 'ignore', 'pipe'] })
    let stderr = ''

    if (proc.stderr) {
      proc.stderr.setEncoding('utf8')
      proc.stderr.on('data', (chunk: string) => {
        if (stderr.length >= MAX_STDERR_BYTES) return
        const remaining = MAX_STDERR_BYTES - stderr.length
        stderr += chunk.slice(0, remaining)
      })
    }

    const timeout = setTimeout(() => {
      proc.kill('SIGTERM')
      reject(new Error('yt-dlp download timeout'))
    }, YT_DLP_TIMEOUT_MS)

    proc.on('close', (code, signal) => {
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

function wrapError(prefix: string, error: unknown): Error {
  if (error instanceof Error) {
    return new Error(`${prefix}: ${error.message}`, { cause: error })
  }
  return new Error(`${prefix}: ${String(error)}`)
}
