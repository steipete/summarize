import type { FirecrawlScrapeResult, LinkPreviewDeps } from '../deps.js'
import { resolveTranscriptForLink } from '../transcript/index.js'
import { extractYouTubeVideoId, isYouTubeUrl, isYouTubeVideoUrl } from '../transcript/utils.js'
import type { FirecrawlDiagnostics, MarkdownDiagnostics } from '../types.js'
import {
  extractArticleContent,
  extractPlainText,
  sanitizeHtmlForMarkdownConversion,
} from './article.js'
import { normalizeForPrompt } from './cleaner.js'
import { fetchHtmlDocument, fetchWithFirecrawl } from './fetcher.js'
import { extractMetadataFromFirecrawl, extractMetadataFromHtml } from './parsers.js'
import type { ExtractedLinkContent, FetchLinkContentOptions } from './types.js'
import {
  appendNote,
  ensureTranscriptDiagnostics,
  finalizeExtractedLinkContent,
  pickFirstText,
  resolveCacheMode,
  resolveFirecrawlMode,
  resolveMaxCharacters,
  resolveTimeoutMs,
  safeHostname,
  selectBaseContent,
} from './utils.js'
import { extractYouTubeShortDescription } from './youtube.js'

const LEADING_CONTROL_PATTERN = /^[\\s\\p{Cc}]+/u
const BLOCKED_HTML_HINT_PATTERN =
  /access denied|attention required|captcha|cloudflare|enable javascript|forbidden|please turn javascript on|verify you are human/i
const TWITTER_BLOCKED_TEXT_PATTERN =
  /something went wrong|try again|privacy related extensions|please disable them and try again/i
const MIN_HTML_CONTENT_CHARACTERS = 200
const MIN_HTML_DOCUMENT_CHARACTERS_FOR_FALLBACK = 5000
const TWITTER_HOSTS = new Set(['x.com', 'twitter.com', 'mobile.twitter.com'])
const NITTER_HOST = 'nitter.net'

function stripLeadingTitle(content: string, title: string | null | undefined): string {
  if (!(content && title)) {
    return content
  }

  const normalizedTitle = title.trim()
  if (normalizedTitle.length === 0) {
    return content
  }

  const trimmedContent = content.trimStart()
  if (!trimmedContent.toLowerCase().startsWith(normalizedTitle.toLowerCase())) {
    return content
  }

  const remainderOriginal = trimmedContent.slice(normalizedTitle.length)
  const remainder = remainderOriginal.replace(LEADING_CONTROL_PATTERN, '')
  return remainder
}

function shouldFallbackToFirecrawl(html: string): boolean {
  const plainText = normalizeForPrompt(extractPlainText(html))
  if (BLOCKED_HTML_HINT_PATTERN.test(plainText)) return true
  const normalized = normalizeForPrompt(extractArticleContent(html))
  if (normalized.length >= MIN_HTML_CONTENT_CHARACTERS) {
    return false
  }

  // Avoid spending Firecrawl on truly small/simple pages where the extracted HTML content is short but
  // likely complete (e.g. https://example.com). Only treat "thin" content as a Firecrawl signal when
  // the HTML document itself is large (SSR/app-shell pages, blocked pages without a match, etc.).
  return html.length >= MIN_HTML_DOCUMENT_CHARACTERS_FOR_FALLBACK
}

function isTwitterStatusUrl(url: string): boolean {
  try {
    const parsed = new URL(url)
    const host = parsed.hostname.toLowerCase().replace(/^www\./, '')
    if (!TWITTER_HOSTS.has(host)) return false
    return /\/status\/\d+/.test(parsed.pathname)
  } catch {
    return false
  }
}

function toNitterUrl(url: string): string | null {
  try {
    const parsed = new URL(url)
    const host = parsed.hostname.toLowerCase().replace(/^www\./, '')
    if (!TWITTER_HOSTS.has(host)) return null
    parsed.hostname = NITTER_HOST
    parsed.protocol = 'https:'
    return parsed.toString()
  } catch {
    return null
  }
}

function isBlockedTwitterContent(content: string): boolean {
  if (!content) return false
  return TWITTER_BLOCKED_TEXT_PATTERN.test(content)
}

export async function fetchLinkContent(
  url: string,
  options: FetchLinkContentOptions | undefined,
  deps: LinkPreviewDeps
): Promise<ExtractedLinkContent> {
  const timeoutMs = resolveTimeoutMs(options)
  const cacheMode = resolveCacheMode(options)
  const maxCharacters = resolveMaxCharacters(options)
  const youtubeTranscriptMode = options?.youtubeTranscript ?? 'auto'
  const firecrawlMode = resolveFirecrawlMode(options)
  const markdownRequested = (options?.format ?? 'text') === 'markdown'

  const canUseFirecrawl =
    firecrawlMode !== 'off' && deps.scrapeWithFirecrawl !== null && !isYouTubeUrl(url)

  let firecrawlAttempted = false
  let firecrawlPayload: FirecrawlScrapeResult | null = null
  const firecrawlDiagnostics: FirecrawlDiagnostics = {
    attempted: false,
    used: false,
    cacheMode,
    cacheStatus: cacheMode === 'bypass' ? 'bypassed' : 'unknown',
    notes: null,
  }

  const twitterStatus = isTwitterStatusUrl(url)
  const nitterUrl = twitterStatus ? toNitterUrl(url) : null
  let birdError: unknown = null
  let nitterError: unknown = null

  const attemptFirecrawl = async (reason: string): Promise<ExtractedLinkContent | null> => {
    if (!canUseFirecrawl) {
      return null
    }

    if (!firecrawlAttempted) {
      const attempt = await fetchWithFirecrawl(url, deps.scrapeWithFirecrawl, {
        timeoutMs,
        cacheMode,
        onProgress: deps.onProgress ?? null,
        reason,
      })
      firecrawlAttempted = true
      firecrawlPayload = attempt.payload
      firecrawlDiagnostics.attempted = attempt.diagnostics.attempted
      firecrawlDiagnostics.used = attempt.diagnostics.used
      firecrawlDiagnostics.cacheMode = attempt.diagnostics.cacheMode
      firecrawlDiagnostics.cacheStatus = attempt.diagnostics.cacheStatus
      firecrawlDiagnostics.notes = attempt.diagnostics.notes ?? null
    }

    firecrawlDiagnostics.notes = appendNote(firecrawlDiagnostics.notes, reason)

    if (!firecrawlPayload) {
      return null
    }

    const firecrawlResult = await buildResultFromFirecrawl({
      url,
      payload: firecrawlPayload,
      cacheMode,
      maxCharacters,
      youtubeTranscriptMode,
      firecrawlDiagnostics,
      markdownRequested,
      deps,
    })
    if (firecrawlResult) {
      return firecrawlResult
    }

    firecrawlDiagnostics.notes = appendNote(
      firecrawlDiagnostics.notes,
      'Firecrawl returned empty content'
    )
    return null
  }

  const attemptBird = async (): Promise<ExtractedLinkContent | null> => {
    if (!deps.readTweetWithBird || !twitterStatus) {
      return null
    }

    deps.onProgress?.({ kind: 'bird-start', url })
    try {
      const tweet = await deps.readTweetWithBird({ url, timeoutMs })
      const text = tweet?.text?.trim() ?? ''
      if (text.length === 0) {
        deps.onProgress?.({ kind: 'bird-done', url, ok: false, textBytes: null })
        return null
      }

      const title = tweet?.author?.username ? `@${tweet.author.username}` : null
      const description = null
      const siteName = 'X'
      const transcriptResolution = { text: null, source: null }
      const transcriptDiagnostics = ensureTranscriptDiagnostics(
        transcriptResolution,
        cacheMode ?? 'default'
      )
      const result = finalizeExtractedLinkContent({
        url,
        baseContent: text,
        maxCharacters,
        title,
        description,
        siteName,
        transcriptResolution,
        diagnostics: {
          strategy: 'bird',
          firecrawl: firecrawlDiagnostics,
          markdown: {
            requested: markdownRequested,
            used: false,
            provider: null,
            notes: 'Bird tweet fetch provides plain text',
          },
          transcript: transcriptDiagnostics,
        },
      })
      deps.onProgress?.({
        kind: 'bird-done',
        url,
        ok: true,
        textBytes: Buffer.byteLength(result.content, 'utf8'),
      })
      return result
    } catch (error) {
      birdError = error
      deps.onProgress?.({ kind: 'bird-done', url, ok: false, textBytes: null })
      return null
    }
  }

  const birdResult = await attemptBird()
  if (birdResult) {
    return birdResult
  }

  const attemptNitter = async (): Promise<string | null> => {
    if (!nitterUrl) {
      return null
    }
    deps.onProgress?.({ kind: 'nitter-start', url })
    try {
      const nitterHtml = await fetchHtmlDocument(deps.fetch, nitterUrl, { timeoutMs })
      deps.onProgress?.({
        kind: 'nitter-done',
        url,
        ok: true,
        textBytes: Buffer.byteLength(nitterHtml, 'utf8'),
      })
      return nitterHtml
    } catch (error) {
      nitterError = error
      deps.onProgress?.({ kind: 'nitter-done', url, ok: false, textBytes: null })
      return null
    }
  }

  const nitterHtml = await attemptNitter()
  if (nitterHtml) {
    const nitterResult = await buildResultFromHtmlDocument({
      url,
      html: nitterHtml,
      cacheMode,
      maxCharacters,
      youtubeTranscriptMode,
      firecrawlDiagnostics,
      markdownRequested,
      timeoutMs,
      deps,
    })
    if (!isBlockedTwitterContent(nitterResult.content)) {
      nitterResult.diagnostics.strategy = 'nitter'
      return nitterResult
    }
    nitterError = new Error('Nitter returned blocked or empty content')
  }

  if (firecrawlMode === 'always') {
    const firecrawlResult = await attemptFirecrawl('Firecrawl forced via options')
    if (firecrawlResult) {
      return firecrawlResult
    }
  }

  let html: string | null = null
  let htmlError: unknown = null

  try {
    html = await fetchHtmlDocument(deps.fetch, url, {
      timeoutMs,
      onProgress: deps.onProgress ?? null,
    })
  } catch (error) {
    htmlError = error
  }

  if (!html) {
    if (!canUseFirecrawl) {
      throw htmlError instanceof Error ? htmlError : new Error('Failed to fetch HTML document')
    }

    const firecrawlResult = await attemptFirecrawl('HTML fetch failed; falling back to Firecrawl')
    if (firecrawlResult) {
      return firecrawlResult
    }

    const firecrawlError = firecrawlDiagnostics.notes
      ? `; Firecrawl notes: ${firecrawlDiagnostics.notes}`
      : ''
    throw new Error(
      `Failed to fetch HTML document${firecrawlError}${
        htmlError instanceof Error ? `; HTML error: ${htmlError.message}` : ''
      }`
    )
  }

  if (firecrawlMode === 'auto' && shouldFallbackToFirecrawl(html)) {
    const firecrawlResult = await attemptFirecrawl(
      'HTML content looked blocked/thin; falling back to Firecrawl'
    )
    if (firecrawlResult) {
      return firecrawlResult
    }
  }

  const htmlResult = await buildResultFromHtmlDocument({
    url,
    html,
    cacheMode,
    maxCharacters,
    youtubeTranscriptMode,
    firecrawlDiagnostics,
    markdownRequested,
    timeoutMs,
    deps,
  })
  if (twitterStatus && isBlockedTwitterContent(htmlResult.content)) {
    const birdNote = !deps.readTweetWithBird
      ? 'Bird not available'
      : birdError
        ? `Bird failed: ${birdError instanceof Error ? birdError.message : String(birdError)}`
        : 'Bird returned no text'
    const nitterNote = nitterUrl
      ? nitterError
        ? `Nitter failed: ${nitterError instanceof Error ? nitterError.message : String(nitterError)}`
        : 'Nitter returned no text'
      : 'Nitter not available'
    throw new Error(`Unable to fetch tweet content from X. ${birdNote}. ${nitterNote}.`)
  }
  return htmlResult
}

async function buildResultFromFirecrawl({
  url,
  payload,
  cacheMode,
  maxCharacters,
  youtubeTranscriptMode,
  firecrawlDiagnostics,
  markdownRequested,
  deps,
}: {
  url: string
  payload: FirecrawlScrapeResult
  cacheMode: FetchLinkContentOptions['cacheMode']
  maxCharacters: number | null
  youtubeTranscriptMode: FetchLinkContentOptions['youtubeTranscript']
  firecrawlDiagnostics: FirecrawlDiagnostics
  markdownRequested: boolean
  deps: LinkPreviewDeps
}): Promise<ExtractedLinkContent | null> {
  const normalizedMarkdown = normalizeForPrompt(payload.markdown ?? '')
  if (normalizedMarkdown.length === 0) {
    firecrawlDiagnostics.notes = appendNote(
      firecrawlDiagnostics.notes,
      'Firecrawl markdown normalization yielded empty text'
    )
    return null
  }

  const transcriptResolution = await resolveTranscriptForLink(url, payload.html ?? null, deps, {
    youtubeTranscriptMode,
    cacheMode,
  })
  const baseContent = selectBaseContent(normalizedMarkdown, transcriptResolution.text)
  if (baseContent.length === 0) {
    firecrawlDiagnostics.notes = appendNote(
      firecrawlDiagnostics.notes,
      'Firecrawl produced content that normalized to an empty string'
    )
    return null
  }

  const htmlMetadata = payload.html
    ? extractMetadataFromHtml(payload.html, url)
    : { title: null, description: null, siteName: null }
  const metadata = extractMetadataFromFirecrawl(payload.metadata ?? null)

  const title = pickFirstText([metadata.title, htmlMetadata.title])
  const description = pickFirstText([metadata.description, htmlMetadata.description])
  const siteName = pickFirstText([metadata.siteName, htmlMetadata.siteName, safeHostname(url)])

  firecrawlDiagnostics.used = true

  const transcriptDiagnostics = ensureTranscriptDiagnostics(
    transcriptResolution,
    cacheMode ?? 'default'
  )

  return finalizeExtractedLinkContent({
    url,
    baseContent,
    maxCharacters,
    title,
    description,
    siteName,
    transcriptResolution,
    diagnostics: {
      strategy: 'firecrawl',
      firecrawl: firecrawlDiagnostics,
      markdown: {
        requested: markdownRequested,
        used: true,
        provider: 'firecrawl',
      },
      transcript: transcriptDiagnostics,
    },
  })
}

async function buildResultFromHtmlDocument({
  url,
  html,
  cacheMode,
  maxCharacters,
  youtubeTranscriptMode,
  firecrawlDiagnostics,
  markdownRequested,
  timeoutMs,
  deps,
}: {
  url: string
  html: string
  cacheMode: FetchLinkContentOptions['cacheMode']
  maxCharacters: number | null
  youtubeTranscriptMode: FetchLinkContentOptions['youtubeTranscript']
  firecrawlDiagnostics: FirecrawlDiagnostics
  markdownRequested: boolean
  timeoutMs: number
  deps: LinkPreviewDeps
}): Promise<ExtractedLinkContent> {
  if (isYouTubeVideoUrl(url) && !extractYouTubeVideoId(url)) {
    throw new Error('Invalid YouTube video id in URL')
  }

  const { title, description, siteName } = extractMetadataFromHtml(html, url)
  const rawContent = extractArticleContent(html)
  const normalized = normalizeForPrompt(rawContent)
  const transcriptResolution = await resolveTranscriptForLink(url, html, deps, {
    youtubeTranscriptMode,
    cacheMode,
  })

  const youtubeDescription =
    transcriptResolution.text === null ? extractYouTubeShortDescription(html) : null
  const baseCandidate = youtubeDescription ? normalizeForPrompt(youtubeDescription) : normalized

  let baseContent = selectBaseContent(baseCandidate, transcriptResolution.text)
  if (baseContent === normalized) {
    baseContent = stripLeadingTitle(baseContent, title)
  }

  const transcriptDiagnostics = ensureTranscriptDiagnostics(
    transcriptResolution,
    cacheMode ?? 'default'
  )

  const markdownDiagnostics: MarkdownDiagnostics = await (async () => {
    if (!markdownRequested) {
      return { requested: false, used: false, provider: null, notes: null }
    }

    if (isYouTubeUrl(url)) {
      return {
        requested: true,
        used: false,
        provider: null,
        notes: 'Skipping Markdown conversion for YouTube URLs',
      }
    }

    if (!deps.convertHtmlToMarkdown) {
      return {
        requested: true,
        used: false,
        provider: null,
        notes: 'No HTML→Markdown converter configured',
      }
    }

    try {
      const sanitizedHtml = sanitizeHtmlForMarkdownConversion(html)
      const markdown = await deps.convertHtmlToMarkdown({
        url,
        html: sanitizedHtml,
        title,
        siteName,
        timeoutMs,
      })
      const normalizedMarkdown = normalizeForPrompt(markdown)
      if (normalizedMarkdown.length === 0) {
        return {
          requested: true,
          used: false,
          provider: null,
          notes: 'HTML→Markdown conversion returned empty content',
        }
      }

      baseContent = normalizedMarkdown
      return { requested: true, used: true, provider: 'llm', notes: null }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return {
        requested: true,
        used: false,
        provider: null,
        notes: `HTML→Markdown conversion failed: ${message}`,
      }
    }
  })()

  return finalizeExtractedLinkContent({
    url,
    baseContent,
    maxCharacters,
    title,
    description,
    siteName,
    transcriptResolution,
    diagnostics: {
      strategy: 'html',
      firecrawl: firecrawlDiagnostics,
      markdown: markdownDiagnostics,
      transcript: transcriptDiagnostics,
    },
  })
}

export type { ExtractedLinkContent, FetchLinkContentOptions } from './types.js'
