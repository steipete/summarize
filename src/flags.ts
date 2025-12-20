import type { SummaryLength } from './shared/contracts.js'

export type YoutubeMode = 'auto' | 'web' | 'apify' | 'yt-dlp'
export type FirecrawlMode = 'off' | 'auto' | 'always'
export type MarkdownMode = 'off' | 'auto' | 'llm'
export type StreamMode = 'auto' | 'on' | 'off'
export type RenderMode = 'auto' | 'md' | 'md-live' | 'plain'
export type MetricsMode = 'off' | 'on' | 'detailed'

export type LengthArg =
  | { kind: 'preset'; preset: SummaryLength }
  | { kind: 'chars'; maxCharacters: number }

const SUMMARY_LENGTHS: SummaryLength[] = ['short', 'medium', 'long', 'xl', 'xxl']
const DURATION_PATTERN = /^(?<value>\d+(?:\.\d+)?)(?<unit>ms|s|m|h)?$/i
const COUNT_PATTERN = /^(?<value>\d+(?:\.\d+)?)(?<unit>k|m)?$/i
const MIN_LENGTH_CHARS = 50
const MIN_MAX_OUTPUT_TOKENS = 16

export function parseYoutubeMode(raw: string): YoutubeMode {
  const normalized = raw.trim().toLowerCase()
  if (normalized === 'autp') return 'auto'
  if (normalized === 'auto' || normalized === 'web' || normalized === 'apify' || normalized === 'yt-dlp') return normalized
  throw new Error(`Unsupported --youtube: ${raw}`)
}

export function parseFirecrawlMode(raw: string): FirecrawlMode {
  const normalized = raw.trim().toLowerCase()
  if (normalized === 'off' || normalized === 'auto' || normalized === 'always') return normalized
  throw new Error(`Unsupported --firecrawl: ${raw}`)
}

export function parseMarkdownMode(raw: string): MarkdownMode {
  const normalized = raw.trim().toLowerCase()
  if (normalized === 'off' || normalized === 'auto' || normalized === 'llm') return normalized
  throw new Error(`Unsupported --markdown: ${raw}`)
}

export function parseStreamMode(raw: string): StreamMode {
  const normalized = raw.trim().toLowerCase()
  if (normalized === 'auto' || normalized === 'on' || normalized === 'off') return normalized
  throw new Error(`Unsupported --stream: ${raw}`)
}

export function parseRenderMode(raw: string): RenderMode {
  const normalized = raw.trim().toLowerCase()
  if (normalized === 'auto' || normalized === 'plain') return normalized as RenderMode
  if (normalized === 'md-live' || normalized === 'live' || normalized === 'mdlive') return 'md-live'
  if (normalized === 'md' || normalized === 'markdown') return 'md'
  throw new Error(`Unsupported --render: ${raw}`)
}

export function parseMetricsMode(raw: string): MetricsMode {
  const normalized = raw.trim().toLowerCase()
  if (normalized === 'off' || normalized === 'on' || normalized === 'detailed') {
    return normalized as MetricsMode
  }
  throw new Error(`Unsupported --metrics: ${raw}`)
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
