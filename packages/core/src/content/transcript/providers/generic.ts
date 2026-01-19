import { load } from 'cheerio'
import { isTwitterStatusUrl } from '../../link-preview/content/twitter-utils.js'
import type { TranscriptSegment } from '../../link-preview/types.js'
import { isDirectMediaUrl } from '../../url.js'
import { normalizeTranscriptText } from '../normalize.js'
import {
  jsonTranscriptToPlainText,
  jsonTranscriptToSegments,
  vttToPlainText,
  vttToSegments,
} from '../parse.js'
import type { ProviderContext, ProviderFetchOptions, ProviderResult } from '../types.js'
import { resolveTranscriptionAvailability } from './transcription-start.js'

export const canHandle = (): boolean => true

export const fetchTranscript = async (
  context: ProviderContext,
  options: ProviderFetchOptions
): Promise<ProviderResult> => {
  const attemptedProviders: ProviderResult['attemptedProviders'] = []
  const notes: string[] = []

  const embedded = context.html ? detectEmbeddedMedia(context.html, context.url) : null
  if (embedded?.track) {
    attemptedProviders.push('embedded')
    const caption = await fetchCaptionTrack(
      options.fetch,
      embedded.track,
      notes,
      Boolean(options.transcriptTimestamps)
    )
    if (caption?.text) {
      return {
        text: normalizeTranscriptText(caption.text),
        source: 'embedded',
        segments: options.transcriptTimestamps ? (caption.segments ?? null) : null,
        attemptedProviders,
        metadata: {
          provider: 'embedded',
          kind: embedded.kind,
          trackUrl: embedded.track.url,
          trackType: embedded.track.type,
          trackLanguage: embedded.track.language,
        },
        notes: notes.length > 0 ? notes.join('; ') : null,
      }
    }
  }

  const mediaUrl =
    options.mediaTranscriptMode === 'prefer'
      ? (embedded?.mediaUrl ?? (isDirectMediaUrl(context.url) ? context.url : null))
      : null

  if (
    options.mediaTranscriptMode === 'prefer' &&
    (mediaUrl || embedded?.kind || isDirectMediaUrl(context.url))
  ) {
    const result = await fetchDirectMediaTranscript({
      url: mediaUrl ?? context.url,
      options,
      notes,
      attemptedProviders,
      kind: embedded?.kind ?? null,
    })
    if (result) return result
  }

  if (isTwitterStatusUrl(context.url) && options.mediaTranscriptMode !== 'prefer') {
    return {
      text: null,
      source: null,
      attemptedProviders,
      metadata: { provider: 'generic', kind: 'twitter', reason: 'media_mode_auto' },
      notes:
        'Twitter transcript skipped (media transcript mode is auto; enable --video-mode transcript to force audio).',
    }
  }

  if (!isTwitterStatusUrl(context.url)) {
    return {
      text: null,
      source: null,
      attemptedProviders,
      metadata: { provider: 'generic', reason: 'not_implemented' },
      notes: notes.length > 0 ? notes.join('; ') : null,
    }
  }

  if (!options.ytDlpPath) {
    return {
      text: null,
      source: null,
      attemptedProviders,
      metadata: { provider: 'generic', kind: 'twitter', reason: 'missing_yt_dlp' },
      notes: 'yt-dlp is not configured (set YT_DLP_PATH or ensure yt-dlp is on PATH)',
    }
  }

  const transcriptionAvailability = await resolveTranscriptionAvailability({
    env: options.env,
    openaiApiKey: options.openaiApiKey,
    falApiKey: options.falApiKey,
  })
  if (!transcriptionAvailability.hasAnyProvider) {
    return {
      text: null,
      source: null,
      attemptedProviders,
      metadata: { provider: 'generic', kind: 'twitter', reason: 'missing_transcription_keys' },
      notes: 'Missing transcription provider (install whisper-cpp or set OPENAI_API_KEY/FAL_KEY)',
    }
  }

  attemptedProviders.push('yt-dlp')

  const resolved = options.resolveTwitterCookies
    ? await options.resolveTwitterCookies({ url: context.url })
    : null
  if (resolved?.warnings?.length) notes.push(...resolved.warnings)

  const extraArgs: string[] = []
  if (resolved?.cookiesFromBrowser) {
    extraArgs.push('--cookies-from-browser', resolved.cookiesFromBrowser)
    if (resolved.source) notes.push(`Using X cookies from ${resolved.source}`)
  }

  const mod = await import('./youtube/yt-dlp.js')
  const ytdlpResult = await mod.fetchTranscriptWithYtDlp({
    ytDlpPath: options.ytDlpPath,
    env: options.env,
    openaiApiKey: options.openaiApiKey,
    falApiKey: options.falApiKey,
    url: context.url,
    onProgress: options.onProgress ?? null,
    service: 'generic',
    extraArgs: extraArgs.length > 0 ? extraArgs : undefined,
  })
  if (ytdlpResult.notes.length > 0) {
    notes.push(...ytdlpResult.notes)
  }

  if (ytdlpResult.text) {
    return {
      text: normalizeTranscriptText(ytdlpResult.text),
      source: 'yt-dlp',
      attemptedProviders,
      metadata: {
        provider: 'generic',
        kind: 'twitter',
        transcriptionProvider: ytdlpResult.provider,
        cookieSource: resolved?.source ?? null,
      },
      notes: notes.length > 0 ? notes.join('; ') : null,
    }
  }

  if (ytdlpResult.error) {
    notes.push(`yt-dlp transcription failed: ${ytdlpResult.error.message}`)
  }

  return {
    text: null,
    source: null,
    attemptedProviders,
    metadata: {
      provider: 'generic',
      kind: 'twitter',
      reason: ytdlpResult.error ? 'yt_dlp_failed' : 'no_transcript',
      transcriptionProvider: ytdlpResult.provider,
    },
    notes: notes.length > 0 ? notes.join('; ') : null,
  }
}

type EmbeddedTrack = {
  url: string
  type: string | null
  language: string | null
}

type EmbeddedMedia = {
  kind: 'video' | 'audio'
  mediaUrl: string | null
  track: EmbeddedTrack | null
}

function detectEmbeddedMedia(html: string, baseUrl: string): EmbeddedMedia | null {
  const $ = load(html)
  const trackCandidates: EmbeddedTrack[] = []
  $('track[kind="captions"], track[kind="subtitles"]').each((_idx, el) => {
    const src = $(el).attr('src')?.trim()
    if (!src) return
    const url = resolveAbsoluteUrl(src, baseUrl)
    if (!url) return
    const type = $(el).attr('type')?.trim() ?? null
    const language = $(el).attr('srclang')?.trim() ?? $(el).attr('lang')?.trim() ?? null
    trackCandidates.push({ url, type, language })
  })

  const track = selectPreferredTrack(trackCandidates)

  const videoUrl = resolveFirstMediaUrl($, baseUrl, 'video')
  const audioUrl = resolveFirstMediaUrl($, baseUrl, 'audio')
  const ogVideo = resolveOgMediaUrl($, baseUrl, 'video')
  const ogAudio = resolveOgMediaUrl($, baseUrl, 'audio')

  if (videoUrl || ogVideo) {
    const mediaUrl = pickMediaUrl([videoUrl, ogVideo])
    return { kind: 'video', mediaUrl, track }
  }
  if (audioUrl || ogAudio) {
    const mediaUrl = pickMediaUrl([audioUrl, ogAudio])
    return { kind: 'audio', mediaUrl, track }
  }

  const hasVideoTag = $('video').length > 0
  const hasAudioTag = !hasVideoTag && $('audio').length > 0

  if (track || hasVideoTag || hasAudioTag) {
    return { kind: hasAudioTag ? 'audio' : 'video', mediaUrl: null, track }
  }

  return null
}

function selectPreferredTrack(tracks: EmbeddedTrack[]): EmbeddedTrack | null {
  if (tracks.length === 0) return null
  const normalized = tracks.map((track) => ({
    ...track,
    language: track.language?.toLowerCase() ?? null,
  }))
  const english = normalized.find((track) => track.language?.startsWith('en'))
  return english ?? normalized[0] ?? null
}

function resolveFirstMediaUrl(
  $: ReturnType<typeof load>,
  baseUrl: string,
  tag: 'video' | 'audio'
): string | null {
  const direct =
    $(`${tag}[src]`).first().attr('src') ?? $(`${tag} source[src]`).first().attr('src') ?? null
  if (!direct) return null
  return resolveAbsoluteUrl(direct, baseUrl)
}

function resolveOgMediaUrl(
  $: ReturnType<typeof load>,
  baseUrl: string,
  kind: 'video' | 'audio'
): string | null {
  const meta = $(
    `meta[property="og:${kind}"], meta[property="og:${kind}:url"], meta[property="og:${kind}:secure_url"], meta[name="og:${kind}"], meta[name="og:${kind}:url"], meta[name="og:${kind}:secure_url"]`
  )
    .first()
    .attr('content')
  if (!meta) return null
  return resolveAbsoluteUrl(meta, baseUrl)
}

function resolveAbsoluteUrl(candidate: string, baseUrl: string): string | null {
  const trimmed = candidate.trim()
  if (trimmed.length === 0) return null
  try {
    return new URL(trimmed, baseUrl).toString()
  } catch {
    return null
  }
}

function pickMediaUrl(candidates: Array<string | null>): string | null {
  let fallback: string | null = null
  for (const candidate of candidates) {
    if (!candidate) continue
    if (isDirectMediaUrl(candidate)) return candidate
    if (!fallback) fallback = candidate
  }
  return fallback
}

async function fetchCaptionTrack(
  fetchImpl: typeof fetch,
  track: EmbeddedTrack,
  notes: string[],
  includeSegments: boolean
): Promise<{ text: string; segments: TranscriptSegment[] | null } | null> {
  try {
    const res = await fetchImpl(track.url, {
      headers: { accept: 'text/vtt,text/plain,application/json;q=0.9,*/*;q=0.8' },
    })
    if (!res.ok) {
      notes.push(`Embedded captions fetch failed (${res.status})`)
      return null
    }
    const body = await res.text()
    const contentType = res.headers.get('content-type')?.toLowerCase() ?? ''
    const type = track.type?.toLowerCase() ?? ''

    if (type.includes('application/json') || contentType.includes('application/json')) {
      try {
        const parsed = JSON.parse(body)
        const text = jsonTranscriptToPlainText(parsed)
        if (!text) return null
        const segments = includeSegments ? jsonTranscriptToSegments(parsed) : null
        return { text, segments }
      } catch {
        notes.push('Embedded captions JSON parse failed')
        return null
      }
    }

    if (
      type.includes('text/vtt') ||
      contentType.includes('text/vtt') ||
      track.url.toLowerCase().endsWith('.vtt')
    ) {
      const plain = vttToPlainText(body)
      if (plain.length === 0) return null
      const segments = includeSegments ? vttToSegments(body) : null
      return { text: plain, segments }
    }

    const trimmed = body.trim()
    return trimmed.length > 0 ? { text: trimmed, segments: null } : null
  } catch (error) {
    notes.push(`Embedded captions fetch failed: ${error instanceof Error ? error.message : error}`)
    return null
  }
}

async function fetchDirectMediaTranscript({
  url,
  options,
  notes,
  attemptedProviders,
  kind,
}: {
  url: string
  options: ProviderFetchOptions
  notes: string[]
  attemptedProviders: ProviderResult['attemptedProviders']
  kind: EmbeddedMedia['kind'] | null
}): Promise<ProviderResult | null> {
  if (!options.ytDlpPath) {
    notes.push('yt-dlp is not configured (set YT_DLP_PATH or ensure yt-dlp is on PATH)')
    return null
  }

  const transcriptionAvailability = await resolveTranscriptionAvailability({
    env: options.env,
    openaiApiKey: options.openaiApiKey,
    falApiKey: options.falApiKey,
  })
  if (!transcriptionAvailability.hasAnyProvider) {
    notes.push('Missing transcription provider (install whisper-cpp or set OPENAI_API_KEY/FAL_KEY)')
    return null
  }

  attemptedProviders.push('yt-dlp')

  const mod = await import('./youtube/yt-dlp.js')
  const ytdlpResult = await mod.fetchTranscriptWithYtDlp({
    ytDlpPath: options.ytDlpPath,
    env: options.env,
    openaiApiKey: options.openaiApiKey,
    falApiKey: options.falApiKey,
    url,
    onProgress: options.onProgress ?? null,
    service: 'generic',
  })
  if (ytdlpResult.notes.length > 0) {
    notes.push(...ytdlpResult.notes)
  }

  if (ytdlpResult.text) {
    return {
      text: normalizeTranscriptText(ytdlpResult.text),
      source: 'yt-dlp',
      attemptedProviders,
      metadata: {
        provider: 'generic',
        kind: kind ?? 'media',
        transcriptionProvider: ytdlpResult.provider,
      },
      notes: notes.length > 0 ? notes.join('; ') : null,
    }
  }

  if (ytdlpResult.error) {
    notes.push(`yt-dlp transcription failed: ${ytdlpResult.error.message}`)
  }

  return null
}
