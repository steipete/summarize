import { normalizeTranscriptText } from '../normalize.js'
import { resolveTranscriptionConfig } from '../transcription-config.js'
import type {
  ProviderContext,
  ProviderFetchOptions,
  ProviderResult,
  TranscriptSource,
} from '../types.js'
import { extractYouTubeVideoId } from '../utils.js'
import { resolveTranscriptionAvailability } from './transcription-start.js'
import {
  extractYoutubeiTranscriptConfig,
  fetchTranscriptFromTranscriptEndpoint,
} from './youtube/api.js'
import { fetchTranscriptWithApify } from './youtube/apify.js'
import {
  extractYoutubeDurationSeconds,
  fetchTranscriptFromCaptionTracks,
  fetchYoutubeDurationSecondsViaPlayer,
} from './youtube/captions.js'
import { fetchDurationSecondsWithYtDlp, fetchTranscriptWithYtDlp } from './youtube/yt-dlp.js'

const YOUTUBE_URL_PATTERN = /youtube\.com|youtu\.be/i

export const canHandle = ({ url }: ProviderContext): boolean => YOUTUBE_URL_PATTERN.test(url)

export const fetchTranscript = async (
  context: ProviderContext,
  options: ProviderFetchOptions
): Promise<ProviderResult> => {
  // Diagnostics: used for logging/UX and for tests asserting provider order.
  const attemptedProviders: TranscriptSource[] = []
  const notes: string[] = []
  const transcription = resolveTranscriptionConfig(options)
  const { html: initialHtml, url } = context
  let html = initialHtml
  const hasYoutubeConfig =
    typeof html === 'string' && /ytcfg\.set|ytInitialPlayerResponse/.test(html)
  if (!hasYoutubeConfig) {
    // Many callers don't pass through the raw watch page HTML. When we don't see the usual
    // bootstrap tokens, do a best-effort fetch so downstream extractors can work.
    try {
      const response = await options.fetch(url, {
        headers: {
          'User-Agent':
            'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0 Safari/537.36',
          Accept: 'text/html,application/xhtml+xml',
        },
      })
      if (response.ok) {
        html = await response.text()
      }
    } catch {
      // ignore and fall back to existing html
    }
  }
  const mode = options.youtubeTranscriptMode
  const progress = typeof options.onProgress === 'function' ? options.onProgress : null
  const transcriptionAvailability = await resolveTranscriptionAvailability({
    transcription,
  })
  const hasYtDlpCredentials = transcriptionAvailability.hasAnyProvider
  // yt-dlp fallback only makes sense if we have the binary *and* some transcription path.
  const canRunYtDlp = Boolean(options.ytDlpPath && hasYtDlpCredentials)
  const pushHint = (hint: string) => {
    progress?.({ kind: 'transcript-start', url, service: 'youtube', hint })
  }

  if (mode === 'yt-dlp' && !options.ytDlpPath) {
    throw new Error(
      'Missing yt-dlp binary for --youtube yt-dlp (set YT_DLP_PATH or install yt-dlp)'
    )
  }
  if (mode === 'yt-dlp' && !hasYtDlpCredentials) {
    throw new Error(
      'Missing transcription provider for --youtube yt-dlp (install whisper-cpp or set OPENAI_API_KEY/FAL_KEY)'
    )
  }

  // In explicit apify mode we can continue without HTML.
  if (!html && mode !== 'apify') {
    return { text: null, source: null, attemptedProviders }
  }

  const tryApify = async (hint: string): Promise<ProviderResult | null> => {
    if (!options.apifyApiToken) return null
    pushHint(hint)
    attemptedProviders.push('apify')
    const apifyTranscript = await fetchTranscriptWithApify(
      options.fetch,
      options.apifyApiToken,
      url
    )
    if (!apifyTranscript) return null
    return {
      text: normalizeTranscriptText(apifyTranscript),
      source: 'apify',
      metadata: { provider: 'apify', ...(durationMetadata ?? {}) },
      attemptedProviders,
    }
  }

  const effectiveVideoIdCandidate = context.resourceKey ?? extractYouTubeVideoId(url)
  // Prefer the caller-provided resource key (e.g. from cache routing) over URL parsing.
  const effectiveVideoId =
    typeof effectiveVideoIdCandidate === 'string' && effectiveVideoIdCandidate.trim().length > 0
      ? effectiveVideoIdCandidate.trim()
      : null
  // In explicit apify mode we can continue without a parsed video id.
  if (!effectiveVideoId && mode !== 'apify') {
    return { text: null, source: null, attemptedProviders }
  }

  let durationSeconds = extractYoutubeDurationSeconds(html)
  if (!durationSeconds && effectiveVideoId) {
    durationSeconds = await fetchYoutubeDurationSecondsViaPlayer(options.fetch, {
      html,
      videoId: effectiveVideoId,
    })
  }
  if (!durationSeconds && options.ytDlpPath) {
    durationSeconds = await fetchDurationSecondsWithYtDlp({
      ytDlpPath: options.ytDlpPath,
      url,
    })
  }
  const durationMetadata =
    typeof durationSeconds === 'number' && Number.isFinite(durationSeconds) && durationSeconds > 0
      ? { durationSeconds }
      : null

  // Try no-auto mode (skip auto-generated captions, fall back to yt-dlp)
  if (mode === 'no-auto') {
    // "no-auto" is intentionally strict: only accept creator captions (and skip ASR/auto tracks).
    // We *only* require yt-dlp once we know captions aren't available.
    pushHint('YouTube: checking creator captions only (skipping auto-generated)')
    attemptedProviders.push('captionTracks')
    const manualTranscript = await fetchTranscriptFromCaptionTracks(options.fetch, {
      html,
      originalUrl: url,
      videoId: effectiveVideoId,
      skipAutoGenerated: true,
    })
    if (manualTranscript?.text) {
      return {
        text: normalizeTranscriptText(manualTranscript.text),
        source: 'captionTracks',
        segments: options.transcriptTimestamps ? (manualTranscript.segments ?? null) : null,
        metadata: { provider: 'captionTracks', manualOnly: true, ...(durationMetadata ?? {}) },
        attemptedProviders,
      }
    }
    // No creator captions found, fall through to yt-dlp below
    notes.push('No creator captions found, using yt-dlp transcription')
  }

  // Try web methods (youtubei, captionTracks) if mode is 'auto' or 'web'
  if (mode === 'auto' || mode === 'web') {
    // youtubei is preferred when available: it returns a clean transcript payload without having
    // to download/parse caption track formats.
    pushHint('YouTube: checking captions (youtubei)')
    const config = extractYoutubeiTranscriptConfig(html)
    if (config) {
      attemptedProviders.push('youtubei')
      const transcript = await fetchTranscriptFromTranscriptEndpoint(options.fetch, {
        config,
        originalUrl: url,
      })
      if (transcript?.text) {
        return {
          text: normalizeTranscriptText(transcript.text),
          source: 'youtubei',
          segments: options.transcriptTimestamps ? (transcript.segments ?? null) : null,
          metadata: { provider: 'youtubei', ...(durationMetadata ?? {}) },
          attemptedProviders,
        }
      }
    }

    if (!config) {
      pushHint('YouTube: youtubei unavailable; checking caption tracks')
    } else {
      pushHint('YouTube: youtubei empty; checking caption tracks')
    }
    attemptedProviders.push('captionTracks')
    const captionTranscript = await fetchTranscriptFromCaptionTracks(options.fetch, {
      html,
      originalUrl: url,
      videoId: effectiveVideoId,
    })
    if (captionTranscript?.text) {
      return {
        text: normalizeTranscriptText(captionTranscript.text),
        source: 'captionTracks',
        segments: options.transcriptTimestamps ? (captionTranscript.segments ?? null) : null,
        metadata: { provider: 'captionTracks', ...(durationMetadata ?? {}) },
        attemptedProviders,
      }
    }
  }

  // Try yt-dlp (audio download + OpenAI/FAL transcription) if mode is 'auto', 'no-auto', or 'yt-dlp'
  if (mode === 'yt-dlp' || mode === 'no-auto' || (mode === 'auto' && canRunYtDlp)) {
    if (mode === 'no-auto' && !canRunYtDlp) {
      throw new Error(
        '--youtube no-auto requires yt-dlp and a transcription provider (whisper-cpp, OPENAI_API_KEY, or FAL_KEY) for fallback'
      )
    }
    if (mode === 'auto') {
      pushHint('YouTube: captions unavailable; falling back to yt-dlp audio')
    } else if (mode === 'no-auto') {
      pushHint('YouTube: no creator captions; falling back to yt-dlp audio')
    } else {
      pushHint('YouTube: downloading audio (yt-dlp)')
    }
    attemptedProviders.push('yt-dlp')
    const ytdlpResult = await fetchTranscriptWithYtDlp({
      ytDlpPath: options.ytDlpPath,
      transcription,
      mediaCache: options.mediaCache ?? null,
      url,
      onProgress: progress,
      mediaKind: 'video',
    })
    if (ytdlpResult.notes.length > 0) {
      notes.push(...ytdlpResult.notes)
    }
    if (ytdlpResult.text) {
      return {
        text: normalizeTranscriptText(ytdlpResult.text),
        source: 'yt-dlp',
        metadata: {
          provider: 'yt-dlp',
          transcriptionProvider: ytdlpResult.provider,
          ...(durationMetadata ?? {}),
        },
        attemptedProviders,
        notes: notes.length > 0 ? notes.join('; ') : null,
      }
    }
    if (mode === 'yt-dlp' && ytdlpResult.error) {
      throw ytdlpResult.error
    }

    // Auto mode: only try Apify after yt-dlp fails (last resort).
    if (mode === 'auto') {
      const apifyResult = await tryApify('YouTube: yt-dlp transcription failed; trying Apify')
      if (apifyResult) return apifyResult
    }
  }

  // Explicit apify mode: allow forcing it, but require a token.
  if (mode === 'apify') {
    if (!options.apifyApiToken) {
      throw new Error('Missing APIFY_API_TOKEN for --youtube apify')
    }
    const apifyResult = await tryApify('YouTube: fetching transcript (Apify)')
    if (apifyResult) return apifyResult
  }

  // Auto mode: if yt-dlp cannot run (no binary/credentials), fall back to Apify last-last.
  if (mode === 'auto' && !canRunYtDlp) {
    const apifyResult = await tryApify('YouTube: captions unavailable; trying Apify')
    if (apifyResult) return apifyResult
  }

  attemptedProviders.push('unavailable')
  return {
    text: null,
    source: 'unavailable',
    metadata: {
      provider: 'youtube',
      reason: 'no_transcript_available',
      ...(durationMetadata ?? {}),
    },
    attemptedProviders,
    notes: notes.length > 0 ? notes.join('; ') : null,
  }
}
