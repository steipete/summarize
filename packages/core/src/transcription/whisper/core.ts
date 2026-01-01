import { randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DEFAULT_SEGMENT_SECONDS, MAX_OPENAI_UPLOAD_BYTES } from './constants.js'
import { transcribeWithFal } from './fal.js'
import { isFfmpegAvailable, runFfmpegSegment, transcodeBytesToMp3 } from './ffmpeg.js'
import { shouldRetryOpenAiViaFfmpeg, transcribeWithOpenAi } from './openai.js'
import { transcribeWithOnnxCli, transcribeWithOnnxCliFile } from '../onnx-cli.js'
import type {
  TranscriptionProvider,
  WhisperProgressEvent,
  WhisperTranscriptionResult,
} from './types.js'
import { ensureWhisperFilenameExtension, formatBytes, readFirstBytes, wrapError } from './utils.js'
import { isWhisperCppReady, transcribeWithWhisperCppFile } from './whisper-cpp.js'

function resolveTranscriberPreference(): 'whisper' | 'parakeet' | 'canary' {
  const raw = process.env.SUMMARIZE_TRANSCRIBER?.trim().toLowerCase()
  if (raw === 'parakeet' || raw === 'canary') return raw
  return 'whisper'
}

export async function transcribeMediaWithWhisper({
  bytes,
  mediaType,
  filename,
  openaiApiKey,
  falApiKey,
  totalDurationSeconds = null,
  onProgress,
}: {
  bytes: Uint8Array
  mediaType: string
  filename: string | null
  openaiApiKey: string | null
  falApiKey: string | null
  totalDurationSeconds?: number | null
  onProgress?: ((event: WhisperProgressEvent) => void) | null
}): Promise<WhisperTranscriptionResult> {
  const notes: string[] = []

  const preferredTranscriber = resolveTranscriberPreference()
  if (preferredTranscriber !== 'whisper') {
    const onnx = await transcribeWithOnnxCli({
      model: preferredTranscriber,
      bytes,
      mediaType,
      filename,
      totalDurationSeconds,
      onProgress,
    })
    if (onnx.text) {
      if (onnx.notes.length > 0) notes.push(...onnx.notes)
      return { ...onnx, notes }
    }
    if (onnx.notes.length > 0) notes.push(...onnx.notes)
    if (onnx.error) {
      notes.push(`${onnx.provider ?? 'onnx'} failed; falling back to Whisper: ${onnx.error.message}`)
    }
  }

  const localReady = await isWhisperCppReady()
  let local: WhisperTranscriptionResult | null = null
  if (localReady) {
    const nameHint = filename?.trim() ? filename.trim() : 'media'
    const tempFile = join(
      tmpdir(),
      `summarize-whisper-local-${randomUUID()}-${ensureWhisperFilenameExtension(nameHint, mediaType)}`
    )
    try {
      // Prefer local whisper.cpp when installed + model available (no network, no upload limits).
      await fs.writeFile(tempFile, bytes)
      try {
        local = await transcribeWithWhisperCppFile({
          filePath: tempFile,
          mediaType,
          totalDurationSeconds,
          onProgress,
        })
      } catch (error) {
        local = {
          text: null,
          provider: 'whisper.cpp',
          error: wrapError('whisper.cpp failed', error),
          notes: [],
        }
      }
      if (local.text) {
        if (local.notes.length > 0) notes.push(...local.notes)
        return { ...local, notes }
      }
      if (local.notes.length > 0) notes.push(...local.notes)
      if (local.error) {
        notes.push(`whisper.cpp failed; falling back to remote Whisper: ${local.error.message}`)
      }
    } finally {
      await fs.unlink(tempFile).catch(() => {})
    }
  }

  if (!openaiApiKey && !falApiKey) {
    return {
      text: null,
      provider: null,
      error: new Error(
        'No transcription providers available (install whisper-cpp or set OPENAI_API_KEY or FAL_KEY)'
      ),
      notes,
    }
  }

  if (openaiApiKey && bytes.byteLength > MAX_OPENAI_UPLOAD_BYTES) {
    const canChunk = await isFfmpegAvailable()
    if (canChunk) {
      const tempFile = join(tmpdir(), `summarize-whisper-${randomUUID()}`)
      try {
        await fs.writeFile(tempFile, bytes)
        const chunked = await transcribeMediaFileWithWhisper({
          filePath: tempFile,
          mediaType,
          filename,
          openaiApiKey,
          falApiKey,
          segmentSeconds: DEFAULT_SEGMENT_SECONDS,
          onProgress,
        })
        return chunked
      } finally {
        await fs.unlink(tempFile).catch(() => {})
      }
    }

    notes.push(
      `Media too large for Whisper upload (${formatBytes(bytes.byteLength)}); transcribing first ${formatBytes(MAX_OPENAI_UPLOAD_BYTES)} only (install ffmpeg for full transcription)`
    )
    bytes = bytes.slice(0, MAX_OPENAI_UPLOAD_BYTES)
  }

  let openaiError: Error | null = null
  if (openaiApiKey) {
    try {
      const text = await transcribeWithOpenAi(bytes, mediaType, filename, openaiApiKey)
      if (text) {
        return { text, provider: 'openai', error: null, notes }
      }
      openaiError = new Error('OpenAI transcription returned empty text')
    } catch (error) {
      openaiError = wrapError('OpenAI transcription failed', error)
    }
  }

  if (openaiApiKey && openaiError && shouldRetryOpenAiViaFfmpeg(openaiError)) {
    const canTranscode = await isFfmpegAvailable()
    if (canTranscode) {
      try {
        // Some providers hand out containers/codecs Whisper rejects. Transcoding to a small mono MP3
        // is the most reliable cross-format fallback (and also reduces upload size).
        notes.push('OpenAI could not decode media; transcoding via ffmpeg and retrying')
        const mp3Bytes = await transcodeBytesToMp3(bytes)
        const retried = await transcribeWithOpenAi(
          mp3Bytes,
          'audio/mpeg',
          'audio.mp3',
          openaiApiKey
        )
        if (retried) {
          return { text: retried, provider: 'openai', error: null, notes }
        }
        openaiError = new Error('OpenAI transcription returned empty text after ffmpeg transcode')
        bytes = mp3Bytes
        mediaType = 'audio/mpeg'
        filename = 'audio.mp3'
      } catch (error) {
        notes.push(
          `ffmpeg transcode failed; cannot retry OpenAI decode error: ${
            error instanceof Error ? error.message : String(error)
          }`
        )
      }
    } else {
      notes.push('OpenAI could not decode media; install ffmpeg to enable transcoding retry')
    }
  }

  const canUseFal = Boolean(falApiKey) && mediaType.toLowerCase().startsWith('audio/')
  if (openaiError && canUseFal) {
    notes.push(`OpenAI transcription failed; falling back to FAL: ${openaiError.message}`)
  }
  if (falApiKey && !canUseFal) {
    notes.push(`Skipping FAL transcription: unsupported mediaType ${mediaType}`)
  }

  if (falApiKey && canUseFal) {
    try {
      const text = await transcribeWithFal(bytes, mediaType, falApiKey)
      if (text) {
        return { text, provider: 'fal', error: null, notes }
      }
      return {
        text: null,
        provider: 'fal',
        error: new Error('FAL transcription returned empty text'),
        notes,
      }
    } catch (error) {
      return {
        text: null,
        provider: 'fal',
        error: wrapError('FAL transcription failed', error),
        notes,
      }
    }
  }

  return {
    text: null,
    provider: openaiApiKey ? 'openai' : null,
    error: openaiError ?? new Error('No transcription providers available'),
    notes,
  }
}

export async function transcribeMediaFileWithWhisper({
  filePath,
  mediaType,
  filename,
  openaiApiKey,
  falApiKey,
  segmentSeconds = DEFAULT_SEGMENT_SECONDS,
  totalDurationSeconds = null,
  onProgress = null,
}: {
  filePath: string
  mediaType: string
  filename: string | null
  openaiApiKey: string | null
  falApiKey: string | null
  segmentSeconds?: number
  totalDurationSeconds?: number | null
  onProgress?: ((event: WhisperProgressEvent) => void) | null
}): Promise<WhisperTranscriptionResult> {
  const notes: string[] = []

  const preferredTranscriber = resolveTranscriberPreference()
  if (preferredTranscriber !== 'whisper') {
    onProgress?.({
      partIndex: null,
      parts: null,
      processedDurationSeconds: null,
      totalDurationSeconds,
    })
    const onnx = await transcribeWithOnnxCliFile({
      model: preferredTranscriber,
      filePath,
      mediaType,
      totalDurationSeconds,
      onProgress,
    })
    if (onnx.text) {
      if (onnx.notes.length > 0) notes.push(...onnx.notes)
      return { ...onnx, notes }
    }
    if (onnx.notes.length > 0) notes.push(...onnx.notes)
    if (onnx.error) {
      notes.push(`${onnx.provider ?? 'onnx'} failed; falling back to Whisper: ${onnx.error.message}`)
    }
  }

  const localReady = await isWhisperCppReady()
  let local: WhisperTranscriptionResult | null = null
  if (localReady) {
    onProgress?.({
      partIndex: null,
      parts: null,
      processedDurationSeconds: null,
      totalDurationSeconds,
    })
    try {
      local = await transcribeWithWhisperCppFile({
        filePath,
        mediaType,
        totalDurationSeconds,
        onProgress,
      })
    } catch (error) {
      local = {
        text: null,
        provider: 'whisper.cpp',
        error: wrapError('whisper.cpp failed', error),
        notes: [],
      }
    }
    if (local.text) {
      if (local.notes.length > 0) notes.push(...local.notes)
      return { ...local, notes }
    }
    if (local.notes.length > 0) notes.push(...local.notes)
    if (local.error) {
      notes.push(`whisper.cpp failed; falling back to remote Whisper: ${local.error.message}`)
    }
  }

  if (!openaiApiKey && !falApiKey) {
    return {
      text: null,
      provider: null,
      error: new Error(
        'No transcription providers available (install whisper-cpp or set OPENAI_API_KEY or FAL_KEY)'
      ),
      notes,
    }
  }

  const stat = await fs.stat(filePath)
  if (openaiApiKey && stat.size > MAX_OPENAI_UPLOAD_BYTES) {
    const canChunk = await isFfmpegAvailable()
    if (!canChunk) {
      notes.push(
        `Media too large for Whisper upload (${formatBytes(stat.size)}); install ffmpeg to enable chunked transcription`
      )
      const head = await readFirstBytes(filePath, MAX_OPENAI_UPLOAD_BYTES)
      const partial = await transcribeMediaWithWhisper({
        bytes: head,
        mediaType,
        filename,
        openaiApiKey,
        falApiKey,
      })
      if (partial.notes.length > 0) notes.push(...partial.notes)
      return { ...partial, notes }
    }

    const dir = await fs.mkdtemp(join(tmpdir(), 'summarize-whisper-segments-'))
    try {
      const pattern = join(dir, 'part-%03d.mp3')
      await runFfmpegSegment({
        inputPath: filePath,
        outputPattern: pattern,
        segmentSeconds,
      })
      const files = (await fs.readdir(dir))
        .filter((name) => name.startsWith('part-') && name.endsWith('.mp3'))
        .sort((a, b) => a.localeCompare(b))
      if (files.length === 0) {
        return {
          text: null,
          provider: null,
          error: new Error('ffmpeg produced no audio segments'),
          notes,
        }
      }

      notes.push(`ffmpeg chunked media into ${files.length} parts (${segmentSeconds}s each)`)
      onProgress?.({
        partIndex: null,
        parts: files.length,
        processedDurationSeconds: null,
        totalDurationSeconds,
      })

      const parts: string[] = []
      let usedProvider: TranscriptionProvider | null = null
      for (const [index, name] of files.entries()) {
        const segmentPath = join(dir, name)
        const segmentBytes = new Uint8Array(await fs.readFile(segmentPath))
        const result = await transcribeMediaWithWhisper({
          bytes: segmentBytes,
          mediaType: 'audio/mpeg',
          filename: name,
          openaiApiKey,
          falApiKey,
          onProgress: null,
        })
        if (!usedProvider && result.provider) usedProvider = result.provider
        if (result.error && !result.text) {
          return { text: null, provider: usedProvider, error: result.error, notes }
        }
        if (result.text) parts.push(result.text)

        // Coarse but useful: update based on part boundaries. Duration is best-effort (RSS hints or
        // ffprobe); the per-part time is stable enough to make the spinner feel alive.
        const processedSeconds = Math.max(0, (index + 1) * segmentSeconds)
        onProgress?.({
          partIndex: index + 1,
          parts: files.length,
          processedDurationSeconds:
            typeof totalDurationSeconds === 'number' && totalDurationSeconds > 0
              ? Math.min(processedSeconds, totalDurationSeconds)
              : null,
          totalDurationSeconds,
        })
      }

      return { text: parts.join('\n\n'), provider: usedProvider, error: null, notes }
    } finally {
      await fs.rm(dir, { recursive: true, force: true }).catch(() => {})
    }
  }

  const bytes = new Uint8Array(await fs.readFile(filePath))
  onProgress?.({
    partIndex: null,
    parts: null,
    processedDurationSeconds: null,
    totalDurationSeconds,
  })
  const result = await transcribeMediaWithWhisper({
    bytes,
    mediaType,
    filename,
    openaiApiKey,
    falApiKey,
  })
  if (result.notes.length > 0) notes.push(...result.notes)
  return { ...result, notes }
}
