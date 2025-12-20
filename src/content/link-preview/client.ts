import { fetchLinkContent } from './content/index.js'
import type { ExtractedLinkContent, FetchLinkContentOptions } from './content/types.js'
import type {
  ConvertHtmlToMarkdown,
  LinkPreviewProgressEvent,
  ScrapeWithFirecrawl,
  TranscriptCache,
} from './deps.js'

export interface LinkPreviewClient {
  fetchLinkContent(url: string, options?: FetchLinkContentOptions): Promise<ExtractedLinkContent>
}

export interface LinkPreviewClientOptions {
  fetch?: typeof fetch
  scrapeWithFirecrawl?: ScrapeWithFirecrawl | null
  apifyApiToken?: string | null
  ytDlpPath?: string | null
  falApiKey?: string | null
  convertHtmlToMarkdown?: ConvertHtmlToMarkdown | null
  transcriptCache?: TranscriptCache | null
  onProgress?: ((event: LinkPreviewProgressEvent) => void) | null
}

export function createLinkPreviewClient(options: LinkPreviewClientOptions = {}): LinkPreviewClient {
  const fetchImpl: typeof fetch =
    options.fetch ?? ((...args: Parameters<typeof fetch>) => globalThis.fetch(...args))
  const scrape: ScrapeWithFirecrawl | null = options.scrapeWithFirecrawl ?? null
  const apifyApiToken = typeof options.apifyApiToken === 'string' ? options.apifyApiToken : null
  const ytDlpPath = typeof options.ytDlpPath === 'string' ? options.ytDlpPath : null
  const falApiKey = typeof options.falApiKey === 'string' ? options.falApiKey : null
  const convertHtmlToMarkdown: ConvertHtmlToMarkdown | null = options.convertHtmlToMarkdown ?? null
  const transcriptCache: TranscriptCache | null = options.transcriptCache ?? null
  const onProgress = typeof options.onProgress === 'function' ? options.onProgress : null

  return {
    fetchLinkContent: (url: string, contentOptions?: FetchLinkContentOptions) =>
      fetchLinkContent(url, contentOptions, {
        fetch: fetchImpl,
        scrapeWithFirecrawl: scrape,
        apifyApiToken,
        ytDlpPath,
        falApiKey,
        convertHtmlToMarkdown,
        transcriptCache,
        onProgress,
      }),
  }
}
