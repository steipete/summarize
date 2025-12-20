import type { LinkPreviewDeps } from '../deps.js'
import type { CacheMode, TranscriptDiagnostics, TranscriptResolution } from '../types.js'
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
  const resourceKey = extractResourceKey(normalizedUrl)
  const baseContext: ProviderContext = { url: normalizedUrl, html, resourceKey }
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

  const providerResult = await executeProvider(provider, baseContext, {
    fetch: deps.fetch,
    apifyApiToken: deps.apifyApiToken,
    ytDlpPath: deps.ytDlpPath,
    falApiKey: deps.falApiKey,
    youtubeTranscriptMode: youtubeTranscriptMode ?? 'auto',
  })
  diagnostics.provider = providerResult.source
  diagnostics.attemptedProviders = providerResult.attemptedProviders
  diagnostics.textProvided = Boolean(providerResult.text && providerResult.text.length > 0)

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
      diagnostics,
    }
  }

  return {
    text: providerResult.text,
    source: providerResult.source,
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
