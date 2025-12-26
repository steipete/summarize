import { load } from 'cheerio'

import { normalizeCandidate } from './cleaner.js'

export type JsonLdContent = {
  title: string | null
  description: string | null
  type: string | null
}

export function extractJsonLdContent(html: string): JsonLdContent | null {
  try {
    const $ = load(html)
    const scripts = $('script[type="application/ld+json"]').toArray()
    const candidates: JsonLdContent[] = []

    for (const script of scripts) {
      const raw = $(script).text()
      if (!raw) continue
      try {
        const data = JSON.parse(raw)
        collectCandidates(data, candidates)
      } catch {
        // ignore malformed jsonld
      }
    }

    if (candidates.length === 0) return null

    const sorted = candidates
      .map((c) => ({
        title: c.title ? normalizeCandidate(c.title) : null,
        description: c.description ? normalizeCandidate(c.description) : null,
        type: c.type ? normalizeCandidate(c.type) : null,
      }))
      .filter((c) => c.title || c.description)
      .sort((a, b) => (b.description?.length ?? 0) - (a.description?.length ?? 0))

    return sorted[0] ?? null
  } catch {
    return null
  }
}

function collectCandidates(input: unknown, out: JsonLdContent[]) {
  if (!input) return

  if (Array.isArray(input)) {
    for (const item of input) collectCandidates(item, out)
    return
  }

  if (typeof input !== 'object') return

  const record = input as Record<string, unknown>
  if (record['@graph'] && Array.isArray(record['@graph'])) {
    collectCandidates(record['@graph'], out)
  }

  const type = extractType(record)
  if (type) {
    const title = firstString(record, ['name', 'headline', 'title'])
    const description = firstString(record, ['description', 'summary'])
    if (title || description) {
      out.push({ title: title ?? null, description: description ?? null, type })
    }
  }
}

function extractType(record: Record<string, unknown>): string | null {
  const raw = record['@type']
  if (typeof raw === 'string') return raw.toLowerCase()
  if (Array.isArray(raw)) {
    const found = raw.find((entry) => typeof entry === 'string')
    return typeof found === 'string' ? found.toLowerCase() : null
  }
  return null
}

function firstString(record: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const value = record[key]
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return null
}
