import type { SummaryLength } from './shared/contracts.js'

export type YoutubeMode = 'auto' | 'web' | 'apify' | 'yt-dlp' | 'no-auto'
export type FirecrawlMode = 'off' | 'auto' | 'always'
export type MarkdownMode = 'off' | 'auto' | 'llm' | 'readability'
export type ExtractFormat = 'text' | 'markdown'
export type PreprocessMode = 'off' | 'auto' | 'always'
export type StreamMode = 'auto' | 'on' | 'off'
export type MetricsMode = 'off' | 'on' | 'detailed'
export type VideoMode = 'auto' | 'transcript' | 'understand'

export type LengthArg =
  | { kind: 'preset'; preset: SummaryLength }
  | { kind: 'chars'; maxCharacters: number }

const SUMMARY_LENGTHS: SummaryLength[] = ['short', 'medium', 'long', 'xl', 'xxl']
const DURATION_PATTERN = /^(?<value>\d+(?:\.\d+)?)(?<unit>ms|s|m|h)?$/i
const COUNT_PATTERN = /^(?<value>\d+(?:\.\d+)?)(?<unit>k|m)?$/i
const MIN_LENGTH_CHARS = 10
const MIN_MAX_OUTPUT_TOKENS = 16
const MIN_RETRIES = 0
const MAX_RETRIES = 5

export function parseYoutubeMode(raw: string): YoutubeMode {
  const normalized = raw.trim().toLowerCase()
  if (normalized === 'autp') return 'auto'
  if (normalized === 'auto' || normalized === 'web' || normalized === 'apify') return normalized
  if (normalized === 'yt-dlp') return 'yt-dlp'
  if (normalized === 'no-auto') return 'no-auto'
  throw new Error(`Unsupported --youtube: ${raw}`)
}

export function parseFirecrawlMode(raw: string): FirecrawlMode {
  const normalized = raw.trim().toLowerCase()
  if (normalized === 'off' || normalized === 'auto' || normalized === 'always') return normalized
  throw new Error(`Unsupported --firecrawl: ${raw}`)
}

export function parseMarkdownMode(raw: string): MarkdownMode {
  const normalized = raw.trim().toLowerCase()
  if (
    normalized === 'off' ||
    normalized === 'auto' ||
    normalized === 'llm' ||
    normalized === 'readability'
  )
    return normalized
  throw new Error(`Unsupported --markdown-mode: ${raw}`)
}

export function parseExtractFormat(raw: string): ExtractFormat {
  const normalized = raw.trim().toLowerCase()
  if (normalized === 'text' || normalized === 'txt' || normalized === 'plain') return 'text'
  if (normalized === 'md' || normalized === 'markdown') return 'markdown'
  throw new Error(`Unsupported --format: ${raw}`)
}

export function parsePreprocessMode(raw: string): PreprocessMode {
  const normalized = raw.trim().toLowerCase()
  if (normalized === 'off' || normalized === 'auto' || normalized === 'always') {
    return normalized as PreprocessMode
  }
  if (normalized === 'on') return 'always'
  throw new Error(`Unsupported --preprocess: ${raw}`)
}

export function parseStreamMode(raw: string): StreamMode {
  const normalized = raw.trim().toLowerCase()
  if (normalized === 'auto' || normalized === 'on' || normalized === 'off') return normalized
  throw new Error(`Unsupported --stream: ${raw}`)
}

export function parseMetricsMode(raw: string): MetricsMode {
  const normalized = raw.trim().toLowerCase()
  if (normalized === 'off' || normalized === 'on' || normalized === 'detailed') {
    return normalized as MetricsMode
  }
  throw new Error(`Unsupported --metrics: ${raw}`)
}

export function parseVideoMode(raw: string): VideoMode {
  const normalized = raw.trim().toLowerCase()
  if (normalized === 'auto' || normalized === 'transcript' || normalized === 'understand') {
    return normalized as VideoMode
  }
  throw new Error(`Unsupported --video-mode: ${raw}`)
}

export function parseDurationMs(raw: string): number {
  const normalized = raw.trim()
  const match = DURATION_PATTERN.exec(normalized)
  if (!match?.groups) {
    throw new Error(`Unsupported --timeout: ${raw}`)
  }

  const numeric = Number(match.groups.value)
  if (!Number.isFinite(numeric) || numeric <= 0) {
    throw new Error(`Unsupported --timeout: ${raw}`)
  }

  const unit = match.groups.unit?.toLowerCase() ?? 's'
  const multiplier = unit === 'ms' ? 1 : unit === 's' ? 1000 : unit === 'm' ? 60_000 : 3_600_000
  return Math.floor(numeric * multiplier)
}

export function parseLengthArg(raw: string): LengthArg {
  const normalized = raw.trim().toLowerCase()
  const shorthand = { s: 'short', m: 'medium', l: 'long' } as const
  if (normalized in shorthand) {
    return { kind: 'preset', preset: shorthand[normalized as keyof typeof shorthand] }
  }

  if (SUMMARY_LENGTHS.includes(normalized as SummaryLength)) {
    return { kind: 'preset', preset: normalized as SummaryLength }
  }

  const match = COUNT_PATTERN.exec(normalized)
  if (!match?.groups) {
    throw new Error(`Unsupported --length: ${raw}`)
  }

  const numeric = Number(match.groups.value)
  if (!Number.isFinite(numeric) || numeric <= 0) {
    throw new Error(`Unsupported --length: ${raw}`)
  }

  const unit = match.groups.unit?.toLowerCase() ?? null
  const multiplier = unit === 'k' ? 1000 : unit === 'm' ? 1_000_000 : 1
  const maxCharacters = Math.floor(numeric * multiplier)
  if (maxCharacters < MIN_LENGTH_CHARS) {
    throw new Error(`Unsupported --length: ${raw} (minimum ${MIN_LENGTH_CHARS} chars)`)
  }
  return { kind: 'chars', maxCharacters }
}

export function parseMaxExtractCharactersArg(raw: string | undefined): number | null {
  if (raw === undefined || raw === null) return null
  const normalized = raw.trim().toLowerCase()
  if (!normalized) return null
  const match = COUNT_PATTERN.exec(normalized)
  if (!match?.groups) {
    throw new Error(`Unsupported --max-extract-characters: ${raw}`)
  }
  const numeric = Number(match.groups.value)
  if (!Number.isFinite(numeric)) {
    throw new Error(`Unsupported --max-extract-characters: ${raw}`)
  }
  if (numeric <= 0) return null
  const unit = match.groups.unit?.toLowerCase() ?? null
  const multiplier = unit === 'k' ? 1000 : unit === 'm' ? 1_000_000 : 1
  const maxCharacters = Math.floor(numeric * multiplier)
  if (maxCharacters < MIN_LENGTH_CHARS) {
    throw new Error(
      `Unsupported --max-extract-characters: ${raw} (minimum ${MIN_LENGTH_CHARS} chars)`
    )
  }
  return maxCharacters
}

export function parseMaxOutputTokensArg(raw: string | undefined): number | null {
  if (raw === undefined || raw === null) return null
  const normalized = raw.trim().toLowerCase()
  if (!normalized) {
    throw new Error(`Unsupported --max-output-tokens: ${raw}`)
  }

  const match = COUNT_PATTERN.exec(normalized)
  if (!match?.groups) {
    throw new Error(`Unsupported --max-output-tokens: ${raw}`)
  }

  const numeric = Number(match.groups.value)
  if (!Number.isFinite(numeric) || numeric <= 0) {
    throw new Error(`Unsupported --max-output-tokens: ${raw}`)
  }

  const unit = match.groups.unit?.toLowerCase() ?? null
  const multiplier = unit === 'k' ? 1000 : unit === 'm' ? 1_000_000 : 1
  const maxOutputTokens = Math.floor(numeric * multiplier)
  if (maxOutputTokens < MIN_MAX_OUTPUT_TOKENS) {
    throw new Error(`Unsupported --max-output-tokens: ${raw} (minimum ${MIN_MAX_OUTPUT_TOKENS})`)
  }
  return maxOutputTokens
}

export function parseRetriesArg(raw: string): number {
  const normalized = raw.trim()
  if (!normalized) {
    throw new Error(`Unsupported --retries: ${raw}`)
  }
  const numeric = Number(normalized)
  if (!Number.isFinite(numeric) || !Number.isInteger(numeric)) {
    throw new Error(`Unsupported --retries: ${raw}`)
  }
  if (numeric < MIN_RETRIES || numeric > MAX_RETRIES) {
    throw new Error(`Unsupported --retries: ${raw} (range ${MIN_RETRIES}-${MAX_RETRIES})`)
  }
  return numeric
}
