import type { YoutubeTranscriptMode } from '../content/types.js'
import type { LinkPreviewProgressEvent, ScrapeWithFirecrawl } from '../deps.js'
import type { TranscriptResolution, TranscriptSource } from '../types.js'

export type TranscriptService = 'youtube' | 'podcast' | 'generic'

export interface ProviderContext {
  url: string
  html: string | null
  resourceKey: string | null
}

export interface ProviderFetchOptions {
  fetch: typeof fetch
  scrapeWithFirecrawl?: ScrapeWithFirecrawl | null
  apifyApiToken: string | null
  youtubeTranscriptMode: YoutubeTranscriptMode
  ytDlpPath: string | null
  falApiKey: string | null
  openaiApiKey: string | null
  onProgress?: ((event: LinkPreviewProgressEvent) => void) | null
}

export interface ProviderResult extends TranscriptResolution {
  metadata?: Record<string, unknown>
  attemptedProviders: TranscriptSource[]
  notes?: string | null
}

export interface ProviderModule {
  id: TranscriptService
  canHandle(context: ProviderContext): boolean
  fetchTranscript(context: ProviderContext, options: ProviderFetchOptions): Promise<ProviderResult>
}

export type { TranscriptSource } from '../types.js'
