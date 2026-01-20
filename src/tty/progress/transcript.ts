import type { LinkPreviewProgressEvent } from '@steipete/summarize-core/content'

import {
  formatBytes,
  formatBytesPerSecond,
  formatDurationSecondsSmart,
  formatElapsedMs,
} from '../format.js'
import type { OscProgressController } from '../osc-progress.js'
import type { ThemeRenderer } from '../theme.js'

export function createTranscriptProgressRenderer({
  spinner,
  oscProgress,
  theme,
}: {
  spinner: { setText: (text: string) => void }
  oscProgress?: OscProgressController | null
  theme?: ThemeRenderer | null
}): {
  stop: () => void
  onProgress: (event: LinkPreviewProgressEvent) => void
} {
  const state: {
    phase: 'idle' | 'download' | 'whisper'
    service: 'youtube' | 'podcast' | 'generic'
    downloadedBytes: number
    totalBytes: number | null
    startedAtMs: number | null
    whisperProviderHint: 'cpp' | 'onnx' | 'openai' | 'fal' | 'openai->fal' | 'unknown'
    mediaKind: 'video' | 'audio' | 'unknown'
    whisperModelId: string | null
    whisperProcessedSeconds: number | null
    whisperTotalSeconds: number | null
    whisperPartIndex: number | null
    whisperParts: number | null
    lastSpinnerUpdateAtMs: number
  } = {
    phase: 'idle',
    service: 'generic',
    downloadedBytes: 0,
    totalBytes: null,
    startedAtMs: null,
    whisperProviderHint: 'unknown',
    mediaKind: 'audio',
    whisperModelId: null,
    whisperProcessedSeconds: null,
    whisperTotalSeconds: null,
    whisperPartIndex: null,
    whisperParts: null,
    lastSpinnerUpdateAtMs: 0,
  }

  let ticker: ReturnType<typeof setInterval> | null = null

  const updateSpinner = (text: string, options?: { force?: boolean }) => {
    const now = Date.now()
    if (!options?.force && now - state.lastSpinnerUpdateAtMs < 100) return
    state.lastSpinnerUpdateAtMs = now
    spinner.setText(text)
  }

  const styleLabel = (text: string) => (theme ? theme.label(text) : text)
  const styleValue = (text: string) => (theme ? theme.value(text) : text)
  const styleDim = (text: string) => (theme ? theme.dim(text) : text)

  const renderLine = (label: string, detail: string, percentLabel?: string) => {
    if (!theme) {
      return `${label}${percentLabel ? ` ${percentLabel}` : ''}${detail}`
    }
    const percent = percentLabel ? ` ${styleValue(percentLabel)}` : ''
    return `${styleLabel(label)}${percent}${styleDim(detail)}`
  }

  const renderSimple = (label: string) =>
    theme ? `${styleLabel(label)}${styleDim('…')}` : `${label}…`

  const updateOscIndeterminate = (label: string) => {
    if (!oscProgress) return
    oscProgress.setIndeterminate(label)
  }

  const updateOscPercent = (label: string, percent: number) => {
    if (!oscProgress) return
    oscProgress.setPercent(label, percent)
  }

  const stopTicker = () => {
    if (!ticker) return
    clearInterval(ticker)
    ticker = null
  }

  const startTicker = (render: () => string) => {
    // Callers always `stopTicker()` before `startTicker()`. Keep this simple (and avoid
    // accidentally hiding duplicate tickers during refactors).
    ticker = setInterval(() => updateSpinner(render()), 1000)
  }

  const renderDownloadLine = () => {
    const downloaded = formatBytes(state.downloadedBytes)
    const total =
      typeof state.totalBytes === 'number' &&
      state.totalBytes > 0 &&
      state.downloadedBytes <= state.totalBytes
        ? `/${formatBytes(state.totalBytes)}`
        : ''
    const elapsedMs = typeof state.startedAtMs === 'number' ? Date.now() - state.startedAtMs : 0
    const elapsed = formatElapsedMs(elapsedMs)
    const rate =
      elapsedMs > 0 && state.downloadedBytes > 0
        ? `, ${formatBytesPerSecond(state.downloadedBytes / (elapsedMs / 1000))}`
        : ''
    const svc =
      state.service === 'podcast' ? 'podcast' : state.service === 'youtube' ? 'youtube' : 'media'
    const kindLabel = state.mediaKind === 'video' ? 'media' : 'audio'
    const kindDetail = state.mediaKind === 'video' ? 'video' : null
    const svcLabel = kindDetail ? `${svc}, ${kindDetail}` : svc
    return renderLine(
      `Downloading ${kindLabel}`,
      ` (${svcLabel}, ${downloaded}${total}, ${elapsed}${rate})…`
    )
  }

  const downloadTitle = () =>
    state.mediaKind === 'video' ? 'Downloading media' : 'Downloading audio'

  const formatProvider = (hint: typeof state.whisperProviderHint) => {
    if (hint === 'cpp') return 'Whisper.cpp'
    if (hint === 'onnx') return 'ONNX (Parakeet/Canary)'
    if (hint === 'openai') return 'Whisper/OpenAI'
    if (hint === 'fal') return 'Whisper/FAL'
    if (hint === 'openai->fal') return 'Whisper/OpenAI→FAL'
    return 'Whisper'
  }

  const renderWhisperLine = () => {
    const provider = formatProvider(state.whisperProviderHint)
    const providerLabel = state.whisperModelId ? `${provider}, ${state.whisperModelId}` : provider
    const svc =
      state.service === 'podcast' ? 'podcast' : state.service === 'youtube' ? 'youtube' : 'media'
    const elapsedMs = typeof state.startedAtMs === 'number' ? Date.now() - state.startedAtMs : 0
    const elapsed = formatElapsedMs(elapsedMs)
    const percent =
      typeof state.whisperProcessedSeconds === 'number' &&
      typeof state.whisperTotalSeconds === 'number' &&
      state.whisperTotalSeconds > 0
        ? Math.min(
            100,
            Math.max(
              0,
              Math.round((state.whisperProcessedSeconds / state.whisperTotalSeconds) * 100)
            )
          )
        : null

    const duration =
      typeof state.whisperProcessedSeconds === 'number' &&
      typeof state.whisperTotalSeconds === 'number' &&
      state.whisperTotalSeconds > 0
        ? `, ${formatDurationSecondsSmart(state.whisperProcessedSeconds)}/${formatDurationSecondsSmart(
            state.whisperTotalSeconds
          )}`
        : typeof state.whisperTotalSeconds === 'number' && state.whisperTotalSeconds > 0
          ? `, ${formatDurationSecondsSmart(state.whisperTotalSeconds)}`
          : ''

    const parts =
      typeof state.whisperPartIndex === 'number' &&
      typeof state.whisperParts === 'number' &&
      state.whisperPartIndex > 0 &&
      state.whisperParts > 0
        ? `, ${state.whisperPartIndex}/${state.whisperParts}`
        : ''

    const percentLabel = typeof percent === 'number' ? `${percent}%` : null

    return renderLine(
      'Transcribing',
      ` (${svc}, ${providerLabel}${duration}${parts}, ${elapsed})…`,
      percentLabel ?? undefined
    )
  }

  return {
    stop: stopTicker,
    onProgress: (event) => {
      if (event.kind === 'transcript-media-download-start') {
        state.phase = 'download'
        state.service = event.service
        state.mediaKind = event.mediaKind ?? state.mediaKind
        state.downloadedBytes = 0
        state.totalBytes = event.totalBytes
        state.startedAtMs = Date.now()
        stopTicker()
        startTicker(renderDownloadLine)
        updateSpinner(renderSimple(downloadTitle()), { force: true })
        updateOscIndeterminate(downloadTitle())
        return
      }

      if (event.kind === 'transcript-media-download-progress') {
        state.phase = 'download'
        state.service = event.service
        state.mediaKind = event.mediaKind ?? state.mediaKind
        state.downloadedBytes = event.downloadedBytes
        state.totalBytes = event.totalBytes
        updateSpinner(renderDownloadLine())
        if (typeof state.totalBytes === 'number' && state.totalBytes > 0) {
          updateOscPercent(downloadTitle(), (state.downloadedBytes / state.totalBytes) * 100)
        } else {
          updateOscIndeterminate(downloadTitle())
        }
        return
      }

      if (event.kind === 'transcript-media-download-done') {
        state.phase = 'download'
        state.service = event.service
        state.mediaKind = event.mediaKind ?? state.mediaKind
        state.downloadedBytes = event.downloadedBytes
        state.totalBytes = event.totalBytes
        stopTicker()
        updateSpinner(renderDownloadLine(), { force: true })
        return
      }

      if (event.kind === 'transcript-whisper-start') {
        state.phase = 'whisper'
        state.service = event.service
        state.whisperProviderHint = event.providerHint
        state.whisperModelId = event.modelId
        state.whisperProcessedSeconds = null
        state.whisperTotalSeconds = event.totalDurationSeconds
        state.whisperPartIndex = null
        state.whisperParts = event.parts
        state.startedAtMs = Date.now()
        stopTicker()
        startTicker(renderWhisperLine)
        updateSpinner(renderWhisperLine(), { force: true })
        if (typeof state.whisperTotalSeconds === 'number' && state.whisperTotalSeconds > 0) {
          updateOscPercent('Transcribing', 0)
        } else if (
          typeof state.whisperPartIndex === 'number' &&
          typeof state.whisperParts === 'number' &&
          state.whisperPartIndex > 0 &&
          state.whisperParts > 0
        ) {
          updateOscPercent('Transcribing', (state.whisperPartIndex / state.whisperParts) * 100)
        } else {
          updateOscIndeterminate('Transcribing')
        }
        return
      }

      if (event.kind === 'transcript-whisper-progress') {
        state.phase = 'whisper'
        state.service = event.service
        state.whisperProcessedSeconds = event.processedDurationSeconds
        state.whisperTotalSeconds = event.totalDurationSeconds
        state.whisperPartIndex = event.partIndex
        state.whisperParts = event.parts
        updateSpinner(renderWhisperLine())
        if (
          typeof state.whisperProcessedSeconds === 'number' &&
          typeof state.whisperTotalSeconds === 'number' &&
          state.whisperTotalSeconds > 0
        ) {
          updateOscPercent(
            'Transcribing',
            (state.whisperProcessedSeconds / state.whisperTotalSeconds) * 100
          )
        } else if (
          typeof state.whisperPartIndex === 'number' &&
          typeof state.whisperParts === 'number' &&
          state.whisperPartIndex > 0 &&
          state.whisperParts > 0
        ) {
          updateOscPercent('Transcribing', (state.whisperPartIndex / state.whisperParts) * 100)
        } else {
          updateOscIndeterminate('Transcribing')
        }
        return
      }

      if (event.kind === 'transcript-done') {
        stopTicker()
        oscProgress?.clear()
        updateSpinner(event.ok ? 'Transcribed…' : 'Transcript failed; fallback…', { force: true })
      }
    },
  }
}
