import type { LinkPreviewProgressEvent } from '@steipete/summarize-core/content'
import { formatBytes, formatBytesPerSecond, formatElapsedMs } from '../format.js'
import type { OscProgressController } from '../osc-progress.js'

export function createFetchHtmlProgressRenderer({
  spinner,
  oscProgress,
}: {
  spinner: { setText: (text: string) => void }
  oscProgress?: OscProgressController | null
}): {
  stop: () => void
  onProgress: (event: LinkPreviewProgressEvent) => void
} {
  const state: {
    downloadedBytes: number
    totalBytes: number | null
    startedAtMs: number | null
    lastSpinnerUpdateAtMs: number
  } = {
    downloadedBytes: 0,
    totalBytes: null,
    startedAtMs: null,
    lastSpinnerUpdateAtMs: 0,
  }

  let ticker: ReturnType<typeof setInterval> | null = null

  const updateSpinner = (text: string, options?: { force?: boolean }) => {
    const now = Date.now()
    if (!options?.force && now - state.lastSpinnerUpdateAtMs < 100) return
    state.lastSpinnerUpdateAtMs = now
    spinner.setText(text)
  }

  const render = () => {
    const downloaded = formatBytes(state.downloadedBytes)
    const total =
      typeof state.totalBytes === 'number' &&
      state.totalBytes > 0 &&
      state.downloadedBytes <= state.totalBytes
        ? `/${formatBytes(state.totalBytes)}`
        : ''
    const elapsedMs = typeof state.startedAtMs === 'number' ? Date.now() - state.startedAtMs : 0
    const elapsed = formatElapsedMs(elapsedMs)
    if (state.downloadedBytes === 0 && !state.totalBytes) {
      return `Fetching website (connecting, ${elapsed})…`
    }
    const rate =
      elapsedMs > 0 && state.downloadedBytes > 0
        ? `, ${formatBytesPerSecond(state.downloadedBytes / (elapsedMs / 1000))}`
        : ''
    return `Fetching website (${downloaded}${total}, ${elapsed}${rate})…`
  }

  const startTicker = () => {
    if (ticker) return
    ticker = setInterval(() => updateSpinner(render()), 1000)
  }

  const stopTicker = () => {
    if (!ticker) return
    clearInterval(ticker)
    ticker = null
  }

  const freeze = () => {
    stopTicker()
    oscProgress?.clear()
    updateSpinner(render(), { force: true })
  }

  return {
    stop: stopTicker,
    onProgress: (event) => {
      if (event.kind === 'fetch-html-start') {
        state.downloadedBytes = 0
        state.totalBytes = null
        state.startedAtMs = Date.now()
        startTicker()
        updateSpinner('Fetching website (connecting)…')
        oscProgress?.setIndeterminate('Fetching website')
        return
      }

      if (event.kind === 'fetch-html-progress') {
        state.downloadedBytes = event.downloadedBytes
        state.totalBytes = event.totalBytes
        updateSpinner(render())
        if (typeof state.totalBytes === 'number' && state.totalBytes > 0) {
          oscProgress?.setPercent(
            'Fetching website',
            (state.downloadedBytes / state.totalBytes) * 100
          )
        } else {
          oscProgress?.setIndeterminate('Fetching website')
        }
        return
      }

      if (event.kind === 'fetch-html-done') {
        state.downloadedBytes = event.downloadedBytes
        state.totalBytes = event.totalBytes
        freeze()
      }
    },
  }
}
