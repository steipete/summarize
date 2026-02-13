import { resolveTranscriptForLink } from '../../transcript/index.js'
import { resolveTranscriptionConfig } from '../../transcript/transcription-config.js'
import { isDirectMediaUrl, isYouTubeUrl } from '../../url.js'
import type { FirecrawlScrapeResult, LinkPreviewDeps } from '../deps.js'
import type { CacheMode, FirecrawlDiagnostics, TranscriptResolution } from '../types.js'
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
  isTwitterBroadcastUrl,
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

const MAX_TWITTER_TEXT_FOR_TRANSCRIPT = 500

const buildSkippedTwitterTranscript = (
  cacheMode: CacheMode,
  notes: string
): TranscriptResolution => ({
  text: null,
  source: null,
  diagnostics: {
    cacheMode,
    cacheStatus: cacheMode === 'bypass' ? 'bypassed' : 'unknown',
    textProvided: false,
    provider: null,
    attemptedProviders: [],
    notes,
  },
})

export async function fetchLinkContent(
  url: string,
  options: FetchLinkContentOptions | undefined,
  deps: LinkPreviewDeps
): Promise<ExtractedLinkContent> {
  const transcription = resolveTranscriptionConfig({
    env: deps.env,
    transcription: deps.transcription ?? null,
    falApiKey: deps.falApiKey,
    groqApiKey: deps.groqApiKey,
    openaiApiKey: deps.openaiApiKey,
  })
  const timeoutMs = resolveTimeoutMs(options)
  const cacheMode = resolveCacheMode(options)
  const maxCharacters = resolveMaxCharacters(options)
  const youtubeTranscriptMode = options?.youtubeTranscript ?? 'auto'
  const mediaTranscriptMode = options?.mediaTranscript ?? 'auto'
  const transcriptTimestamps = options?.transcriptTimestamps ?? false
  const firecrawlMode = resolveFirecrawlMode(options)
  const markdownRequested = (options?.format ?? 'text') === 'markdown'
  const markdownMode: MarkdownMode = options?.markdownMode ?? 'auto'
  const fileMtime = options?.fileMtime ?? null

  const canUseFirecrawl =
    firecrawlMode !== 'off' && deps.scrapeWithFirecrawl !== null && !isYouTubeUrl(url)

  const spotifyEpisodeId = extractSpotifyEpisodeId(url)
  if (spotifyEpisodeId) {
    if (!transcription.openaiApiKey && !transcription.falApiKey) {
      throw new Error(
        'Spotify episode transcription requires OPENAI_API_KEY or FAL_KEY (Whisper); otherwise you may only get a captcha/recaptcha HTML page.'
      )
    }

    const transcriptResolution = await resolveTranscriptForLink(url, null, deps, {
      youtubeTranscriptMode,
      mediaTranscriptMode,
      transcriptTimestamps,
      cacheMode,
      fileMtime,
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
      baseContent: selectBaseContent('', transcriptResolution.text, transcriptResolution.segments),
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
    if (!transcription.openaiApiKey && !transcription.falApiKey) {
      throw new Error(
        'Apple Podcasts transcription requires OPENAI_API_KEY or FAL_KEY (Whisper); otherwise you may only get a slow/blocked HTML page.'
      )
    }

    const transcriptResolution = await resolveTranscriptForLink(url, null, deps, {
      youtubeTranscriptMode,
      mediaTranscriptMode,
      transcriptTimestamps,
      cacheMode,
      fileMtime,
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
      baseContent: selectBaseContent('', transcriptResolution.text, transcriptResolution.segments),
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

  if (isTwitterBroadcastUrl(url)) {
    const broadcastTranscriptMode = mediaTranscriptMode === 'auto' ? 'prefer' : mediaTranscriptMode
    const transcriptResolution = await resolveTranscriptForLink(url, null, deps, {
      youtubeTranscriptMode,
      mediaTranscriptMode: broadcastTranscriptMode,
      transcriptTimestamps,
      cacheMode,
      fileMtime,
    })
    if (!transcriptResolution.text) {
      const notes = transcriptResolution.diagnostics?.notes
      const suffix = notes ? ` (${notes})` : ''
      throw new Error(`Failed to transcribe X broadcast${suffix}`)
    }

    const transcriptDiagnostics = ensureTranscriptDiagnostics(
      transcriptResolution,
      cacheMode ?? 'default'
    )
    transcriptDiagnostics.notes = appendNote(
      transcriptDiagnostics.notes,
      'X broadcast: skipped HTML/Firecrawl'
    )

    return finalizeExtractedLinkContent({
      url,
      baseContent: selectBaseContent('', transcriptResolution.text, transcriptResolution.segments),
      maxCharacters,
      title: null,
      description: null,
      siteName: 'X',
      transcriptResolution,
      video: { kind: 'direct', url },
      isVideoOnly: true,
      diagnostics: {
        strategy: 'html',
        firecrawl: {
          attempted: false,
          used: false,
          cacheMode,
          cacheStatus: cacheMode === 'bypass' ? 'bypassed' : 'unknown',
          notes: 'X broadcast short-circuit skipped HTML/Firecrawl',
        },
        markdown: {
          requested: markdownRequested,
          used: false,
          provider: null,
          notes: 'X broadcast uses transcript content',
        },
        transcript: transcriptDiagnostics,
      },
    })
  }

  if (isDirectMediaUrl(url) && mediaTranscriptMode === 'prefer') {
    const transcriptResolution = await resolveTranscriptForLink(url, null, deps, {
      youtubeTranscriptMode,
      mediaTranscriptMode,
      transcriptTimestamps,
      cacheMode,
      fileMtime,
    })
    if (!transcriptResolution.text) {
      const notes = transcriptResolution.diagnostics?.notes
      const suffix = notes ? ` (${notes})` : ''
      throw new Error(`Failed to transcribe media${suffix}`)
    }

    const transcriptDiagnostics = ensureTranscriptDiagnostics(
      transcriptResolution,
      cacheMode ?? 'default'
    )
    transcriptDiagnostics.notes = appendNote(
      transcriptDiagnostics.notes,
      'Direct media URL: skipped HTML/Firecrawl'
    )

    return finalizeExtractedLinkContent({
      url,
      baseContent: selectBaseContent('', transcriptResolution.text, transcriptResolution.segments),
      maxCharacters,
      title: null,
      description: null,
      siteName: null,
      transcriptResolution,
      video: { kind: 'direct', url },
      isVideoOnly: true,
      diagnostics: {
        strategy: 'html',
        firecrawl: {
          attempted: false,
          used: false,
          cacheMode,
          cacheStatus: cacheMode === 'bypass' ? 'bypassed' : 'unknown',
          notes: 'Direct media URL skipped HTML/Firecrawl',
        },
        markdown: {
          requested: markdownRequested,
          used: false,
          provider: null,
          notes: 'Direct media URL uses transcript content',
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
      mediaTranscriptMode,
      transcriptTimestamps,
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
      const media = tweet?.media ?? null
      const mediaUrl = media?.preferredUrl ?? media?.urls?.[0] ?? null
      const hasMedia = Boolean(mediaUrl)
      const shouldAttemptTranscript =
        mediaTranscriptMode === 'prefer' || (mediaTranscriptMode === 'auto' && hasMedia)
      const autoModeNote = !shouldAttemptTranscript
        ? 'Skipped tweet transcript (media transcript mode is auto; enable --video-mode transcript to force audio).'
        : null
      const longFormNote =
        !hasMedia && text.length >= MAX_TWITTER_TEXT_FOR_TRANSCRIPT
          ? `Skipped yt-dlp transcript for long-form tweet text (${text.length} chars)`
          : null
      const skipTranscriptReason = [autoModeNote, longFormNote].filter(Boolean).join(' ') || null
      const mediaTranscriptModeForTweet = shouldAttemptTranscript ? 'prefer' : mediaTranscriptMode
      const transcriptResolution = skipTranscriptReason
        ? buildSkippedTwitterTranscript(cacheMode, skipTranscriptReason)
        : await resolveTranscriptForLink(url, null, deps, {
            youtubeTranscriptMode,
            mediaTranscriptMode: mediaTranscriptModeForTweet,
            mediaKindHint: media?.kind ?? null,
            transcriptTimestamps,
            cacheMode,
            fileMtime,
          })
      const transcriptDiagnostics = ensureTranscriptDiagnostics(
        transcriptResolution,
        cacheMode ?? 'default'
      )
      const result = finalizeExtractedLinkContent({
        url,
        baseContent: selectBaseContent(
          text,
          transcriptResolution.text,
          transcriptResolution.segments
        ),
        maxCharacters,
        title,
        description,
        siteName,
        transcriptResolution,
        video:
          mediaUrl && media?.kind === 'video'
            ? {
                kind: 'direct',
                url: mediaUrl,
              }
            : null,
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
        const nitterResult = await fetchHtmlDocument(deps.fetch, nitterUrl, { timeoutMs })
        const nitterHtml = nitterResult.html
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
      mediaTranscriptMode,
      transcriptTimestamps,
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

  let htmlResult: { html: string; finalUrl: string } | null = null
  let htmlError: unknown = null

  try {
    htmlResult = await fetchHtmlDocument(deps.fetch, url, {
      timeoutMs,
      onProgress: deps.onProgress ?? null,
    })
  } catch (error) {
    htmlError = error
  }

  if (!htmlResult) {
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

  const html = htmlResult.html
  const effectiveUrl = htmlResult.finalUrl || url
  let readabilityCandidate: Awaited<ReturnType<typeof extractReadabilityFromHtml>> | null = null

  if (firecrawlMode === 'auto' && shouldFallbackToFirecrawl(html)) {
    readabilityCandidate = await extractReadabilityFromHtml(html, effectiveUrl)
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

  const htmlExtracted = await buildResultFromHtmlDocument({
    url: effectiveUrl,
    html,
    cacheMode,
    maxCharacters,
    youtubeTranscriptMode,
    mediaTranscriptMode,
    transcriptTimestamps,
    firecrawlDiagnostics,
    markdownRequested,
    markdownMode,
    timeoutMs,
    deps,
    readabilityCandidate,
  })
  if (twitterStatus && isBlockedTwitterContent(htmlExtracted.content)) {
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
  return htmlExtracted
}

export type { ExtractedLinkContent, FetchLinkContentOptions } from './types.js'
