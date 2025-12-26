import type { CacheMode, TranscriptDiagnostics } from '../types.js'
import { applyContentBudget, normalizeCandidate, normalizeForPrompt } from './cleaner.js'
import {
  DEFAULT_CACHE_MODE,
  DEFAULT_MAX_CONTENT_CHARACTERS,
  DEFAULT_TIMEOUT_MS,
  type ExtractedLinkContent,
  type FetchLinkContentOptions,
  type FinalizationArguments,
  type FirecrawlMode,
  type TranscriptResolution,
} from './types.js'

const WWW_PREFIX_PATTERN = /^www\./i
const TRANSCRIPT_LINE_SPLIT_PATTERN = /\r?\n/
const WORD_SPLIT_PATTERN = /\s+/g

function resolveMediaDurationSecondsFromTranscriptMetadata(
  metadata: Record<string, unknown> | null | undefined
): number | null {
  if (!metadata) return null
  const direct = (metadata as { durationSeconds?: unknown }).durationSeconds
  if (typeof direct === 'number' && Number.isFinite(direct) && direct > 0) {
    return direct
  }
  const media = (metadata as { media?: unknown }).media
  if (typeof media === 'object' && media !== null) {
    const nested = (media as { durationSeconds?: unknown }).durationSeconds
    if (typeof nested === 'number' && Number.isFinite(nested) && nested > 0) {
      return nested
    }
  }
  return null
}

function resolveTranscriptionProviderFromTranscriptMetadata(
  metadata: Record<string, unknown> | null | undefined
): string | null {
  if (!metadata) return null
  const provider = (metadata as { transcriptionProvider?: unknown }).transcriptionProvider
  return typeof provider === 'string' && provider.trim().length > 0 ? provider.trim() : null
}

export function resolveCacheMode(options?: FetchLinkContentOptions) {
  return options?.cacheMode ?? DEFAULT_CACHE_MODE
}

export function resolveMaxCharacters(options?: FetchLinkContentOptions): number | null {
  const candidate = options?.maxCharacters
  if (typeof candidate !== 'number' || !Number.isFinite(candidate) || candidate <= 0) {
    return null
  }
  if (candidate <= DEFAULT_MAX_CONTENT_CHARACTERS) {
    return DEFAULT_MAX_CONTENT_CHARACTERS
  }
  return Math.floor(candidate)
}

export function resolveTimeoutMs(options?: FetchLinkContentOptions): number {
  const candidate = options?.timeoutMs
  if (typeof candidate !== 'number' || !Number.isFinite(candidate) || candidate <= 0) {
    return DEFAULT_TIMEOUT_MS
  }
  return Math.floor(candidate)
}

export function resolveFirecrawlMode(options?: FetchLinkContentOptions): FirecrawlMode {
  const candidate = options?.firecrawl
  if (candidate === 'off' || candidate === 'auto' || candidate === 'always') {
    return candidate
  }
  return 'auto'
}

export function appendNote(existing: string | null | undefined, next: string): string {
  if (!next) {
    return existing ?? ''
  }
  if (!existing || existing.length === 0) {
    return next
  }
  return `${existing}; ${next}`
}

export function safeHostname(rawUrl: string): string | null {
  try {
    return new URL(rawUrl).hostname.replace(WWW_PREFIX_PATTERN, '')
  } catch {
    return null
  }
}

export function pickFirstText(candidates: Array<string | null | undefined>): string | null {
  for (const candidate of candidates) {
    const normalized = normalizeCandidate(candidate)
    if (normalized) {
      return normalized
    }
  }
  return null
}

export function selectBaseContent(sourceContent: string, transcriptText: string | null): string {
  if (!transcriptText) {
    return sourceContent
  }
  const normalizedTranscript = normalizeForPrompt(transcriptText)
  if (normalizedTranscript.length === 0) {
    return sourceContent
  }
  return `Transcript:\n${normalizedTranscript}`
}

export function summarizeTranscript(transcriptText: string | null) {
  if (!transcriptText) {
    return { transcriptCharacters: null, transcriptLines: null, transcriptWordCount: null }
  }
  const transcriptCharacters = transcriptText.length > 0 ? transcriptText.length : null
  const transcriptLinesRaw = transcriptText
    .split(TRANSCRIPT_LINE_SPLIT_PATTERN)
    .map((line) => line.trim())
    .filter((line) => line.length > 0).length
  const transcriptLines = transcriptLinesRaw > 0 ? transcriptLinesRaw : null
  const transcriptWordCountRaw =
    transcriptText.length > 0
      ? transcriptText
          .split(WORD_SPLIT_PATTERN)
          .map((value) => value.trim())
          .filter((value) => value.length > 0).length
      : 0
  const transcriptWordCount = transcriptWordCountRaw > 0 ? transcriptWordCountRaw : null
  return { transcriptCharacters, transcriptLines, transcriptWordCount }
}

export function ensureTranscriptDiagnostics(
  resolution: TranscriptResolution,
  cacheMode: CacheMode
): TranscriptDiagnostics {
  if (resolution.diagnostics) {
    return resolution.diagnostics
  }
  const hasText = typeof resolution.text === 'string' && resolution.text.length > 0
  const cacheStatus = cacheMode === 'bypass' ? 'bypassed' : hasText ? 'miss' : 'unknown'
  return {
    cacheMode,
    cacheStatus,
    textProvided: hasText,
    provider: resolution.source,
    attemptedProviders: resolution.source ? [resolution.source] : [],
    notes: cacheMode === 'bypass' ? 'Cache bypass requested' : null,
  }
}

export function finalizeExtractedLinkContent({
  url,
  baseContent,
  maxCharacters,
  title,
  description,
  siteName,
  transcriptResolution,
  video,
  isVideoOnly,
  diagnostics,
}: FinalizationArguments): ExtractedLinkContent {
  const normalized = normalizeForPrompt(baseContent)
  const { content, truncated, totalCharacters, wordCount } =
    typeof maxCharacters === 'number'
      ? applyContentBudget(normalized, maxCharacters)
      : {
          content: normalized,
          truncated: false,
          totalCharacters: normalized.length,
          wordCount:
            normalized.length > 0
              ? normalized
                  .split(WORD_SPLIT_PATTERN)
                  .map((value) => value.trim())
                  .filter((value) => value.length > 0).length
              : 0,
        }
  const { transcriptCharacters, transcriptLines, transcriptWordCount } = summarizeTranscript(
    transcriptResolution.text
  )
  const transcriptionProvider = resolveTranscriptionProviderFromTranscriptMetadata(
    transcriptResolution.metadata
  )
  const mediaDurationSeconds = resolveMediaDurationSecondsFromTranscriptMetadata(
    transcriptResolution.metadata
  )

  return {
    url,
    title,
    description,
    siteName,
    content,
    truncated,
    totalCharacters,
    wordCount,
    transcriptCharacters,
    transcriptLines,
    transcriptWordCount,
    transcriptSource: transcriptResolution.source,
    transcriptionProvider,
    transcriptMetadata: transcriptResolution.metadata ?? null,
    mediaDurationSeconds,
    video,
    isVideoOnly,
    diagnostics,
  }
}
