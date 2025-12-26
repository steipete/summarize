import { type CheerioAPI, load } from 'cheerio'

import { decodeHtmlEntities, normalizeCandidate } from './cleaner.js'
import { pickFirstText, safeHostname } from './utils.js'

const ALLOWED_TEXT_TAGS = new Set(['title'])

interface MetaSelector {
  attribute: 'property' | 'name'
  value: string
}

export interface ParsedMetadata {
  title: string | null
  description: string | null
  siteName: string | null
}

export function extractMetadataFromHtml(html: string, url: string): ParsedMetadata {
  const $ = load(html)

  const title = pickFirstText([
    pickMetaContent($, [
      { attribute: 'property', value: 'og:title' },
      { attribute: 'name', value: 'og:title' },
      { attribute: 'name', value: 'twitter:title' },
    ]),
    extractTagText($, 'title'),
  ])

  const description = pickFirstText([
    pickMetaContent($, [
      { attribute: 'property', value: 'og:description' },
      { attribute: 'name', value: 'description' },
      { attribute: 'name', value: 'twitter:description' },
    ]),
  ])

  const siteName = pickFirstText([
    pickMetaContent($, [
      { attribute: 'property', value: 'og:site_name' },
      { attribute: 'name', value: 'application-name' },
    ]),
    safeHostname(url),
  ])

  return { title, description, siteName }
}

export function extractMetadataFromFirecrawl(
  metadata: Record<string, unknown> | null | undefined
): ParsedMetadata {
  return {
    title: pickFirstText([metadataString(metadata, 'title'), metadataString(metadata, 'ogTitle')]),
    description: pickFirstText([
      metadataString(metadata, 'description'),
      metadataString(metadata, 'ogDescription'),
    ]),
    siteName: pickFirstText([
      metadataString(metadata, 'siteName'),
      metadataString(metadata, 'ogSiteName'),
    ]),
  }
}

function pickMetaContent($: CheerioAPI, selectors: MetaSelector[]): string | null {
  for (const selector of selectors) {
    const meta = $(`meta[${selector.attribute}="${selector.value}"]`).first()
    if (meta.length === 0) {
      continue
    }
    const value = meta.attr('content') ?? meta.attr('value') ?? ''
    const normalized = normalizeCandidate(decodeHtmlEntities(value))
    if (normalized) {
      return normalized
    }
  }
  return null
}

function extractTagText($: CheerioAPI, tagName: string): string | null {
  const normalizedTag = tagName.trim().toLowerCase()
  if (!ALLOWED_TEXT_TAGS.has(normalizedTag)) {
    return null
  }
  const element = $(normalizedTag).first()
  if (element.length === 0) {
    return null
  }
  const text = decodeHtmlEntities(element.text())
  return normalizeCandidate(text)
}

function metadataString(
  metadata: Record<string, unknown> | null | undefined,
  key: string
): string | null {
  if (!metadata) {
    return null
  }
  const value = metadata[key]
  return typeof value === 'string' ? normalizeCandidate(value) : null
}
