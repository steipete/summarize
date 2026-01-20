import { extractYouTubeVideoId } from '../../../content/index.js'
import type { SummaryLength } from '../../../shared/contracts.js'

export type TranscriptSegment = { startSeconds: number; text: string }
export type SlideTimelineEntry = { index: number; timestamp: number }

const SLIDE_TEXT_BUDGET_BY_PRESET: Record<SummaryLength, number> = {
  short: 120,
  medium: 200,
  long: 320,
  xl: 480,
  xxl: 700,
}

const SLIDE_TEXT_BUDGET_MIN = 80
const SLIDE_TEXT_BUDGET_MAX = 900

const SLIDE_WINDOW_SECONDS_BY_PRESET: Record<SummaryLength, number> = {
  short: 30,
  medium: 60,
  long: 90,
  xl: 120,
  xxl: 180,
}

const SLIDE_WINDOW_SECONDS_MIN = 30
const SLIDE_WINDOW_SECONDS_MAX = 180

const SLIDE_TAG_PATTERN = /^\[[^\]]*slide[^\d\]]*(\d+)[^\]]*\]\s*(.*)$/i
const SLIDE_LABEL_PATTERN = /^(?:\[)?slide\s+(\d+)(?:\])?(?:\s*[\u00b7:-]\s*.*)?$/i

const clampNumber = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value))

const collapseLineWhitespace = (value: string): string => value.replace(/\s+/g, ' ').trim()

const looksLikeTitleLine = (line: string): boolean => {
  const trimmed = collapseLineWhitespace(line)
  if (!trimmed) return false
  if (trimmed.length > 80) return false
  if (/^[\[\-\u2022*]/.test(trimmed)) return false
  if (/^slide\s+\d+/i.test(trimmed)) return false
  if (/^title\s*:/i.test(trimmed)) return false
  if (/[.!?]\s*$/.test(trimmed)) return false
  const words = trimmed.split(/\s+/).filter(Boolean)
  if (words.length > 12) return false
  return true
}

const hasSlideLabel = (line: string, index: number, count: number): boolean => {
  const normalized = collapseLineWhitespace(line).toLowerCase()
  if (!normalized) return false
  const target = `slide ${index}`.toLowerCase()
  if (!normalized.includes(target)) return false
  if (count <= 0) return true
  return (
    normalized.includes(`slide ${index}/${count}`) ||
    normalized.includes(`slide ${index} / ${count}`) ||
    normalized.includes(`slide ${index}`)
  )
}

const stripQuotes = (value: string): string => value.replace(/[“”"]/g, '')

export const deriveSlideTitle = (text: string): string => {
  const cleaned = stripQuotes(text)
    .replace(/\[[^\]]*slide[^\]]*\]/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  if (!cleaned) return 'Overview'
  const sentenceMatch = cleaned.match(/[^.!?]+[.!?]+|[^.!?]+$/)
  const sentence = (sentenceMatch?.[0] ?? cleaned).trim()
  const words = sentence.split(/\s+/).filter(Boolean)
  const short = words.slice(0, 8).join(' ').trim()
  const candidate = short || sentence
  const maxLength = 72
  if (candidate.length <= maxLength) return candidate.replace(/[.:;,-]+$/, '')
  const truncated = candidate.slice(0, maxLength).trimEnd()
  const trimmed = truncated.replace(/\s+\S*$/, '').trim()
  return (trimmed || truncated.trim()).replace(/[.:;,-]+$/, '')
}

export const splitSlideTitleFromText = ({
  text,
}: {
  text: string
  slideIndex: number
  total: number
}): { title: string | null; body: string } => {
  const trimmed = text.trim()
  if (!trimmed) return { title: null, body: '' }
  const lines = trimmed
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
  if (lines.length === 0) return { title: null, body: '' }
  const firstLine = lines[0] ?? ''
  const titleMatch = firstLine.match(/^title\s*:\s*(.+)$/i)
  if (titleMatch) {
    const title = collapseLineWhitespace(titleMatch[1] ?? '').trim()
    const body = lines.slice(1).join('\n').trim()
    return { title: title || null, body }
  }
  if (!looksLikeTitleLine(firstLine)) {
    return { title: null, body: trimmed }
  }
  const title = collapseLineWhitespace(firstLine).trim()
  const body = lines.slice(1).join('\n').trim()
  return { title: title || null, body }
}

export const ensureSlideTitleLine = ({
  text,
  slide,
  total,
}: {
  text: string
  slide: SlideTimelineEntry
  total: number
}): string => {
  void slide
  void total
  return text.trim()
}

export function findSlidesSectionStart(markdown: string): number | null {
  if (!markdown) return null
  const heading = markdown.match(/^#{1,3}\s+Slides\b.*$/im)
  const tag = markdown.match(/^\[slide:\d+\]/im)
  const label = markdown.match(/^\s*slide\s+\d+(?:\s*[\u00b7:-].*)?$/im)
  const indexes = [heading?.index, tag?.index, label?.index].filter(
    (idx): idx is number => idx != null
  )
  if (indexes.length === 0) return null
  return Math.min(...indexes)
}

export function splitSummaryFromSlides(markdown: string): {
  summary: string
  slidesSection: string | null
} {
  const start = findSlidesSectionStart(markdown)
  if (start == null) return { summary: markdown.trim(), slidesSection: null }
  const summary = markdown.slice(0, start).trim()
  const slidesSection = markdown.slice(start)
  return { summary, slidesSection }
}

export function parseSlideSummariesFromMarkdown(markdown: string): Map<number, string> {
  const result = new Map<number, string>()
  if (!markdown.trim()) return result
  const start = findSlidesSectionStart(markdown)
  if (start == null) return result
  const slice = markdown.slice(start)
  const lines = slice.split('\n')
  let currentIndex: number | null = null
  let buffer: string[] = []
  const flush = () => {
    if (currentIndex == null) return
    const text = buffer.map((line) => collapseLineWhitespace(line)).join('\n').trim()
    result.set(currentIndex, text)
    currentIndex = null
    buffer = []
  }

  for (const line of lines) {
    const trimmed = line.trim()
    const heading = trimmed.match(/^#{1,3}\s+\S/)
    if (heading && !trimmed.toLowerCase().startsWith('### slides')) {
      flush()
      break
    }
    const match = trimmed.match(SLIDE_TAG_PATTERN)
    if (match) {
      flush()
      const index = Number.parseInt(match[1] ?? '', 10)
      if (!Number.isFinite(index) || index <= 0) continue
      currentIndex = index
      const rest = (match[2] ?? '').trim()
      if (rest) buffer.push(rest)
      continue
    }
    const label = trimmed.match(SLIDE_LABEL_PATTERN)
    if (label) {
      flush()
      const index = Number.parseInt(label[1] ?? '', 10)
      if (!Number.isFinite(index) || index <= 0) continue
      currentIndex = index
      continue
    }
    if (currentIndex == null) continue
    if (!trimmed) continue
    buffer.push(trimmed)
  }
  flush()
  return result
}

export function extractSlideMarkers(markdown: string): number[] {
  if (!markdown.trim()) return []
  const indexes: number[] = []
  const regex = /\[[^\]]*slide[^\d\]]*(\d+)[^\]]*\]/gi
  let match = regex.exec(markdown)
  while (match) {
    const index = Number.parseInt(match[1] ?? '', 10)
    if (!Number.isFinite(index) || index <= 0) continue
    indexes.push(index)
    match = regex.exec(markdown)
  }
  return indexes
}

function splitMarkdownParagraphs(markdown: string): string[] {
  return markdown
    .split(/\n\s*\n+/)
    .map((part) => part.trim())
    .filter(Boolean)
}

function pickIntroParagraph(markdown: string): string {
  const paragraphs = splitMarkdownParagraphs(markdown)
  if (paragraphs.length === 0) return ''
  const firstNonHeading =
    paragraphs.find((paragraph) => !/^#{1,6}\s+\S/.test(paragraph.trim())) ?? paragraphs[0]
  if (!firstNonHeading) return ''
  const sentences = firstNonHeading.match(/[^.!?]+[.!?]+|[^.!?]+$/g) ?? [firstNonHeading]
  if (sentences.length <= 3) return firstNonHeading.trim()
  return sentences.slice(0, 3).join(' ').trim()
}

function hasSlideLabelLines(markdown: string): boolean {
  return markdown
    .split('\n')
    .some((line) => SLIDE_LABEL_PATTERN.test(line.trim().replace(/\s+/g, ' ')))
}

function findFirstSlideTokenIndex(markdown: string): number | null {
  const tag = markdown.match(/\[slide:\d+\]/i)
  const label = markdown.match(/^\s*slide\s+\d+(?:\s*[\u00b7:-].*)?$/im)
  const indexes = [tag?.index, label?.index].filter((idx): idx is number => idx != null)
  if (indexes.length === 0) return null
  return Math.min(...indexes)
}

function trimIntroBeforeSlides(markdown: string): string {
  const firstIndex = findFirstSlideTokenIndex(markdown)
  if (firstIndex == null) return markdown
  const intro = pickIntroParagraph(markdown.slice(0, firstIndex))
  const rest = markdown.slice(firstIndex).trimStart()
  if (!intro) return rest
  return `${intro}\n\n${rest}`
}

export function buildSlideTextFallback({
  slides,
  transcriptTimedText,
  lengthArg,
}: {
  slides: SlideTimelineEntry[]
  transcriptTimedText: string | null | undefined
  lengthArg: { kind: 'preset'; preset: SummaryLength } | { kind: 'chars'; maxCharacters: number }
}): Map<number, string> {
  const map = new Map<number, string>()
  if (!transcriptTimedText || !transcriptTimedText.trim()) return map
  if (slides.length === 0) return map
  const segments = parseTranscriptTimedText(transcriptTimedText)
  if (segments.length === 0) return map
  const ordered = slides.slice().sort((a, b) => a.index - b.index)
  const budget = resolveSlideTextBudget({ lengthArg, slideCount: ordered.length })
  const windowSeconds = resolveSlideWindowSeconds({ lengthArg })
  for (let i = 0; i < ordered.length; i += 1) {
    const slide = ordered[i]
    if (!slide) continue
    const nextSlide = i + 1 < ordered.length ? (ordered[i + 1] ?? null) : null
    const text = getTranscriptTextForSlide({
      slide,
      nextSlide,
      segments,
      budget,
      windowSeconds,
    })
    if (text) map.set(slide.index, text)
  }
  return map
}

export function coerceSummaryWithSlides({
  markdown,
  slides,
  transcriptTimedText,
  lengthArg,
}: {
  markdown: string
  slides: SlideTimelineEntry[]
  transcriptTimedText?: string | null
  lengthArg: { kind: 'preset'; preset: SummaryLength } | { kind: 'chars'; maxCharacters: number }
}): string {
  if (!markdown.trim() || slides.length === 0) return markdown
  const ordered = slides.slice().sort((a, b) => a.index - b.index)
  const { summary, slidesSection } = splitSummaryFromSlides(markdown)
  const intro = pickIntroParagraph(summary)
  const slideSummaries = slidesSection ? parseSlideSummariesFromMarkdown(markdown) : new Map()
  const fallbackSummaries = buildSlideTextFallback({
    slides: ordered,
    transcriptTimedText,
    lengthArg,
  })

  if (slideSummaries.size > 0) {
    const parts: string[] = []
    if (intro) parts.push(intro)
    for (const slide of ordered) {
      const text = slideSummaries.get(slide.index) ?? fallbackSummaries.get(slide.index) ?? ''
      const withTitle = text ? ensureSlideTitleLine({ text, slide, total: ordered.length }) : ''
      parts.push(withTitle ? `[slide:${slide.index}]\n${withTitle}` : `[slide:${slide.index}]`)
    }
    return parts.join('\n\n')
  }

  const paragraphs = splitMarkdownParagraphs(markdown)
  if (paragraphs.length === 0) return markdown
  const introParagraph = intro || paragraphs[0] || ''
  const introIndex = paragraphs.indexOf(introParagraph)
  const remaining =
    introIndex >= 0 ? paragraphs.filter((_, index) => index !== introIndex) : paragraphs.slice(1)
  const parts: string[] = []
  if (introParagraph) parts.push(introParagraph.trim())
  if (remaining.length === 0) {
    for (const slide of ordered) {
      parts.push(`[slide:${slide.index}]`)
    }
    return parts.join('\n\n')
  }
  const total = ordered.length
  for (let i = 0; i < total; i += 1) {
    const start = Math.round((i * remaining.length) / total)
    const end = Math.round(((i + 1) * remaining.length) / total)
    const segment = remaining.slice(start, end).join('\n\n').trim()
    const slideIndex = ordered[i]?.index ?? i + 1
    const fallback = fallbackSummaries.get(slideIndex) ?? ''
    const text = segment || fallback
    const slide = ordered[i] ?? { index: slideIndex, timestamp: Number.NaN }
    const withTitle = text ? ensureSlideTitleLine({ text, slide, total }) : ''
    parts.push(withTitle ? `[slide:${slideIndex}]\n${withTitle}` : `[slide:${slideIndex}]`)
  }
  return parts.join('\n\n')
}

function parseTimestampSeconds(value: string): number | null {
  const parts = value.split(':').map((item) => Number(item))
  if (parts.some((item) => !Number.isFinite(item))) return null
  if (parts.length === 2) {
    const [minutes, seconds] = parts
    return minutes * 60 + seconds
  }
  if (parts.length === 3) {
    const [hours, minutes, seconds] = parts
    return hours * 3600 + minutes * 60 + seconds
  }
  return null
}

export function interleaveSlidesIntoTranscript({
  transcriptTimedText,
  slides,
}: {
  transcriptTimedText: string
  slides: SlideTimelineEntry[]
}): string {
  if (!transcriptTimedText.trim() || slides.length === 0) return transcriptTimedText
  const ordered = slides
    .filter((slide) => Number.isFinite(slide.timestamp))
    .map((slide) => ({ index: slide.index, timestamp: slide.timestamp }))
    .sort((a, b) => a.timestamp - b.timestamp)
  if (ordered.length === 0) return transcriptTimedText

  let nextIndex = 0
  const out: string[] = []
  const lines = transcriptTimedText.split('\n')
  for (const line of lines) {
    const trimmed = line.trim()
    const match = trimmed.match(/^\[(\d{1,2}:\d{2}(?::\d{2})?)\]/)
    const seconds = match ? parseTimestampSeconds(match[1] ?? '') : null
    if (seconds != null) {
      while (nextIndex < ordered.length && (ordered[nextIndex]?.timestamp ?? 0) <= seconds) {
        const slide = ordered[nextIndex]
        if (slide) out.push(`[slide:${slide.index}]`)
        nextIndex += 1
      }
    }
    out.push(line)
  }
  while (nextIndex < ordered.length) {
    const slide = ordered[nextIndex]
    if (slide) out.push(`[slide:${slide.index}]`)
    nextIndex += 1
  }
  return out.join('\n')
}

export function parseTranscriptTimedText(input: string | null | undefined): TranscriptSegment[] {
  if (!input) return []
  const segments: TranscriptSegment[] = []
  for (const line of input.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed.startsWith('[')) continue
    const match = trimmed.match(/^\[(\d{1,2}:\d{2}(?::\d{2})?)\]\s*(.*)$/)
    if (!match) continue
    const seconds = parseTimestampSeconds(match[1])
    if (seconds == null) continue
    const text = (match[2] ?? '').trim()
    if (!text) continue
    segments.push({ startSeconds: seconds, text })
  }
  segments.sort((a, b) => a.startSeconds - b.startSeconds)
  return segments
}

export function formatTimestamp(seconds: number): string {
  const clamped = Math.max(0, Math.floor(seconds))
  const hours = Math.floor(clamped / 3600)
  const minutes = Math.floor((clamped % 3600) / 60)
  const secs = clamped % 60
  const mm = String(minutes).padStart(2, '0')
  const ss = String(secs).padStart(2, '0')
  if (hours <= 0) return `${minutes}:${ss}`
  const hh = String(hours).padStart(2, '0')
  return `${hh}:${mm}:${ss}`
}

function normalizeSlideText(value: string): string {
  return value.replace(/\s+/g, ' ').trim()
}

function truncateSlideText(value: string, limit: number): string {
  if (value.length <= limit) return value
  const truncated = value.slice(0, limit).trimEnd()
  const clean = truncated.replace(/\s+\S*$/, '').trim()
  const result = clean.length > 0 ? clean : truncated.trim()
  return result.length > 0 ? `${result}...` : ''
}

export function resolveSlideTextBudget({
  lengthArg,
  slideCount,
}: {
  lengthArg: { kind: 'preset'; preset: SummaryLength } | { kind: 'chars'; maxCharacters: number }
  slideCount: number
}): number {
  if (lengthArg.kind === 'preset') {
    return SLIDE_TEXT_BUDGET_BY_PRESET[lengthArg.preset]
  }
  const divisor = Math.max(1, Math.min(slideCount, 10))
  const perSlide = Math.round(lengthArg.maxCharacters / divisor)
  return clampNumber(perSlide, SLIDE_TEXT_BUDGET_MIN, SLIDE_TEXT_BUDGET_MAX)
}

export function resolveSlideWindowSeconds({
  lengthArg,
}: {
  lengthArg: { kind: 'preset'; preset: SummaryLength } | { kind: 'chars'; maxCharacters: number }
}): number {
  if (lengthArg.kind === 'preset') {
    return SLIDE_WINDOW_SECONDS_BY_PRESET[lengthArg.preset]
  }
  const window = Math.round(lengthArg.maxCharacters / 100)
  return clampNumber(window, SLIDE_WINDOW_SECONDS_MIN, SLIDE_WINDOW_SECONDS_MAX)
}

export function getTranscriptTextForSlide({
  slide,
  nextSlide,
  segments,
  budget,
  windowSeconds,
}: {
  slide: SlideTimelineEntry
  nextSlide: SlideTimelineEntry | null
  segments: TranscriptSegment[]
  budget: number
  windowSeconds: number
}): string {
  if (!Number.isFinite(slide.timestamp)) return ''
  if (segments.length === 0) return ''
  const start = Math.max(0, Math.floor(slide.timestamp))
  const leadIn = Math.min(6, Math.floor(windowSeconds * 0.2))
  const lower = Math.max(0, start - leadIn)
  let upper = start + windowSeconds
  if (nextSlide && Number.isFinite(nextSlide.timestamp)) {
    const next = Math.max(start, Math.floor(nextSlide.timestamp))
    if (next > start) {
      upper = Math.min(upper, next)
    }
  }
  if (upper < lower) return ''
  const parts: string[] = []
  for (const segment of segments) {
    if (segment.startSeconds < lower) continue
    if (segment.startSeconds > upper) break
    parts.push(segment.text)
  }
  const text = normalizeSlideText(parts.join(' '))
  return text ? truncateSlideText(text, budget) : ''
}

export function formatOsc8Link(label: string, url: string | null, enabled: boolean): string {
  if (!enabled || !url) return label
  const osc = '\u001b]8;;'
  const st = '\u001b\\'
  return `${osc}${url}${st}${label}${osc}${st}`
}

export function buildTimestampUrl(sourceUrl: string, seconds: number): string | null {
  if (!sourceUrl) return null
  let url: URL
  try {
    url = new URL(sourceUrl)
  } catch {
    return null
  }
  const host = url.hostname.replace(/^www\./, '').toLowerCase()
  const clamped = Math.max(0, Math.floor(seconds))

  if (host === 'youtu.be' || host === 'youtube.com' || host === 'm.youtube.com') {
    const id = extractYouTubeVideoId(sourceUrl)
    if (!id) return null
    return `https://www.youtube.com/watch?v=${id}&t=${clamped}s`
  }

  if (host === 'vimeo.com' || host === 'player.vimeo.com') {
    const match = url.pathname.match(/\/(\d+)(?:$|\/)/)
    if (!match) return null
    url.hash = `t=${clamped}s`
    return url.toString()
  }

  if (host === 'loom.com' || host.endsWith('.loom.com')) {
    url.searchParams.set('t', clamped.toString())
    return url.toString()
  }

  if (host === 'dropbox.com' || host.endsWith('.dropbox.com')) {
    url.searchParams.set('t', clamped.toString())
    return url.toString()
  }

  return null
}
