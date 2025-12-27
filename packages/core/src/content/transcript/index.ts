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
  cacheMode?: CacheMode
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
  { youtubeTranscriptMode, cacheMode: providedCacheMode }: ResolveTranscriptOptions = {}
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
    scrapeWithFirecrawl: deps.scrapeWithFirecrawl,
    apifyApiToken: deps.apifyApiToken,
    ytDlpPath: deps.ytDlpPath,
    falApiKey: deps.falApiKey,
    openaiApiKey: deps.openaiApiKey,
    onProgress: deps.onProgress ?? null,
    youtubeTranscriptMode: youtubeTranscriptMode ?? 'auto',
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
    await writeTranscriptCache({
      url: normalizedUrl,
      service: provider.id,
      resourceKey,
      result: providerResult,
      transcriptCache: deps.transcriptCache,
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
    }
  }

  return {
    text: providerResult.text,
    source: providerResult.source,
    metadata: providerResult.metadata ?? null,
    diagnostics,
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
