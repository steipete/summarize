export type TranscriptSource =
  | 'youtubei'
  | 'captionTracks'
  | 'yt-dlp'
  | 'podcastTranscript'
  | 'whisper'
  | 'apify'
  | 'html'
  | 'unavailable'
  | 'unknown'

export const CACHE_MODES = ['default', 'bypass'] as const
export type CacheMode = (typeof CACHE_MODES)[number]

export type CacheStatus = 'hit' | 'miss' | 'expired' | 'bypassed' | 'fallback' | 'unknown'

export interface TranscriptDiagnostics {
  cacheMode: CacheMode
  cacheStatus: CacheStatus
  textProvided: boolean
  provider: TranscriptSource | null
  attemptedProviders: TranscriptSource[]
  notes?: string | null
}

export interface FirecrawlDiagnostics {
  attempted: boolean
  used: boolean
  cacheMode: CacheMode
  cacheStatus: CacheStatus
  notes?: string | null
}

export interface MarkdownDiagnostics {
  requested: boolean
  used: boolean
  provider: 'firecrawl' | 'llm' | null
  notes?: string | null
}

export interface ContentFetchDiagnostics {
  strategy: 'bird' | 'firecrawl' | 'html' | 'nitter'
  firecrawl: FirecrawlDiagnostics
  markdown: MarkdownDiagnostics
  transcript: TranscriptDiagnostics
}

export interface TranscriptResolution {
  text: string | null
  source: TranscriptSource | null
  metadata?: Record<string, unknown> | null
  diagnostics?: TranscriptDiagnostics
}
