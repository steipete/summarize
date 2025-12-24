import type { LinkPreviewProgressEvent } from '../content/link-preview/deps.js'

import { formatBytes } from './format.js'
import { createFetchHtmlProgressRenderer } from './progress/fetch-html.js'
import { createTranscriptProgressRenderer } from './progress/transcript.js'

export function createWebsiteProgress({
  enabled,
  spinner,
}: {
  enabled: boolean
  spinner: { setText: (text: string) => void }
}): {
  stop: () => void
  onProgress: (event: LinkPreviewProgressEvent) => void
} | null {
  if (!enabled) return null

  const fetchRenderer = createFetchHtmlProgressRenderer({ spinner })
  const transcriptRenderer = createTranscriptProgressRenderer({ spinner })

  const stopAll = () => {
    fetchRenderer.stop()
    transcriptRenderer.stop()
  }

  const formatFirecrawlReason = (reason: string) => {
    const lower = reason.toLowerCase()
    if (lower.includes('forced')) return 'forced'
    if (lower.includes('html fetch failed')) return 'fallback: HTML fetch failed'
    if (lower.includes('blocked') || lower.includes('thin')) return 'fallback: blocked/thin HTML'
    return reason
  }

  return {
    stop: stopAll,
    onProgress: (event) => {
      fetchRenderer.onProgress(event)
      transcriptRenderer.onProgress(event)

      if (event.kind === 'bird-start') {
        stopAll()
        spinner.setText('Bird: reading tweet…')
        return
      }

      if (event.kind === 'bird-done') {
        stopAll()
        if (event.ok && typeof event.textBytes === 'number') {
          spinner.setText(`Bird: got ${formatBytes(event.textBytes)}…`)
          return
        }
        spinner.setText('Bird: failed; fallback…')
        return
      }

      if (event.kind === 'nitter-start') {
        stopAll()
        spinner.setText('Nitter: fetching…')
        return
      }

      if (event.kind === 'nitter-done') {
        stopAll()
        if (event.ok && typeof event.textBytes === 'number') {
          spinner.setText(`Nitter: got ${formatBytes(event.textBytes)}…`)
          return
        }
        spinner.setText('Nitter: failed; fallback…')
        return
      }

      if (event.kind === 'firecrawl-start') {
        stopAll()
        const reason = event.reason ? formatFirecrawlReason(event.reason) : ''
        const suffix = reason ? ` (${reason})` : ''
        spinner.setText(`Firecrawl: scraping${suffix}…`)
        return
      }

      if (event.kind === 'firecrawl-done') {
        stopAll()
        if (event.ok && typeof event.markdownBytes === 'number') {
          spinner.setText(`Firecrawl: got ${formatBytes(event.markdownBytes)}…`)
          return
        }
        spinner.setText('Firecrawl: no content; fallback…')
        return
      }

      if (event.kind === 'transcript-start') {
        stopAll()
        const hint = event.hint ? ` (${event.hint})` : ''
        spinner.setText(`Transcribing${hint}…`)
      }
    },
  }
}

