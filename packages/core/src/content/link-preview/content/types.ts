import type {
  CacheMode,
  ContentFetchDiagnostics,
  TranscriptDiagnostics,
  TranscriptSegment,
  TranscriptSource,
} from '../types.js'

export const DEFAULT_TIMEOUT_MS = 120_000
export const DEFAULT_MAX_CONTENT_CHARACTERS = 8000
export const DEFAULT_CACHE_MODE: CacheMode = 'default'
export type YoutubeTranscriptMode = 'auto' | 'web' | 'apify' | 'yt-dlp' | 'no-auto'
export type MediaTranscriptMode = 'auto' | 'prefer'
export type FirecrawlMode = 'off' | 'auto' | 'always'
export type ContentFormat = 'text' | 'markdown'
export type MarkdownMode = 'off' | 'auto' | 'llm' | 'readability'

export interface FetchLinkContentOptions {
  timeoutMs?: number
  maxCharacters?: number
  cacheMode?: CacheMode
  youtubeTranscript?: YoutubeTranscriptMode
  mediaTranscript?: MediaTranscriptMode
  transcriptTimestamps?: boolean
  firecrawl?: FirecrawlMode
  format?: ContentFormat
  markdownMode?: MarkdownMode
  fileMtime?: number | null
}

export interface TranscriptResolution {
  diagnostics?: TranscriptDiagnostics
  source: TranscriptSource | null
  text: string | null
  metadata?: Record<string, unknown> | null
  segments?: TranscriptSegment[] | null
}

export interface ExtractedLinkContent {
  url: string
  title: string | null
  description: string | null
  siteName: string | null
  content: string
  truncated: boolean
  totalCharacters: number
  wordCount: number
  transcriptCharacters: number | null
  transcriptLines: number | null
  transcriptWordCount: number | null
  transcriptSource: TranscriptSource | null
  transcriptionProvider: string | null
  transcriptMetadata: Record<string, unknown> | null
  transcriptSegments: TranscriptSegment[] | null
  transcriptTimedText: string | null
  mediaDurationSeconds: number | null
  video: { kind: 'youtube' | 'direct'; url: string } | null
  isVideoOnly: boolean
  diagnostics: ContentFetchDiagnostics
}

export interface FinalizationArguments {
  url: string
  baseContent: string
  maxCharacters: number | null
  title: string | null
  description: string | null
  siteName: string | null
  transcriptResolution: TranscriptResolution
  video: { kind: 'youtube' | 'direct'; url: string } | null
  isVideoOnly: boolean
  diagnostics: ContentFetchDiagnostics
}
