import type { CacheMode, TranscriptSource } from './types.js'

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
  | { kind: 'firecrawl-start'; url: string; reason: string }
  | {
      kind: 'firecrawl-done'
      url: string
      ok: boolean
      markdownBytes: number | null
      htmlBytes: number | null
    }

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

export interface TranscriptCacheGetResult {
  content: string | null
  source: TranscriptSource | null
  expired: boolean
  metadata?: Record<string, unknown> | null
}

export interface TranscriptCacheSetArgs {
  url: string
  service: string
  resourceKey: string | null
  content: string | null
  source: TranscriptSource | null
  ttlMs: number
  metadata?: Record<string, unknown> | null
}

export interface TranscriptCache {
  get(args: { url: string }): Promise<TranscriptCacheGetResult | null>
  set(args: TranscriptCacheSetArgs): Promise<void>
}

export interface LinkPreviewDeps {
  fetch: typeof fetch
  scrapeWithFirecrawl: ScrapeWithFirecrawl | null
  apifyApiToken: string | null
  ytDlpPath: string | null
  falApiKey: string | null
  convertHtmlToMarkdown: ConvertHtmlToMarkdown | null
  transcriptCache: TranscriptCache | null
  onProgress?: ((event: LinkPreviewProgressEvent) => void) | null
}
