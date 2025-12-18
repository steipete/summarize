import type { SummaryLength } from './shared/contracts.js'

export type YoutubeMode = 'auto' | 'web' | 'apify'
export type FirecrawlMode = 'off' | 'auto' | 'always'
export type MarkdownMode = 'off' | 'auto' | 'llm'

export type LengthArg =
  | { kind: 'preset'; preset: SummaryLength }
  | { kind: 'chars'; maxCharacters: number }

const SUMMARY_LENGTHS: SummaryLength[] = ['short', 'medium', 'long', 'xl', 'xxl']
const DURATION_PATTERN = /^(?<value>\d+(?:\.\d+)?)(?<unit>ms|s|m|h)?$/i
const COUNT_PATTERN = /^(?<value>\d+(?:\.\d+)?)(?<unit>k|m)?$/i

export function parseYoutubeMode(raw: string): YoutubeMode {
  const normalized = raw.trim().toLowerCase()
  if (normalized === 'autp') return 'auto'
  if (normalized === 'auto' || normalized === 'web' || normalized === 'apify') return normalized
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
  return { kind: 'chars', maxCharacters: Math.floor(numeric * multiplier) }
}
