import type { TranscriptCache } from '../deps.js'
import type {
  CacheMode,
  TranscriptDiagnostics,
  TranscriptResolution,
  TranscriptSource,
} from '../types.js'

export const DEFAULT_TTL_MS = 1000 * 60 * 60 * 24 * 7
export const NEGATIVE_TTL_MS = 1000 * 60 * 60 * 6

type CacheDiagnostics = Pick<
  TranscriptDiagnostics,
  'cacheStatus' | 'notes' | 'provider' | 'textProvided' | 'cacheMode' | 'attemptedProviders'
>

export interface CacheReadArguments {
  url: string
  cacheMode: CacheMode
  transcriptCache: TranscriptCache | null
}

export interface TranscriptCacheLookup {
  cached: Awaited<ReturnType<TranscriptCache['get']>> | null
  resolution: TranscriptResolution | null
  diagnostics: CacheDiagnostics
}

export const readTranscriptCache = async ({
  url,
  cacheMode,
  transcriptCache,
}: CacheReadArguments): Promise<TranscriptCacheLookup> => {
  const cached = transcriptCache ? await transcriptCache.get({ url }) : null
  const diagnostics = buildBaseDiagnostics(cacheMode)

  if (!cached) {
    return { cached: null, resolution: null, diagnostics }
  }

  const provider = mapCachedSource(cached.source)
  diagnostics.provider = provider
  diagnostics.attemptedProviders = provider ? [provider] : []
  diagnostics.textProvided = Boolean(cached.content && cached.content.length > 0)

  if (cacheMode === 'bypass') {
    diagnostics.notes = appendNote(
      diagnostics.notes,
      'Cached transcript ignored due to bypass request'
    )
    return { cached, resolution: null, diagnostics }
  }

  if (cached.expired) {
    diagnostics.cacheStatus = 'expired'
    diagnostics.notes = appendNote(
      diagnostics.notes,
      'Cached transcript expired; fetching fresh copy'
    )
    return { cached, resolution: null, diagnostics }
  }

  diagnostics.cacheStatus = 'hit'
  diagnostics.notes = appendNote(diagnostics.notes, 'Served transcript from cache')

  const resolution: TranscriptResolution = {
    text: cached.content,
    source: provider,
    metadata: cached.metadata ?? null,
  }
  return { cached, resolution, diagnostics }
}

const buildBaseDiagnostics = (cacheMode: CacheMode): CacheDiagnostics => ({
  cacheMode,
  cacheStatus: cacheMode === 'bypass' ? 'bypassed' : 'miss',
  provider: null,
  attemptedProviders: [],
  textProvided: false,
  notes: cacheMode === 'bypass' ? 'Cache bypass requested' : null,
})

const appendNote = (existing: string | null | undefined, next: string): string => {
  if (!existing) {
    return next
  }
  return `${existing}; ${next}`
}

export const mapCachedSource = (source: string | null): TranscriptSource | null => {
  if (source === null) return null
  if (
    source === 'youtubei' ||
    source === 'captionTracks' ||
    source === 'yt-dlp' ||
    source === 'podcastTranscript' ||
    source === 'whisper' ||
    source === 'apify' ||
    source === 'html' ||
    source === 'unavailable'
  ) {
    return source
  }
  return 'unknown'
}

export const writeTranscriptCache = async ({
  url,
  service,
  resourceKey,
  result,
  transcriptCache,
}: {
  url: string
  service: string
  resourceKey: string | null
  result: {
    text: string | null
    source: TranscriptSource | null
    metadata?: Record<string, unknown> | undefined
  }
  transcriptCache: TranscriptCache | null
}): Promise<void> => {
  if (!transcriptCache) {
    return
  }

  if (result.source === null && result.text === null) {
    return
  }

  const ttlMs = result.text ? DEFAULT_TTL_MS : NEGATIVE_TTL_MS
  const resolvedSource = result.source ?? (result.text ? 'unknown' : 'unavailable')

  await transcriptCache.set({
    url,
    service,
    resourceKey,
    ttlMs,
    content: result.text,
    source: resolvedSource,
    metadata: result.metadata ?? null,
  })
}
