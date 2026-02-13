import { isDirectMediaUrl } from '../../url.js'
import { resolveTranscriptionConfig } from '../transcription-config.js'
import type { ProviderContext, ProviderFetchOptions, ProviderResult } from '../types.js'
import {
  fetchAppleTranscriptFromEmbeddedHtml,
  fetchAppleTranscriptFromItunesLookup,
} from './podcast/apple-flow.js'
import { FEED_HINT_URL_PATTERN, PODCAST_PLATFORM_HOST_PATTERN } from './podcast/constants.js'
import type { PodcastFlowContext } from './podcast/flow-context.js'
import { resolvePodcastFeedUrlFromItunesSearch } from './podcast/itunes.js'
import {
  downloadCappedBytes,
  downloadToFile,
  filenameFromUrl,
  formatBytes,
  normalizeHeaderType,
  parseContentLength,
  probeRemoteMedia,
  type TranscribeRequest,
  type TranscriptionResult,
  transcribeMediaUrl,
} from './podcast/media.js'
import { buildWhisperResult, joinNotes } from './podcast/results.js'
import {
  decodeXmlEntities,
  extractEnclosureForEpisode,
  extractEnclosureFromFeed,
  extractItemDurationSeconds,
  looksLikeRssOrAtomFeed,
  tryFetchTranscriptFromFeedXml,
} from './podcast/rss.js'
import { looksLikeBlockedHtml } from './podcast/spotify.js'
import { fetchSpotifyTranscript } from './podcast/spotify-flow.js'
import { resolveTranscriptionAvailability } from './transcription-start.js'

export const canHandle = ({ url, html }: ProviderContext): boolean => {
  // Direct media URLs (e.g., .mp3, .wav) should be handled by the generic provider
  // even if the URL contains "podcast" in the path (like "rt_podcast996.mp3")
  if (isDirectMediaUrl(url)) return false
  if (typeof html === 'string' && looksLikeRssOrAtomFeed(html)) return true
  if (PODCAST_PLATFORM_HOST_PATTERN.test(url)) return true
  return FEED_HINT_URL_PATTERN.test(url)
}

export const fetchTranscript = async (
  context: ProviderContext,
  options: ProviderFetchOptions
): Promise<ProviderResult> => {
  const attemptedProviders: ProviderResult['attemptedProviders'] = []
  const notes: string[] = []
  const transcription = resolveTranscriptionConfig(options)

  const pushOnce = (provider: ProviderResult['attemptedProviders'][number]) => {
    if (!attemptedProviders.includes(provider)) attemptedProviders.push(provider)
  }

  const transcriptionAvailability = await resolveTranscriptionAvailability({
    transcription,
  })

  const missingTranscriptionProviderResult = (): ProviderResult => ({
    text: null,
    source: null,
    attemptedProviders,
    metadata: { provider: 'podcast', reason: 'missing_transcription_keys' },
    notes: 'Missing transcription provider (install whisper-cpp or set OPENAI_API_KEY/FAL_KEY)',
  })

  const ensureTranscriptionProvider = (): ProviderResult | null => {
    return !transcriptionAvailability.hasAnyProvider ? missingTranscriptionProviderResult() : null
  }

  const progress = {
    url: context.url,
    service: 'podcast' as const,
    onProgress: options.onProgress ?? null,
  }

  const transcribe = (request: TranscribeRequest): Promise<TranscriptionResult> =>
    transcribeMediaUrl({
      fetchImpl: options.fetch,
      transcription,
      notes,
      progress,
      ...request,
    })

  const flow: PodcastFlowContext = {
    context,
    options,
    attemptedProviders,
    notes,
    pushOnce,
    ensureTranscriptionProvider,
    transcribe,
  }

  const feedHtml = typeof context.html === 'string' ? context.html : null
  if (feedHtml && /podcast:transcript/i.test(feedHtml)) {
    pushOnce('podcastTranscript')
    const direct = await tryFetchTranscriptFromFeedXml({
      fetchImpl: options.fetch,
      feedXml: feedHtml,
      episodeTitle: null,
      notes,
    })
    if (direct) {
      return {
        text: direct.text,
        source: 'podcastTranscript',
        segments: options.transcriptTimestamps ? (direct.segments ?? null) : null,
        attemptedProviders,
        notes: joinNotes(notes),
        metadata: {
          provider: 'podcast',
          kind: 'rss_podcast_transcript',
          transcriptUrl: direct.transcriptUrl,
          transcriptType: direct.transcriptType,
        },
      }
    }
  }

  const spotifyResult = await fetchSpotifyTranscript(flow)
  if (spotifyResult) return spotifyResult

  const appleLookupResult = await fetchAppleTranscriptFromItunesLookup(flow)
  if (appleLookupResult) return appleLookupResult

  const appleEmbeddedResult = await fetchAppleTranscriptFromEmbeddedHtml(flow)
  if (appleEmbeddedResult) return appleEmbeddedResult

  const feedEnclosureUrl = feedHtml ? extractEnclosureFromFeed(feedHtml) : null
  if (feedEnclosureUrl && feedHtml) {
    const resolvedUrl = decodeXmlEntities(feedEnclosureUrl.enclosureUrl)
    const durationSeconds = feedEnclosureUrl.durationSeconds
    try {
      const missing = ensureTranscriptionProvider()
      if (missing) return missing
      pushOnce('whisper')
      const transcript = await transcribe({
        url: resolvedUrl,
        filenameHint: 'episode.mp3',
        durationSecondsHint: durationSeconds,
      })
      return buildWhisperResult({
        attemptedProviders,
        notes,
        outcome: transcript,
        includeProviderOnFailure: true,
        metadata: {
          provider: 'podcast',
          kind: 'rss_enclosure',
          enclosureUrl: resolvedUrl,
          durationSeconds,
        },
      })
    } catch (error) {
      return {
        text: null,
        source: null,
        attemptedProviders,
        notes: `Podcast enclosure download failed: ${error instanceof Error ? error.message : String(error)}`,
        metadata: { provider: 'podcast', kind: 'rss_enclosure', enclosureUrl: resolvedUrl },
      }
    }
  }

  const ogAudioUrl = feedHtml ? extractOgAudioUrl(feedHtml) : null
  if (ogAudioUrl) {
    attemptedProviders.push('whisper')
    const result = await transcribe({
      url: ogAudioUrl,
      filenameHint: 'audio.mp3',
      durationSecondsHint: null,
    })
    if (result.text) {
      notes.push('Used og:audio media (may be a preview clip, not the full episode)')
      return buildWhisperResult({
        attemptedProviders,
        notes,
        outcome: result,
        metadata: {
          provider: 'podcast',
          kind: 'og_audio',
          ogAudioUrl,
        },
      })
    }
    return {
      text: null,
      source: null,
      attemptedProviders,
      notes: result.error?.message ?? null,
      metadata: { provider: 'podcast', kind: 'og_audio', ogAudioUrl },
    }
  }

  if (options.ytDlpPath) {
    attemptedProviders.push('yt-dlp')
    try {
      const mod = await import('./youtube/yt-dlp.js')
      const result = await mod.fetchTranscriptWithYtDlp({
        ytDlpPath: options.ytDlpPath,
        transcription,
        mediaCache: options.mediaCache ?? null,
        url: context.url,
        service: 'podcast',
        mediaKind: 'audio',
      })
      if (result.notes.length > 0) notes.push(...result.notes)
      return {
        text: result.text,
        source: result.text ? 'yt-dlp' : null,
        attemptedProviders,
        notes: joinNotes(notes),
        metadata: { provider: 'podcast', kind: 'yt_dlp', transcriptionProvider: result.provider },
      }
    } catch (error) {
      return {
        text: null,
        source: null,
        attemptedProviders,
        notes: `yt-dlp transcription failed: ${error instanceof Error ? error.message : String(error)}`,
        metadata: { provider: 'podcast', kind: 'yt_dlp' },
      }
    }
  }

  const missing = ensureTranscriptionProvider()
  if (missing) return missing

  return {
    text: null,
    source: null,
    attemptedProviders,
    metadata: { provider: 'podcast', reason: 'no_enclosure_and_no_yt_dlp' },
  }
}

function extractOgAudioUrl(html: string): string | null {
  const match = html.match(/<meta\s+property=['"]og:audio['"]\s+content=['"]([^'"]+)['"][^>]*>/i)
  if (!match?.[1]) return null
  const candidate = match[1].trim()
  if (!candidate) return null
  if (!/^https?:\/\//i.test(candidate)) return null
  return candidate
}

// Test-only exports (not part of the public API; may change without notice).
export const __test__ = {
  probeRemoteMedia,
  downloadCappedBytes,
  downloadToFile,
  normalizeHeaderType,
  parseContentLength,
  filenameFromUrl,
  looksLikeBlockedHtml,
  extractItemDurationSeconds,
  extractEnclosureForEpisode,
  resolvePodcastFeedUrlFromItunesSearch,
  formatBytes,
}
