import { TRANSCRIPTION_TIMEOUT_MS } from './constants.js'

export function looksLikeRssOrAtomFeed(xml: string): boolean {
  const head = xml.slice(0, 4096).trimStart().toLowerCase()
  if (head.startsWith('<rss') || head.includes('<rss')) return true
  if (head.startsWith('<?xml') && (head.includes('<rss') || head.includes('<feed'))) return true
  if (head.startsWith('<feed') || head.includes('<feed')) return true
  return false
}

export function extractEnclosureFromFeed(
  xml: string
): { enclosureUrl: string; durationSeconds: number | null } | null {
  const items = xml.match(/<item\b[\s\S]*?<\/item>/gi) ?? []
  for (const item of items) {
    const enclosureUrl = extractEnclosureUrlFromItem(item)
    if (!enclosureUrl) continue
    return { enclosureUrl, durationSeconds: extractItemDurationSeconds(item) }
  }

  const enclosureMatch = xml.match(/<enclosure\b[^>]*\burl\s*=\s*(['"])([^'"]+)\1/i)
  if (enclosureMatch?.[2]) {
    return { enclosureUrl: enclosureMatch[2], durationSeconds: extractItemDurationSeconds(xml) }
  }

  const atomMatch = xml.match(
    /<link\b[^>]*\brel\s*=\s*(['"])enclosure\1[^>]*\bhref\s*=\s*(['"])([^'"]+)\2/i
  )
  if (atomMatch?.[3]) {
    return { enclosureUrl: atomMatch[3], durationSeconds: extractItemDurationSeconds(xml) }
  }

  return null
}

export function extractEnclosureForEpisode(
  feedXml: string,
  episodeTitle: string
): { enclosureUrl: string; durationSeconds: number | null } | null {
  const normalizedTarget = normalizeLooseTitle(episodeTitle)
  const items = feedXml.match(/<item\b[\s\S]*?<\/item>/gi) ?? []
  for (const item of items) {
    const title = extractItemTitle(item)
    if (!title) continue
    if (normalizeLooseTitle(title) !== normalizedTarget) continue
    const enclosureUrl = extractEnclosureUrlFromItem(item)
    if (!enclosureUrl) continue
    return { enclosureUrl, durationSeconds: extractItemDurationSeconds(item) }
  }
  return null
}

export function extractItemDurationSeconds(itemXml: string): number | null {
  const match = itemXml.match(/<itunes:duration>([\s\S]*?)<\/itunes:duration>/i)
  if (!match?.[1]) return null
  const raw = match[1]
    .replaceAll(/<!\[CDATA\[/gi, '')
    .replaceAll(/\]\]>/g, '')
    .trim()
  if (!raw) return null

  // common forms: "HH:MM:SS", "MM:SS", "SS"
  if (/^\d+$/.test(raw)) {
    const seconds = Number(raw)
    return Number.isFinite(seconds) && seconds > 0 ? seconds : null
  }

  const parts = raw
    .split(':')
    .map((value) => value.trim())
    .filter(Boolean)
  if (parts.length < 2 || parts.length > 3) return null
  const nums = parts.map((value) => Number(value))
  if (nums.some((n) => !Number.isFinite(n) || n < 0)) return null
  const seconds = (() => {
    if (nums.length === 3) {
      const [hours, minutes, secondsRaw] = nums
      if (hours === undefined || minutes === undefined || secondsRaw === undefined) return null
      return Math.round(hours * 3600 + minutes * 60 + secondsRaw)
    }
    const [minutes, secondsRaw] = nums
    if (minutes === undefined || secondsRaw === undefined) return null
    return Math.round(minutes * 60 + secondsRaw)
  })()
  if (seconds === null) return null
  return seconds > 0 ? seconds : null
}

export function decodeXmlEntities(value: string): string {
  return value
    .replaceAll(/&amp;/gi, '&')
    .replaceAll(/&#38;/g, '&')
    .replaceAll(/&lt;/gi, '<')
    .replaceAll(/&gt;/gi, '>')
    .replaceAll(/&quot;/gi, '"')
    .replaceAll(/&apos;/gi, "'")
}

export function normalizeLooseTitle(value: string): string {
  return value
    .toLowerCase()
    .normalize('NFKD')
    .replaceAll(/\p{Diacritic}+/gu, '')
    .replaceAll(/[^a-z0-9]+/g, ' ')
    .trim()
}

export async function tryFetchTranscriptFromFeedXml({
  fetchImpl,
  feedXml,
  episodeTitle,
  notes,
}: {
  fetchImpl: typeof fetch
  feedXml: string
  episodeTitle: string | null
  notes: string[]
}): Promise<{ text: string; transcriptUrl: string; transcriptType: string | null } | null> {
  const items = feedXml.match(/<item\b[\s\S]*?<\/item>/gi) ?? []
  const normalizedTarget = episodeTitle ? normalizeLooseTitle(episodeTitle) : null

  for (const item of items) {
    if (normalizedTarget) {
      const title = extractItemTitle(item)
      if (!title || normalizeLooseTitle(title) !== normalizedTarget) continue
    }

    const candidates = extractPodcastTranscriptCandidatesFromItem(item)
    const preferred = selectPreferredTranscriptCandidate(candidates)
    if (!preferred) {
      if (normalizedTarget) return null
      continue
    }

    const transcriptUrl = decodeXmlEntities(preferred.url)
    try {
      const res = await fetchImpl(transcriptUrl, {
        redirect: 'follow',
        signal: AbortSignal.timeout(TRANSCRIPTION_TIMEOUT_MS),
        headers: { accept: 'text/vtt,text/plain,application/json;q=0.9,*/*;q=0.8' },
      })
      if (!res.ok) throw new Error(`transcript fetch failed (${res.status})`)

      const contentType =
        res.headers.get('content-type')?.toLowerCase().split(';')[0]?.trim() ?? null
      const hintedType = preferred.type?.toLowerCase().split(';')[0]?.trim() ?? null
      const effectiveType = hintedType ?? contentType

      const body = await res.text()
      const text = (() => {
        if (effectiveType === 'application/json' || transcriptUrl.toLowerCase().endsWith('.json')) {
          try {
            return jsonTranscriptToPlainText(JSON.parse(body))
          } catch {
            return null
          }
        }
        if (effectiveType === 'text/vtt' || transcriptUrl.toLowerCase().endsWith('.vtt')) {
          const plain = vttToPlainText(body)
          return plain.length > 0 ? plain : null
        }
        const plain = body.trim()
        return plain.length > 0 ? plain : null
      })()

      if (!text) {
        if (normalizedTarget) return null
        continue
      }

      notes.push('Used RSS <podcast:transcript> (skipped Whisper)')
      return { text, transcriptUrl, transcriptType: effectiveType }
    } catch (error) {
      if (normalizedTarget) {
        notes.push(
          `RSS <podcast:transcript> fetch failed: ${error instanceof Error ? error.message : String(error)}`
        )
        return null
      }
    }
  }

  return null
}

function extractEnclosureUrlFromItem(xml: string): string | null {
  const enclosureMatch = xml.match(/<enclosure\b[^>]*\burl\s*=\s*(['"])([^'"]+)\1/i)
  if (enclosureMatch?.[2]) return enclosureMatch[2]

  const atomMatch = xml.match(
    /<link\b[^>]*\brel\s*=\s*(['"])enclosure\1[^>]*\bhref\s*=\s*(['"])([^'"]+)\2/i
  )
  if (atomMatch?.[3]) return atomMatch[3]

  return null
}

function extractItemTitle(itemXml: string): string | null {
  const match = itemXml.match(/<title>([\s\S]*?)<\/title>/i)
  if (!match?.[1]) return null
  const raw = match[1]
    .replaceAll(/<!\[CDATA\[/gi, '')
    .replaceAll(/\]\]>/g, '')
    .trim()
  return raw.length > 0 ? raw : null
}

function extractPodcastTranscriptCandidatesFromItem(
  itemXml: string
): Array<{ url: string; type: string | null }> {
  const matches = itemXml.matchAll(/<podcast:transcript\b[^>]*\burl\s*=\s*(['"])([^'"]+)\1[^>]*>/gi)
  const results: Array<{ url: string; type: string | null }> = []
  for (const match of matches) {
    const tag = match[0]
    const url = match[2]?.trim()
    if (!url) continue
    const type = tag.match(/\btype\s*=\s*(['"])([^'"]+)\1/i)?.[2]?.trim() ?? null
    results.push({ url, type })
  }
  return results
}

function selectPreferredTranscriptCandidate(
  candidates: Array<{ url: string; type: string | null }>
): { url: string; type: string | null } | null {
  if (candidates.length === 0) return null
  const normalized = candidates.map((c) => ({
    ...c,
    type: c.type?.toLowerCase().split(';')[0]?.trim() ?? null,
  }))

  const json = normalized.find(
    (c) => c.type === 'application/json' || c.url.toLowerCase().endsWith('.json')
  )
  if (json) return json

  const vtt = normalized.find((c) => c.type === 'text/vtt' || c.url.toLowerCase().endsWith('.vtt'))
  if (vtt) return vtt

  return normalized[0] ?? null
}

function vttToPlainText(raw: string): string {
  const lines = raw
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .filter((line) => line.toUpperCase() !== 'WEBVTT')
    .filter((line) => !/^\d{2}:\d{2}:\d{2}\.\d{3}\s+-->\s+\d{2}:\d{2}:\d{2}\.\d{3}/.test(line))
    .filter((line) => !/^\d+$/.test(line))
    .filter((line) => !/^(NOTE|STYLE|REGION)\b/i.test(line))
  return lines.join('\n').trim()
}

function jsonTranscriptToPlainText(payload: unknown): string | null {
  if (Array.isArray(payload)) {
    const parts = payload
      .map((row) => (row && typeof row === 'object' ? (row as Record<string, unknown>).text : null))
      .filter((t): t is string => typeof t === 'string')
      .map((t) => t.trim())
      .filter(Boolean)
    const text = parts.join('\n').trim()
    return text.length > 0 ? text : null
  }

  if (payload && typeof payload === 'object') {
    const record = payload as Record<string, unknown>
    if (typeof record.transcript === 'string' && record.transcript.trim())
      return record.transcript.trim()
    if (typeof record.text === 'string' && record.text.trim()) return record.text.trim()
    const segments = record.segments
    if (Array.isArray(segments)) {
      const parts = segments
        .map((row) =>
          row && typeof row === 'object' ? (row as Record<string, unknown>).text : null
        )
        .filter((t): t is string => typeof t === 'string')
        .map((t) => t.trim())
        .filter(Boolean)
      const text = parts.join('\n').trim()
      return text.length > 0 ? text : null
    }
  }

  return null
}
