import { compact } from 'es-toolkit'

const WORD_SPLIT_PATTERN = /\s+/g

export interface ContentBudgetResult {
  content: string
  truncated: boolean
  totalCharacters: number
  wordCount: number
}

export function normalizeForPrompt(input: string): string {
  return input
    .replaceAll('\u00A0', ' ')
    .replaceAll(/[\t ]+/g, ' ')
    .replaceAll(/\s*\n\s*/g, '\n')
    .replaceAll(/\n{3,}/g, '\n\n')
    .trim()
}

export function normalizeWhitespace(input: string): string {
  return input
    .replaceAll('\u00A0', ' ')
    .replaceAll(/[\t ]+/g, ' ')
    .replaceAll(/\s*\n\s*/g, '\n')
    .trim()
}

export function decodeHtmlEntities(input: string): string {
  return input
    .replaceAll('&amp;', '&')
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replaceAll('&#39;', "'")
    .replaceAll('&#x27;', "'")
    .replaceAll('&#x2F;', '/')
    .replaceAll('&nbsp;', ' ')
}

export function normalizeCandidate(value: string | null | undefined): string | null {
  if (!value) {
    return null
  }
  const trimmed = value.replaceAll(/\s+/g, ' ').trim()
  return trimmed.length > 0 ? trimmed : null
}

export function clipAtSentenceBoundary(input: string, maxLength: number): string {
  if (input.length <= maxLength) {
    return input
  }
  const slice = input.slice(0, maxLength)
  const lastSentenceBreak = Math.max(
    slice.lastIndexOf('. '),
    slice.lastIndexOf('! '),
    slice.lastIndexOf('? '),
    slice.lastIndexOf('\n\n')
  )
  if (lastSentenceBreak > maxLength * 0.5) {
    return slice.slice(0, lastSentenceBreak + 1)
  }
  return slice
}

export function applyContentBudget(
  baseContent: string,
  maxCharacters: number
): ContentBudgetResult {
  const totalCharacters = baseContent.length
  const truncated = totalCharacters > maxCharacters
  const clipped = truncated ? clipAtSentenceBoundary(baseContent, maxCharacters) : baseContent
  const content = clipped.trim()
  const wordCount = content.length > 0 ? compact(content.split(WORD_SPLIT_PATTERN)).length : 0
  return { content, truncated, totalCharacters, wordCount }
}
