import type { LinkPreviewDeps } from '../link-preview/deps.js'
import type {
  CacheMode,
  TranscriptDiagnostics,
  TranscriptResolution,
} from '../link-preview/types.js'
import { mapCachedSource, readTranscriptCache, writeTranscriptCache } from './cache.js'
import {
  canHandle as canHandleGeneric,
  fetchTranscript as fetchGeneric,
} from './providers/generic.js'
import {
  canHandle as canHandlePodcast,
  fetchTranscript as fetchPodcast,
} from './providers/podcast.js'
import {
  canHandle as canHandleYoutube,
  fetchTranscript as fetchYoutube,
} from './providers/youtube.js'
import type {
  ProviderContext,
  ProviderFetchOptions,
  ProviderModule,
  ProviderResult,
} from './types.js'
import {
  extractEmbeddedYouTubeUrlFromHtml,
  extractYouTubeVideoId as extractYouTubeVideoIdInternal,
  isYouTubeUrl as isYouTubeUrlInternal,
} from './utils.js'

interface ResolveTranscriptOptions {
  youtubeTranscriptMode?: ProviderFetchOptions['youtubeTranscriptMode']
  mediaTranscriptMode?: ProviderFetchOptions['mediaTranscriptMode']
  mediaKindHint?: ProviderFetchOptions['mediaKindHint']
  transcriptTimestamps?: ProviderFetchOptions['transcriptTimestamps']
  cacheMode?: CacheMode
  fileMtime?: number | null
}

const PROVIDERS: ProviderModule[] = [
  { id: 'youtube', canHandle: canHandleYoutube, fetchTranscript: fetchYoutube },
  { id: 'podcast', canHandle: canHandlePodcast, fetchTranscript: fetchPodcast },
  { id: 'generic', canHandle: canHandleGeneric, fetchTranscript: fetchGeneric },
]
const GENERIC_PROVIDER_ID = 'generic'

export const resolveTranscriptForLink = async (
  url: string,
  html: string | null,
  deps: LinkPreviewDeps,
  {
    youtubeTranscriptMode,
    mediaTranscriptMode,
    mediaKindHint,
    transcriptTimestamps,
    cacheMode: providedCacheMode,
    fileMtime,
  }: ResolveTranscriptOptions = {}
): Promise<TranscriptResolution> => {
  const normalizedUrl = url.trim()
  const embeddedYoutubeUrl =
    !isYouTubeUrlInternal(normalizedUrl) && html
      ? await extractEmbeddedYouTubeUrlFromHtml(html)
      : null
  const effectiveUrl = embeddedYoutubeUrl ?? normalizedUrl
  const resourceKey = extractResourceKey(effectiveUrl)
  const baseContext: ProviderContext = { url: effectiveUrl, html, resourceKey }
  const provider: ProviderModule = selectProvider(baseContext)
  const cacheMode: CacheMode = providedCacheMode ?? 'default'

  const cacheOutcome = await readTranscriptCache({
    url: normalizedUrl,
    cacheMode,
    transcriptCache: deps.transcriptCache,
    transcriptTimestamps: Boolean(transcriptTimestamps),
    fileMtime: fileMtime ?? null,
  })

  const diagnostics: TranscriptDiagnostics = {
    cacheMode,
    cacheStatus: cacheOutcome.diagnostics.cacheStatus,
    textProvided: cacheOutcome.diagnostics.textProvided,
    provider: cacheOutcome.diagnostics.provider,
    attemptedProviders: [],
    notes: cacheOutcome.diagnostics.notes ?? null,
  }

  if (cacheOutcome.resolution) {
    return {
      ...cacheOutcome.resolution,
      diagnostics,
    }
  }

  const shouldReportProgress = provider.id === 'youtube' || provider.id === 'podcast'
  if (shouldReportProgress) {
    deps.onProgress?.({
      kind: 'transcript-start',
      url: normalizedUrl,
      service: provider.id,
      hint:
        provider.id === 'youtube'
          ? 'YouTube: resolving transcript'
          : 'Podcast: resolving transcript',
    })
  }

  const providerResult = await executeProvider(provider, baseContext, {
    fetch: deps.fetch,
    env: deps.env,
    scrapeWithFirecrawl: deps.scrapeWithFirecrawl,
    apifyApiToken: deps.apifyApiToken,
    ytDlpPath: deps.ytDlpPath,
    falApiKey: deps.falApiKey,
    groqApiKey: deps.groqApiKey,
    openaiApiKey: deps.openaiApiKey,
    mediaCache: deps.mediaCache ?? null,
    resolveTwitterCookies: deps.resolveTwitterCookies ?? null,
    onProgress: deps.onProgress ?? null,
    youtubeTranscriptMode: youtubeTranscriptMode ?? 'auto',
    mediaTranscriptMode: mediaTranscriptMode ?? 'auto',
    mediaKindHint: mediaKindHint ?? null,
    transcriptTimestamps: transcriptTimestamps ?? false,
  })

  if (shouldReportProgress) {
    deps.onProgress?.({
      kind: 'transcript-done',
      url: normalizedUrl,
      ok: Boolean(providerResult.text && providerResult.text.length > 0),
      service: provider.id,
      source: providerResult.source,
      hint: providerResult.source ? `${provider.id}/${providerResult.source}` : provider.id,
    })
  }

  diagnostics.provider = providerResult.source
  diagnostics.attemptedProviders = providerResult.attemptedProviders
  diagnostics.textProvided = Boolean(providerResult.text && providerResult.text.length > 0)
  if (providerResult.notes) {
    diagnostics.notes = appendNote(diagnostics.notes, providerResult.notes)
  }

  if (providerResult.source !== null || providerResult.text !== null) {
    if (transcriptTimestamps) {
      const nextMeta = { ...(providerResult.metadata ?? {}) }
      if (providerResult.segments && providerResult.segments.length > 0) {
        nextMeta.timestamps = true
        nextMeta.segments = providerResult.segments
      } else if (nextMeta.timestamps == null) {
        nextMeta.timestamps = false
      }
      providerResult.metadata = nextMeta
    } else if (providerResult.segments && providerResult.segments.length > 0) {
      providerResult.metadata = {
        ...(providerResult.metadata ?? {}),
        segments: providerResult.segments,
      }
    }
    await writeTranscriptCache({
      url: normalizedUrl,
      service: provider.id,
      resourceKey,
      result: providerResult,
      transcriptCache: deps.transcriptCache,
      fileMtime,
    })
  }

  if (!providerResult.text && cacheOutcome.cached?.content && cacheMode !== 'bypass') {
    diagnostics.cacheStatus = 'fallback'
    diagnostics.provider = mapCachedSource(cacheOutcome.cached.source)
    diagnostics.textProvided = Boolean(
      cacheOutcome.cached.content && cacheOutcome.cached.content.length > 0
    )
    diagnostics.notes = appendNote(
      diagnostics.notes,
      'Falling back to cached transcript content after provider miss'
    )

    return {
      text: cacheOutcome.cached.content,
      source: diagnostics.provider,
      metadata: cacheOutcome.cached.metadata ?? null,
      diagnostics,
      segments: transcriptTimestamps
        ? resolveSegmentsFromMetadata(cacheOutcome.cached.metadata)
        : null,
    }
  }

  return {
    text: providerResult.text,
    source: providerResult.source,
    metadata: providerResult.metadata ?? null,
    diagnostics,
    segments: transcriptTimestamps ? (providerResult.segments ?? null) : null,
  }
}

const extractResourceKey = (url: string): string | null => {
  if (isYouTubeUrlInternal(url)) {
    return extractYouTubeVideoIdInternal(url)
  }
  return null
}

const selectProvider = (context: ProviderContext): ProviderModule => {
  const genericProviderModule = PROVIDERS.find((provider) => provider.id === GENERIC_PROVIDER_ID)

  const specializedProvider = PROVIDERS.find(
    (provider) => provider.id !== GENERIC_PROVIDER_ID && provider.canHandle(context)
  )
  if (specializedProvider) {
    return specializedProvider
  }

  if (genericProviderModule) {
    return genericProviderModule
  }

  throw new Error('Generic transcript provider is not registered')
}

const executeProvider = async (
  provider: ProviderModule,
  context: ProviderContext,
  options: ProviderFetchOptions
): Promise<ProviderResult> => provider.fetchTranscript(context, options)

const appendNote = (existing: string | null | undefined, next: string): string => {
  if (!existing) {
    return next
  }
  return `${existing}; ${next}`
}

const resolveSegmentsFromMetadata = (metadata?: Record<string, unknown> | null) => {
  if (!metadata) return null
  const segments = (metadata as { segments?: unknown }).segments
  return Array.isArray(segments) && segments.length > 0
    ? (segments as TranscriptResolution['segments'])
    : null
}
