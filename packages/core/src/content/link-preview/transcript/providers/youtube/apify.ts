import { fetchWithTimeout } from '../../../fetch-with-timeout.js'
import { isRecord } from '../../utils.js'

const PINTO_YOUTUBE_TRANSCRIPT_SCRAPER_ACTOR = 'faVsWy9VTSNVIhWpR'

type ApifyTranscriptItem = Record<string, unknown> & {
  data?: unknown
}

function normalizePintoTranscript(raw: unknown): string | null {
  if (!isRecord(raw)) return null
  const data = raw.data
  if (!Array.isArray(data)) return null
  const lines: string[] = []
  for (const item of data) {
    if (!isRecord(item)) continue
    const text = typeof item.text === 'string' ? item.text.trim() : ''
    if (text) lines.push(text)
  }
  return lines.length > 0 ? lines.join('\n') : null
}

export const fetchTranscriptWithApify = async (
  fetchImpl: typeof fetch,
  apifyApiToken: string | null,
  url: string
): Promise<string | null> => {
  if (!apifyApiToken) {
    return null
  }

  try {
    const response = await fetchWithTimeout(
      fetchImpl,
      `https://api.apify.com/v2/acts/${PINTO_YOUTUBE_TRANSCRIPT_SCRAPER_ACTOR}/run-sync-get-dataset-items?token=${apifyApiToken}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          videoUrl: url,
        }),
      },
      45_000
    )

    if (!response.ok) {
      return null
    }

    const payload = await response.json()
    if (!Array.isArray(payload)) {
      return null
    }

    for (const item of payload) {
      if (!isRecord(item)) {
        continue
      }
      const recordItem = item as ApifyTranscriptItem
      const normalized = normalizePintoTranscript(recordItem)
      if (normalized) {
        return normalized
      }
    }

    return null
  } catch {
    return null
  }
}
