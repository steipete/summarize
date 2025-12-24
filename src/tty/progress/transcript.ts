import type { LinkPreviewProgressEvent } from '../../content/link-preview/deps.js'

import { formatBytes, formatBytesPerSecond, formatDurationSecondsSmart, formatElapsedMs } from '../format.js'

export function createTranscriptProgressRenderer({
  spinner,
}: {
  spinner: { setText: (text: string) => void }
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
    whisperProviderHint: 'openai' | 'fal' | 'openai->fal' | 'unknown'
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

  const stopTicker = () => {
    if (!ticker) return
    clearInterval(ticker)
    ticker = null
  }

  const startTicker = (render: () => string) => {
    if (ticker) return
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
    const svc = state.service === 'podcast' ? 'podcast' : state.service === 'youtube' ? 'youtube' : 'media'
    return `Downloading audio (${svc}, ${downloaded}${total}, ${elapsed}${rate})…`
  }

  const formatProvider = (hint: typeof state.whisperProviderHint) => {
    if (hint === 'openai') return 'Whisper/OpenAI'
    if (hint === 'fal') return 'Whisper/FAL'
    if (hint === 'openai->fal') return 'Whisper/OpenAI→FAL'
    return 'Whisper'
  }

  const renderWhisperLine = () => {
    const provider = formatProvider(state.whisperProviderHint)
    const svc = state.service === 'podcast' ? 'podcast' : state.service === 'youtube' ? 'youtube' : 'media'
    const elapsedMs = typeof state.startedAtMs === 'number' ? Date.now() - state.startedAtMs : 0
    const elapsed = formatElapsedMs(elapsedMs)

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

    return `Transcribing (${svc}, ${provider}${duration}${parts}, ${elapsed})…`
  }

  return {
    stop: stopTicker,
    onProgress: (event) => {
      if (event.kind === 'transcript-media-download-start') {
        state.phase = 'download'
        state.service = event.service
        state.downloadedBytes = 0
        state.totalBytes = event.totalBytes
        state.startedAtMs = Date.now()
        stopTicker()
        startTicker(renderDownloadLine)
        updateSpinner('Downloading audio…', { force: true })
        return
      }

      if (event.kind === 'transcript-media-download-progress') {
        state.phase = 'download'
        state.service = event.service
        state.downloadedBytes = event.downloadedBytes
        state.totalBytes = event.totalBytes
        updateSpinner(renderDownloadLine())
        return
      }

      if (event.kind === 'transcript-media-download-done') {
        state.phase = 'download'
        state.service = event.service
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
        state.whisperProcessedSeconds = null
        state.whisperTotalSeconds = event.totalDurationSeconds
        state.whisperPartIndex = null
        state.whisperParts = event.parts
        state.startedAtMs = Date.now()
        stopTicker()
        startTicker(renderWhisperLine)
        updateSpinner(renderWhisperLine(), { force: true })
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
        return
      }

      if (event.kind === 'transcript-done') {
        stopTicker()
        updateSpinner(event.ok ? 'Transcribed…' : 'Transcript failed; fallback…', { force: true })
      }
    },
  }
}
