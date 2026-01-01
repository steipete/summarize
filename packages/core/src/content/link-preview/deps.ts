import type { TranscriptCache } from '../cache/types.js'
import type { CacheMode, TranscriptSource } from './types.js'

// Enum-like constants for progress kinds (keeps call sites typo-resistant without TS `enum` runtime quirks).
export const ProgressKind = {
  FetchHtmlStart: 'fetch-html-start',
  FetchHtmlProgress: 'fetch-html-progress',
  FetchHtmlDone: 'fetch-html-done',

  TranscriptMediaDownloadStart: 'transcript-media-download-start',
  TranscriptMediaDownloadProgress: 'transcript-media-download-progress',
  TranscriptMediaDownloadDone: 'transcript-media-download-done',

  TranscriptWhisperStart: 'transcript-whisper-start',
  TranscriptWhisperProgress: 'transcript-whisper-progress',

  TranscriptStart: 'transcript-start',
  TranscriptDone: 'transcript-done',

  FirecrawlStart: 'firecrawl-start',
  FirecrawlDone: 'firecrawl-done',

  NitterStart: 'nitter-start',
  NitterDone: 'nitter-done',

  BirdStart: 'bird-start',
  BirdDone: 'bird-done',
} as const

/** Public progress events emitted by link preview fetchers. */
export type LinkPreviewProgressEvent =
  | { kind: 'fetch-html-start'; url: string }
  | {
      kind: 'fetch-html-progress'
      url: string
      downloadedBytes: number
      totalBytes: number | null
    }
  | {
      kind: 'fetch-html-done'
      url: string
      downloadedBytes: number
      totalBytes: number | null
    }
  | {
      kind: 'transcript-media-download-start'
      url: string
      service: 'youtube' | 'podcast' | 'generic'
      mediaUrl: string | null
      totalBytes: number | null
    }
  | {
      kind: 'transcript-media-download-progress'
      url: string
      service: 'youtube' | 'podcast' | 'generic'
      downloadedBytes: number
      totalBytes: number | null
    }
  | {
      kind: 'transcript-media-download-done'
      url: string
      service: 'youtube' | 'podcast' | 'generic'
      downloadedBytes: number
      totalBytes: number | null
    }
  | {
      kind: 'transcript-whisper-start'
      url: string
      service: 'youtube' | 'podcast' | 'generic'
      providerHint: 'cpp' | 'onnx' | 'openai' | 'fal' | 'openai->fal' | 'unknown'
      modelId: string | null
      totalDurationSeconds: number | null
      parts: number | null
    }
  | {
      kind: 'transcript-whisper-progress'
      url: string
      service: 'youtube' | 'podcast' | 'generic'
      processedDurationSeconds: number | null
      totalDurationSeconds: number | null
      partIndex: number | null
      parts: number | null
    }
  | {
      kind: 'transcript-start'
      url: string
      service: 'youtube' | 'podcast' | 'generic'
      hint: string | null
    }
  | {
      kind: 'transcript-done'
      url: string
      ok: boolean
      service: 'youtube' | 'podcast' | 'generic'
      source: TranscriptSource | null
      hint: string | null
    }
  | { kind: 'firecrawl-start'; url: string; reason: string }
  | {
      kind: 'firecrawl-done'
      url: string
      ok: boolean
      markdownBytes: number | null
      htmlBytes: number | null
    }
  | { kind: 'nitter-start'; url: string }
  | { kind: 'nitter-done'; url: string; ok: boolean; textBytes: number | null }
  | { kind: 'bird-start'; url: string }
  | { kind: 'bird-done'; url: string; ok: boolean; textBytes: number | null }

export interface FirecrawlScrapeResult {
  markdown: string
  html?: string | null
  metadata?: Record<string, unknown> | null
}

export type ScrapeWithFirecrawl = (
  url: string,
  options?: { cacheMode?: CacheMode; timeoutMs?: number }
) => Promise<FirecrawlScrapeResult | null>

export type ConvertHtmlToMarkdown = (args: {
  url: string
  html: string
  title: string | null
  siteName: string | null
  timeoutMs: number
}) => Promise<string>

export type BirdTweetPayload = {
  id?: string
  text: string
  author?: { username?: string; name?: string }
  createdAt?: string
}

export type ReadTweetWithBird = (args: {
  url: string
  timeoutMs: number
}) => Promise<BirdTweetPayload | null>

export type TwitterCookieSource = {
  cookiesFromBrowser: string | null
  source?: string | null
  warnings?: string[]
}

export type ResolveTwitterCookies = (args: { url: string }) => Promise<TwitterCookieSource>

/** Internal dependency bag; prefer createLinkPreviewClient unless you need custom wiring. */
export interface LinkPreviewDeps {
  fetch: typeof fetch
  scrapeWithFirecrawl: ScrapeWithFirecrawl | null
  apifyApiToken: string | null
  ytDlpPath: string | null
  falApiKey: string | null
  openaiApiKey: string | null
  convertHtmlToMarkdown: ConvertHtmlToMarkdown | null
  transcriptCache: TranscriptCache | null
  readTweetWithBird?: ReadTweetWithBird | null
  resolveTwitterCookies?: ResolveTwitterCookies | null
  onProgress?: ((event: LinkPreviewProgressEvent) => void) | null
}
