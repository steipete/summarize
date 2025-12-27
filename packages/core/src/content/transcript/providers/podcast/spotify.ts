import { BLOCKED_HTML_HINT_PATTERN, TRANSCRIPTION_TIMEOUT_MS } from './constants.js'
import { getJsonNumber, getJsonPath, getJsonString } from './json.js'

export function extractSpotifyEpisodeId(url: string): string | null {
  try {
    const parsed = new URL(url)
    const host = parsed.hostname.toLowerCase()
    if (!host.endsWith('spotify.com')) return null

    const parts = parsed.pathname.split('/').filter(Boolean)
    const idx = parts.indexOf('episode')
    const id = idx >= 0 ? parts[idx + 1] : null
    return id && /^[A-Za-z0-9]+$/.test(id) ? id : null
  } catch {
    return null
  }
}

export function extractSpotifyEmbedData(html: string): {
  showTitle: string
  episodeTitle: string
  durationSeconds: number | null
  drmFormat: string | null
  audioUrl: string | null
} | null {
  const match = html.match(/<script[^>]*id=["']__NEXT_DATA__["'][^>]*>([\s\S]*?)<\/script>/i)
  if (!match?.[1]) return null
  try {
    const json = JSON.parse(match[1]) as unknown
    const showTitle = (
      getJsonString(json, ['props', 'pageProps', 'state', 'data', 'entity', 'subtitle']) ?? ''
    ).trim()
    const episodeTitle = (
      getJsonString(json, ['props', 'pageProps', 'state', 'data', 'entity', 'title']) ?? ''
    ).trim()
    const durationMs = getJsonNumber(json, [
      'props',
      'pageProps',
      'state',
      'data',
      'entity',
      'duration',
    ])
    const drmFormat =
      getJsonString(json, [
        'props',
        'pageProps',
        'state',
        'data',
        'defaultAudioFileObject',
        'format',
      ]) ?? null
    const audioUrl = pickSpotifyEmbedAudioUrl(
      getJsonPath(json, ['props', 'pageProps', 'state', 'data', 'defaultAudioFileObject', 'url'])
    )
    if (!showTitle || !episodeTitle) return null
    return {
      showTitle,
      episodeTitle,
      durationSeconds:
        typeof durationMs === 'number' && Number.isFinite(durationMs) ? durationMs / 1000 : null,
      drmFormat,
      audioUrl,
    }
  } catch {
    return null
  }
}

export async function fetchSpotifyEmbedHtml({
  embedUrl,
  episodeId,
  fetchImpl,
  scrapeWithFirecrawl,
}: {
  embedUrl: string
  episodeId: string
  fetchImpl: typeof fetch
  scrapeWithFirecrawl:
    | ((
        url: string,
        options?: { cacheMode?: 'default' | 'bypass'; timeoutMs?: number }
      ) => Promise<{ html?: string | null; markdown: string } | null>)
    | null
}): Promise<{ html: string; via: 'fetch' | 'firecrawl' }> {
  try {
    // Try plain fetch first: fast, cheap, and often works with a realistic UA + referer.
    const embedResponse = await fetchImpl(embedUrl, {
      signal: AbortSignal.timeout(TRANSCRIPTION_TIMEOUT_MS),
      headers: {
        accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'accept-language': 'en-US,en;q=0.9',
        referer: `https://open.spotify.com/episode/${episodeId}`,
        'user-agent':
          'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36',
      },
    })
    if (!embedResponse.ok) {
      throw new Error(`Spotify embed fetch failed (${embedResponse.status})`)
    }
    const embedHtml = await embedResponse.text()
    if (!looksLikeBlockedHtml(embedHtml)) {
      return { html: embedHtml, via: 'fetch' }
    }
    throw new Error('Spotify embed HTML looked blocked (captcha)')
  } catch (error) {
    if (!scrapeWithFirecrawl) {
      throw error
    }

    // Firecrawl is optional and only used as a fallback when Spotify blocks direct fetches.
    const payload = await scrapeWithFirecrawl(embedUrl, {
      cacheMode: 'bypass',
      timeoutMs: TRANSCRIPTION_TIMEOUT_MS,
    })
    const text = (payload?.html ?? payload?.markdown ?? '').trim()
    if (!text) {
      throw new Error(
        `Spotify embed fetch failed and Firecrawl returned empty content (${error instanceof Error ? error.message : String(error)})`
      )
    }
    if (looksLikeBlockedHtml(text)) {
      throw new Error('Spotify embed blocked even via Firecrawl (captcha)')
    }
    return { html: text, via: 'firecrawl' }
  }
}

export function looksLikeBlockedHtml(html: string): boolean {
  const head = html.slice(0, 20000).toLowerCase()
  // Spotify embed pages include `__NEXT_DATA__` even when the rest of the HTML is minimal; treat that
  // as a strong "not blocked" signal to avoid unnecessary Firecrawl fallbacks.
  if (head.includes('__next_data__')) return false
  return BLOCKED_HTML_HINT_PATTERN.test(head)
}

function pickSpotifyEmbedAudioUrl(raw: unknown): string | null {
  const urls: string[] = Array.isArray(raw) ? raw.filter((v) => typeof v === 'string') : []
  const normalized = urls.map((u) => u.trim()).filter((u) => /^https?:\/\//i.test(u))
  if (normalized.length === 0) return null
  const scdn = normalized.find((u) => /scdn\.co/i.test(u))
  return scdn ?? normalized[0] ?? null
}
