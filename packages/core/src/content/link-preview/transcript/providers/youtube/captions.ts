import { fetchWithTimeout } from '../../../fetch-with-timeout.js'
import { decodeHtmlEntities, sanitizeYoutubeJsonResponse } from '../../utils.js'
import { extractYoutubeiBootstrap } from './api.js'

interface YoutubeTranscriptContext {
  html: string
  originalUrl: string
  videoId: string
}

const REQUEST_HEADERS: Record<string, string> = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
  'Accept-Language': 'en-US,en;q=0.9',
}

const YT_INITIAL_PLAYER_RESPONSE_TOKEN = 'ytInitialPlayerResponse'
const INNERTUBE_API_KEY_REGEX = /"INNERTUBE_API_KEY":"([^"]+)"|INNERTUBE_API_KEY\\":\\"([^\\"]+)\\"/

function extractBalancedJsonObject(source: string, startAt: number): string | null {
  const start = source.indexOf('{', startAt)
  if (start < 0) {
    return null
  }

  let depth = 0
  let inString = false
  let quote: '"' | "'" | null = null
  let escaping = false

  for (let i = start; i < source.length; i += 1) {
    const ch = source[i]
    if (!ch) {
      continue
    }

    if (inString) {
      if (escaping) {
        escaping = false
        continue
      }
      if (ch === '\\') {
        escaping = true
        continue
      }
      if (quote && ch === quote) {
        inString = false
        quote = null
      }
      continue
    }

    if (ch === '"' || ch === "'") {
      inString = true
      quote = ch
      continue
    }

    if (ch === '{') {
      depth += 1
      continue
    }
    if (ch === '}') {
      depth -= 1
      if (depth === 0) {
        return source.slice(start, i + 1)
      }
    }
  }

  return null
}

function extractInitialPlayerResponse(html: string): Record<string, unknown> | null {
  const tokenIndex = html.indexOf(YT_INITIAL_PLAYER_RESPONSE_TOKEN)
  if (tokenIndex < 0) {
    return null
  }
  const assignmentIndex = html.indexOf('=', tokenIndex)
  if (assignmentIndex < 0) {
    return null
  }
  const objectText = extractBalancedJsonObject(html, assignmentIndex)
  if (!objectText) {
    return null
  }

  try {
    const parsed: unknown = JSON.parse(objectText)
    return isObjectLike(parsed) ? parsed : null
  } catch {
    return null
  }
}

const isObjectLike = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null

function extractInnertubeApiKey(html: string): string | null {
  const match = html.match(INNERTUBE_API_KEY_REGEX)
  const key = match?.[1] ?? match?.[2] ?? null
  return typeof key === 'string' && key.trim().length > 0 ? key.trim() : null
}

type YoutubePlayerContext = Record<string, unknown> & { client?: unknown }
type CaptionsPayload = Record<string, unknown> & {
  captions?: unknown
  playerCaptionsTracklistRenderer?: unknown
}
type CaptionListRenderer = Record<string, unknown> & {
  captionTracks?: unknown
  automaticCaptions?: unknown
}
type CaptionTrackRecord = Record<string, unknown> & {
  languageCode?: unknown
  kind?: unknown
  baseUrl?: unknown
  url?: unknown
}
type CaptionEventRecord = Record<string, unknown> & { segs?: unknown }
type CaptionSegmentRecord = Record<string, unknown> & { utf8?: unknown }

async function fetchTranscriptViaAndroidPlayer(
  fetchImpl: typeof fetch,
  { html, videoId }: { html: string; videoId: string }
): Promise<string | null> {
  const apiKey = extractInnertubeApiKey(html)
  if (!apiKey) {
    return null
  }

  try {
    const userAgent =
      REQUEST_HEADERS['User-Agent'] ??
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36'

    const response = await fetchWithTimeout(
      fetchImpl,
      `https://www.youtube.com/youtubei/v1/player?key=${apiKey}`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': userAgent,
          'Accept-Language': REQUEST_HEADERS['Accept-Language'] ?? 'en-US,en;q=0.9',
          Accept: 'application/json',
        },
        body: JSON.stringify({
          context: {
            client: {
              clientName: 'ANDROID',
              clientVersion: '20.10.38',
            },
          },
          videoId,
        }),
      }
    )

    if (!response.ok) {
      return null
    }

    const parsed: unknown = await response.json()
    if (!isObjectLike(parsed)) {
      return null
    }

    return await extractTranscriptFromPlayerPayload(fetchImpl, parsed)
  } catch {
    return null
  }
}

export const fetchTranscriptFromCaptionTracks = async (
  fetchImpl: typeof fetch,
  { html, originalUrl, videoId }: YoutubeTranscriptContext
): Promise<string | null> => {
  const initialPlayerResponse = extractInitialPlayerResponse(html)
  if (initialPlayerResponse) {
    const transcript = await extractTranscriptFromPlayerPayload(fetchImpl, initialPlayerResponse)
    if (transcript) {
      return transcript
    }
  }

  const bootstrap = extractYoutubeiBootstrap(html)
  if (!bootstrap) {
    return await fetchTranscriptViaAndroidPlayer(fetchImpl, { html, videoId })
  }

  const { apiKey, clientName, clientVersion, context, pageCl, pageLabel, visitorData, xsrfToken } =
    bootstrap
  if (!apiKey) {
    return await fetchTranscriptViaAndroidPlayer(fetchImpl, { html, videoId })
  }

  const contextRecord = context as YoutubePlayerContext
  const clientContext = isObjectLike(contextRecord.client)
    ? (contextRecord.client as Record<string, unknown>)
    : {}
  const requestBody: Record<string, unknown> = {
    context: {
      ...contextRecord,
      client: {
        ...clientContext,
        originalUrl,
      },
    },
    videoId,
    playbackContext: {
      contentPlaybackContext: {
        html5Preference: 'HTML5_PREF_WANTS',
      },
    },
    contentCheckOk: true,
    racyCheckOk: true,
  }

  try {
    const userAgent =
      REQUEST_HEADERS['User-Agent'] ??
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36'
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'User-Agent': userAgent,
      Accept: 'application/json',
      Origin: 'https://www.youtube.com',
      Referer: originalUrl,
      'X-Goog-AuthUser': '0',
      'X-Youtube-Bootstrap-Logged-In': 'false',
    }

    if (clientName) {
      headers['X-Youtube-Client-Name'] = clientName
    }
    if (clientVersion) {
      headers['X-Youtube-Client-Version'] = clientVersion
    }
    if (visitorData) {
      headers['X-Goog-Visitor-Id'] = visitorData
    }
    if (typeof pageCl === 'number' && Number.isFinite(pageCl)) {
      headers['X-Youtube-Page-CL'] = String(pageCl)
    }
    if (pageLabel) {
      headers['X-Youtube-Page-Label'] = pageLabel
    }
    if (xsrfToken) {
      headers['X-Youtube-Identity-Token'] = xsrfToken
    }

    const response = await fetchWithTimeout(
      fetchImpl,
      `https://www.youtube.com/youtubei/v1/player?key=${apiKey}`,
      {
        method: 'POST',
        headers,
        body: JSON.stringify(requestBody),
      }
    )

    if (!response.ok) {
      return await fetchTranscriptViaAndroidPlayer(fetchImpl, { html, videoId })
    }

    const raw = await response.text()
    const sanitized = sanitizeYoutubeJsonResponse(raw)
    const parsed: unknown = JSON.parse(sanitized)
    if (!isObjectLike(parsed)) {
      return await fetchTranscriptViaAndroidPlayer(fetchImpl, { html, videoId })
    }

    const transcript = await extractTranscriptFromPlayerPayload(fetchImpl, parsed)
    if (transcript) {
      return transcript
    }

    return await fetchTranscriptViaAndroidPlayer(fetchImpl, { html, videoId })
  } catch {
    return await fetchTranscriptViaAndroidPlayer(fetchImpl, { html, videoId })
  }
}

const extractTranscriptFromPlayerPayload = async (
  fetchImpl: typeof fetch,
  payload: Record<string, unknown>
): Promise<string | null> => {
  const payloadRecord = payload as CaptionsPayload

  const captionsCandidate = payloadRecord.captions
  const captions = isObjectLike(captionsCandidate) ? (captionsCandidate as CaptionsPayload) : null

  const rendererCandidate =
    (captions ? (captions as CaptionsPayload).playerCaptionsTracklistRenderer : null) ??
    payloadRecord.playerCaptionsTracklistRenderer

  const renderer = isObjectLike(rendererCandidate)
    ? (rendererCandidate as CaptionListRenderer)
    : null
  const captionTracks = Array.isArray(renderer?.captionTracks)
    ? (renderer?.captionTracks as unknown[])
    : null
  const automaticTracks = Array.isArray(renderer?.automaticCaptions)
    ? (renderer?.automaticCaptions as unknown[])
    : null

  const orderedTracks: Record<string, unknown>[] = []
  if (captionTracks) {
    orderedTracks.push(
      ...captionTracks.filter((track): track is Record<string, unknown> => isObjectLike(track))
    )
  }
  if (automaticTracks) {
    orderedTracks.push(
      ...automaticTracks.filter((track): track is Record<string, unknown> => isObjectLike(track))
    )
  }
  const filteredTracks = orderedTracks.filter((track): track is Record<string, unknown> =>
    isObjectLike(track)
  )

  const sortedTracks = [...filteredTracks].toSorted((a, b) => {
    const aTrack = a as CaptionTrackRecord
    const bTrack = b as CaptionTrackRecord
    const aKind = typeof aTrack.kind === 'string' ? aTrack.kind : ''
    const bKind = typeof bTrack.kind === 'string' ? bTrack.kind : ''
    // Prefer manual captions over auto-generated (ASR).
    if (aKind === 'asr' && bKind !== 'asr') {
      return 1
    }
    if (bKind === 'asr' && aKind !== 'asr') {
      return -1
    }
    const aLang = typeof aTrack.languageCode === 'string' ? aTrack.languageCode : ''
    const bLang = typeof bTrack.languageCode === 'string' ? bTrack.languageCode : ''
    if (aLang === 'en' && bLang !== 'en') {
      return -1
    }
    if (bLang === 'en' && aLang !== 'en') {
      return 1
    }
    return 0
  })

  // De-dupe after sorting so manual/English wins within each language.
  const seenLanguages = new Set<string>()
  const normalizedTracks: Record<string, unknown>[] = []
  for (const candidate of sortedTracks) {
    const trackRecord = candidate as CaptionTrackRecord
    const languageCandidate = trackRecord.languageCode
    const lang = typeof languageCandidate === 'string' ? languageCandidate.toLowerCase() : ''
    if (lang && seenLanguages.has(lang)) {
      continue
    }
    if (lang) {
      seenLanguages.add(lang)
    }
    normalizedTracks.push(candidate)
  }

  return await findFirstTranscript(fetchImpl, normalizedTracks, 0)
}

const findFirstTranscript = async (
  fetchImpl: typeof fetch,
  tracks: readonly Record<string, unknown>[],
  index: number
): Promise<string | null> => {
  if (index >= tracks.length) {
    return null
  }
  const candidate = await downloadCaptionTrack(fetchImpl, tracks[index] ?? {})
  if (candidate) {
    return candidate
  }
  return findFirstTranscript(fetchImpl, tracks, index + 1)
}

const downloadCaptionTrack = async (
  fetchImpl: typeof fetch,
  track: Record<string, unknown>
): Promise<string | null> => {
  const trackRecord = track as CaptionTrackRecord
  const baseUrl =
    typeof trackRecord.baseUrl === 'string'
      ? trackRecord.baseUrl
      : typeof trackRecord.url === 'string'
        ? trackRecord.url
        : null
  if (!baseUrl) {
    return null
  }

  const json3Url = (() => {
    try {
      const parsed = new URL(baseUrl)
      parsed.searchParams.set('fmt', 'json3')
      parsed.searchParams.set('alt', 'json')
      return parsed.toString()
    } catch {
      const separator = baseUrl.includes('?') ? '&' : '?'
      return `${baseUrl}${separator}fmt=json3&alt=json`
    }
  })()

  try {
    const response = await fetchWithTimeout(fetchImpl, json3Url, {
      headers: REQUEST_HEADERS,
    })
    if (!response.ok) {
      return await downloadXmlTranscript(fetchImpl, baseUrl)
    }

    const text = await response.text()
    if (text.length === 0) {
      return await downloadXmlTranscript(fetchImpl, baseUrl)
    }
    const jsonResult = parseJsonTranscript(text)
    if (jsonResult) {
      return jsonResult
    }
    const xmlFallback = parseXmlTranscript(text)
    if (xmlFallback) {
      return xmlFallback
    }
    return await downloadXmlTranscript(fetchImpl, baseUrl)
  } catch {
    return await downloadXmlTranscript(fetchImpl, baseUrl)
  }
}

const downloadXmlTranscript = async (
  fetchImpl: typeof fetch,
  baseUrl: string
): Promise<string | null> => {
  const xmlUrl = baseUrl.replaceAll(/&fmt=[^&]+/g, '')
  try {
    const response = await fetchWithTimeout(fetchImpl, xmlUrl, { headers: REQUEST_HEADERS })
    if (!response.ok) {
      return null
    }
    const text = await response.text()
    const jsonResult = parseJsonTranscript(text)
    if (jsonResult) {
      return jsonResult
    }
    return parseXmlTranscript(text)
  } catch {
    return null
  }
}

type CaptionPayload = { events?: unknown }

const parseJsonTranscript = (raw: string): string | null => {
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!isObjectLike(parsed)) {
      return null
    }
    const payloadRecord = parsed as CaptionPayload
    const eventsUnknown = payloadRecord.events
    if (!Array.isArray(eventsUnknown)) {
      return null
    }
    const events = eventsUnknown
    const lines: string[] = []
    for (const event of events) {
      if (!isObjectLike(event)) {
        continue
      }
      const eventRecord = event as CaptionEventRecord
      const segs = Array.isArray(eventRecord.segs) ? (eventRecord.segs as unknown[]) : null
      if (!segs) {
        continue
      }
      const text = segs
        .map((seg) => {
          if (!isObjectLike(seg)) {
            return ''
          }
          const segRecord = seg as CaptionSegmentRecord
          return typeof segRecord.utf8 === 'string' ? segRecord.utf8 : ''
        })
        .join('')
        .trim()
      if (text.length > 0) {
        lines.push(text)
      }
    }
    const transcript = lines.join('\n').trim()
    return transcript.length > 0 ? transcript : null
  } catch {
    return null
  }
}

const parseXmlTranscript = (xml: string): string | null => {
  const pattern = /<text[^>]*>([\s\S]*?)<\/text>/gi
  const lines: string[] = []
  let match: RegExpExecArray | null = pattern.exec(xml)
  while (match) {
    const content = match[1] ?? ''
    const decoded = decodeHtmlEntities(content).replaceAll(/\s+/g, ' ').trim()
    if (decoded.length > 0) {
      lines.push(decoded)
    }
    match = pattern.exec(xml)
  }
  const transcript = lines.join('\n').trim()
  return transcript.length > 0 ? transcript : null
}
