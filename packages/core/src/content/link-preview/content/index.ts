import type { FirecrawlScrapeResult, LinkPreviewDeps } from '../deps.js'
import { resolveTranscriptForLink } from '../transcript/index.js'
import { isYouTubeUrl } from '../transcript/utils.js'
import type { FirecrawlDiagnostics } from '../types.js'
import { normalizeForPrompt } from './cleaner.js'
import { MIN_READABILITY_CONTENT_CHARACTERS } from './constants.js'
import { fetchHtmlDocument, fetchWithFirecrawl } from './fetcher.js'
import { buildResultFromFirecrawl, shouldFallbackToFirecrawl } from './firecrawl.js'
import { buildResultFromHtmlDocument } from './html.js'
import { extractApplePodcastIds, extractSpotifyEpisodeId } from './podcast-utils.js'
import { extractReadabilityFromHtml } from './readability.js'
import {
  isAnubisHtml,
  isBlockedTwitterContent,
  isTwitterStatusUrl,
  toNitterUrls,
} from './twitter-utils.js'
import type { ExtractedLinkContent, FetchLinkContentOptions, MarkdownMode } from './types.js'
import {
  appendNote,
  ensureTranscriptDiagnostics,
  finalizeExtractedLinkContent,
  resolveCacheMode,
  resolveFirecrawlMode,
  resolveMaxCharacters,
  resolveTimeoutMs,
  selectBaseContent,
} from './utils.js'

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
  const markdownMode: MarkdownMode = options?.markdownMode ?? 'auto'

  const canUseFirecrawl =
    firecrawlMode !== 'off' && deps.scrapeWithFirecrawl !== null && !isYouTubeUrl(url)

  const spotifyEpisodeId = extractSpotifyEpisodeId(url)
  if (spotifyEpisodeId) {
    if (!deps.openaiApiKey && !deps.falApiKey) {
      throw new Error(
        'Spotify episode transcription requires OPENAI_API_KEY or FAL_KEY (Whisper); otherwise you may only get a captcha/recaptcha HTML page.'
      )
    }

    const transcriptResolution = await resolveTranscriptForLink(url, null, deps, {
      youtubeTranscriptMode,
      cacheMode,
    })
    if (!transcriptResolution.text) {
      const notes = transcriptResolution.diagnostics?.notes
      const suffix = notes ? ` (${notes})` : ''
      throw new Error(`Failed to transcribe Spotify episode${suffix}`)
    }

    const transcriptDiagnostics = ensureTranscriptDiagnostics(
      transcriptResolution,
      cacheMode ?? 'default'
    )
    transcriptDiagnostics.notes = appendNote(
      transcriptDiagnostics.notes,
      'Spotify episode: skipped HTML fetch to avoid captcha pages'
    )

    return finalizeExtractedLinkContent({
      url,
      baseContent: selectBaseContent('', transcriptResolution.text),
      maxCharacters,
      title: null,
      description: null,
      siteName: 'Spotify',
      transcriptResolution,
      video: null,
      isVideoOnly: false,
      diagnostics: {
        strategy: 'html',
        firecrawl: {
          attempted: false,
          used: false,
          cacheMode,
          cacheStatus: cacheMode === 'bypass' ? 'bypassed' : 'unknown',
          notes: 'Spotify short-circuit skipped HTML/Firecrawl',
        },
        markdown: {
          requested: markdownRequested,
          used: false,
          provider: null,
          notes: 'Spotify short-circuit uses transcript content',
        },
        transcript: transcriptDiagnostics,
      },
    })
  }

  const appleIds = extractApplePodcastIds(url)
  if (appleIds) {
    if (!deps.openaiApiKey && !deps.falApiKey) {
      throw new Error(
        'Apple Podcasts transcription requires OPENAI_API_KEY or FAL_KEY (Whisper); otherwise you may only get a slow/blocked HTML page.'
      )
    }

    const transcriptResolution = await resolveTranscriptForLink(url, null, deps, {
      youtubeTranscriptMode,
      cacheMode,
    })
    if (!transcriptResolution.text) {
      const notes = transcriptResolution.diagnostics?.notes
      const suffix = notes ? ` (${notes})` : ''
      throw new Error(`Failed to transcribe Apple Podcasts episode${suffix}`)
    }

    const transcriptDiagnostics = ensureTranscriptDiagnostics(
      transcriptResolution,
      cacheMode ?? 'default'
    )
    transcriptDiagnostics.notes = appendNote(
      transcriptDiagnostics.notes,
      'Apple Podcasts: skipped HTML fetch (prefer iTunes lookup / enclosures)'
    )

    return finalizeExtractedLinkContent({
      url,
      baseContent: selectBaseContent('', transcriptResolution.text),
      maxCharacters,
      title: null,
      description: null,
      siteName: 'Apple Podcasts',
      transcriptResolution,
      video: null,
      isVideoOnly: false,
      diagnostics: {
        strategy: 'html',
        firecrawl: {
          attempted: false,
          used: false,
          cacheMode,
          cacheStatus: cacheMode === 'bypass' ? 'bypassed' : 'unknown',
          notes: 'Apple Podcasts short-circuit skipped HTML/Firecrawl',
        },
        markdown: {
          requested: markdownRequested,
          used: false,
          provider: null,
          notes: 'Apple Podcasts short-circuit uses transcript content',
        },
        transcript: transcriptDiagnostics,
      },
    })
  }

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
  const nitterUrls = twitterStatus ? toNitterUrls(url) : []
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
        video: null,
        isVideoOnly: false,
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
    if (nitterUrls.length === 0) {
      return null
    }
    for (const nitterUrl of nitterUrls) {
      deps.onProgress?.({ kind: 'nitter-start', url: nitterUrl })
      try {
        const nitterHtml = await fetchHtmlDocument(deps.fetch, nitterUrl, { timeoutMs })
        if (!nitterHtml.trim()) {
          nitterError = new Error(`Nitter returned empty body from ${new URL(nitterUrl).host}`)
          deps.onProgress?.({ kind: 'nitter-done', url: nitterUrl, ok: false, textBytes: null })
          continue
        }
        if (isAnubisHtml(nitterHtml)) {
          nitterError = new Error(
            `Nitter returned Anubis challenge from ${new URL(nitterUrl).host}`
          )
          deps.onProgress?.({ kind: 'nitter-done', url: nitterUrl, ok: false, textBytes: null })
          continue
        }
        deps.onProgress?.({
          kind: 'nitter-done',
          url: nitterUrl,
          ok: true,
          textBytes: Buffer.byteLength(nitterHtml, 'utf8'),
        })
        return nitterHtml
      } catch (error) {
        nitterError = error
        deps.onProgress?.({ kind: 'nitter-done', url: nitterUrl, ok: false, textBytes: null })
      }
    }
    return null
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
      markdownMode,
      timeoutMs,
      deps,
      readabilityCandidate: null,
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

  let readabilityCandidate: Awaited<ReturnType<typeof extractReadabilityFromHtml>> | null = null

  if (firecrawlMode === 'auto' && shouldFallbackToFirecrawl(html)) {
    readabilityCandidate = await extractReadabilityFromHtml(html, url)
    const readabilityText = readabilityCandidate?.text
      ? normalizeForPrompt(readabilityCandidate.text)
      : ''
    if (readabilityText.length < MIN_READABILITY_CONTENT_CHARACTERS) {
      const firecrawlResult = await attemptFirecrawl(
        'HTML content looked blocked/thin; falling back to Firecrawl'
      )
      if (firecrawlResult) {
        return firecrawlResult
      }
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
    markdownMode,
    timeoutMs,
    deps,
    readabilityCandidate,
  })
  if (twitterStatus && isBlockedTwitterContent(htmlResult.content)) {
    const birdNote = !deps.readTweetWithBird
      ? 'Bird not available'
      : birdError
        ? `Bird failed: ${birdError instanceof Error ? birdError.message : String(birdError)}`
        : 'Bird returned no text'
    const nitterNote =
      nitterUrls.length > 0
        ? nitterError
          ? `Nitter failed: ${nitterError instanceof Error ? nitterError.message : String(nitterError)}`
          : 'Nitter returned no text'
        : 'Nitter not available'
    throw new Error(`Unable to fetch tweet content from X. ${birdNote}. ${nitterNote}.`)
  }
  return htmlResult
}

export type { ExtractedLinkContent, FetchLinkContentOptions } from './types.js'
