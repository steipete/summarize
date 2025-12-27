import type { ProviderResult } from '../../types.js'
import {
  extractAppleEpisodeTitleFromHtml,
  extractApplePodcastIds,
  extractEmbeddedJsonUrl,
} from './apple.js'
import { TRANSCRIPTION_TIMEOUT_MS } from './constants.js'
import type { PodcastFlowContext } from './flow-context.js'
import { resolveApplePodcastEpisodeFromItunesLookup } from './itunes.js'
import { buildWhisperResult, joinNotes } from './results.js'
import {
  decodeXmlEntities,
  extractEnclosureForEpisode,
  extractEnclosureFromFeed,
  tryFetchTranscriptFromFeedXml,
} from './rss.js'

export async function fetchAppleTranscriptFromItunesLookup(
  flow: PodcastFlowContext
): Promise<ProviderResult | null> {
  const appleIds =
    typeof flow.context.html !== 'string' ? extractApplePodcastIds(flow.context.url) : null
  if (!appleIds) return null

  try {
    const episode = await resolveApplePodcastEpisodeFromItunesLookup({
      fetchImpl: flow.options.fetch,
      showId: appleIds.showId,
      episodeId: appleIds.episodeId,
    })
    if (!episode) {
      throw new Error('iTunes lookup did not return an episodeUrl')
    }

    if (episode.feedUrl && episode.episodeTitle) {
      flow.pushOnce('podcastTranscript')
      const feedResponse = await flow.options.fetch(episode.feedUrl, {
        redirect: 'follow',
        signal: AbortSignal.timeout(TRANSCRIPTION_TIMEOUT_MS),
      })
      if (feedResponse.ok) {
        const feedXml = await feedResponse.text()
        let maybeTranscript: Awaited<ReturnType<typeof tryFetchTranscriptFromFeedXml>> = null
        if (/podcast:transcript/i.test(feedXml)) {
          maybeTranscript = await tryFetchTranscriptFromFeedXml({
            fetchImpl: flow.options.fetch,
            feedXml,
            episodeTitle: episode.episodeTitle,
            notes: flow.notes,
          })
        }
        if (maybeTranscript) {
          flow.notes.push('Resolved Apple Podcasts episode via RSS <podcast:transcript>')
          return {
            text: maybeTranscript.text,
            source: 'podcastTranscript',
            attemptedProviders: flow.attemptedProviders,
            notes: joinNotes(flow.notes),
            metadata: {
              provider: 'podcast',
              kind: 'apple_itunes_rss_transcript',
              showId: appleIds.showId,
              episodeId: appleIds.episodeId,
              feedUrl: episode.feedUrl,
              episodeTitle: episode.episodeTitle,
              transcriptUrl: maybeTranscript.transcriptUrl,
              transcriptType: maybeTranscript.transcriptType,
            },
          }
        }
      }
    }

    const missing = flow.ensureTranscriptionProvider()
    if (missing) return missing
    flow.pushOnce('whisper')
    const result = await flow.transcribe({
      url: episode.episodeUrl,
      filenameHint: episode.fileExtension ? `episode.${episode.fileExtension}` : 'episode.mp3',
      durationSecondsHint: episode.durationSeconds,
    })

    if (result.text) {
      flow.notes.push('Resolved Apple Podcasts episode via iTunes lookup')
    }
    return buildWhisperResult({
      attemptedProviders: flow.attemptedProviders,
      notes: flow.notes,
      outcome: result,
      includeProviderOnFailure: true,
      metadata: {
        provider: 'podcast',
        kind: 'apple_itunes_episode',
        showId: appleIds.showId,
        episodeId: appleIds.episodeId,
        episodeUrl: episode.episodeUrl,
        feedUrl: episode.feedUrl,
        durationSeconds: episode.durationSeconds,
      },
    })
  } catch (error) {
    return {
      text: null,
      source: null,
      attemptedProviders: flow.attemptedProviders,
      notes: `Apple Podcasts iTunes lookup failed: ${error instanceof Error ? error.message : String(error)}`,
      metadata: { provider: 'podcast', kind: 'apple_itunes_episode', showId: appleIds.showId },
    }
  }
}

export async function fetchAppleTranscriptFromEmbeddedHtml(
  flow: PodcastFlowContext
): Promise<ProviderResult | null> {
  if (typeof flow.context.html !== 'string') return null

  const appleEpisodeTitle = extractAppleEpisodeTitleFromHtml(flow.context.html)

  const appleFeedUrl = extractEmbeddedJsonUrl(flow.context.html, 'feedUrl')
  if (appleFeedUrl) {
    try {
      const feedResponse = await flow.options.fetch(appleFeedUrl, {
        signal: AbortSignal.timeout(TRANSCRIPTION_TIMEOUT_MS),
      })
      if (!feedResponse.ok) {
        throw new Error(`Feed fetch failed (${feedResponse.status})`)
      }
      const xml = await feedResponse.text()

      let maybeTranscript: Awaited<ReturnType<typeof tryFetchTranscriptFromFeedXml>> = null
      if (/podcast:transcript/i.test(xml)) {
        flow.pushOnce('podcastTranscript')
        maybeTranscript = await tryFetchTranscriptFromFeedXml({
          fetchImpl: flow.options.fetch,
          feedXml: xml,
          episodeTitle: appleEpisodeTitle,
          notes: flow.notes,
        })
      }
      if (maybeTranscript) {
        return {
          text: maybeTranscript.text,
          source: 'podcastTranscript',
          attemptedProviders: flow.attemptedProviders,
          notes: joinNotes(flow.notes),
          metadata: {
            provider: 'podcast',
            kind: 'apple_feed_transcript',
            feedUrl: appleFeedUrl,
            episodeTitle: appleEpisodeTitle,
            transcriptUrl: maybeTranscript.transcriptUrl,
            transcriptType: maybeTranscript.transcriptType,
          },
        }
      }

      const enclosure =
        appleEpisodeTitle != null
          ? extractEnclosureForEpisode(xml, appleEpisodeTitle)
          : extractEnclosureFromFeed(xml)
      if (enclosure) {
        const resolvedUrl = decodeXmlEntities(enclosure.enclosureUrl)
        const durationSeconds = enclosure.durationSeconds
        const missing = flow.ensureTranscriptionProvider()
        if (missing) return missing
        flow.pushOnce('whisper')
        let result: Awaited<ReturnType<typeof flow.transcribe>>
        try {
          result = await flow.transcribe({
            url: resolvedUrl,
            filenameHint: 'episode.mp3',
            durationSecondsHint: durationSeconds,
          })
        } catch (error) {
          return {
            text: null,
            source: null,
            attemptedProviders: flow.attemptedProviders,
            notes: error instanceof Error ? error.message : String(error),
            metadata: {
              provider: 'podcast',
              kind: 'apple_feed_url',
              feedUrl: appleFeedUrl,
              episodeTitle: appleEpisodeTitle,
              enclosureUrl: resolvedUrl,
              durationSeconds,
            },
          }
        }
        return buildWhisperResult({
          attemptedProviders: flow.attemptedProviders,
          notes: flow.notes,
          outcome: result,
          metadata: {
            provider: 'podcast',
            kind: 'apple_feed_url',
            feedUrl: appleFeedUrl,
            episodeTitle: appleEpisodeTitle,
            enclosureUrl: resolvedUrl,
            durationSeconds,
          },
        })
      }
    } catch (error) {
      // Apple pages usually contain both `feedUrl` and `streamUrl`. If the feed is flaky/blocked,
      // fall back to `streamUrl` instead of failing the whole provider.
      flow.notes.push(
        `Podcast feed fetch failed: ${error instanceof Error ? error.message : String(error)}`
      )
    }
  }

  const appleStreamUrl = extractEmbeddedJsonUrl(flow.context.html, 'streamUrl')
  if (appleStreamUrl) {
    const missing = flow.ensureTranscriptionProvider()
    if (missing) return missing
    flow.pushOnce('whisper')
    let result: Awaited<ReturnType<typeof flow.transcribe>>
    try {
      result = await flow.transcribe({
        url: appleStreamUrl,
        filenameHint: 'episode.mp3',
        durationSecondsHint: null,
      })
    } catch (error) {
      return {
        text: null,
        source: null,
        attemptedProviders: flow.attemptedProviders,
        notes: error instanceof Error ? error.message : String(error),
        metadata: { provider: 'podcast', kind: 'apple_stream_url', streamUrl: appleStreamUrl },
      }
    }
    return buildWhisperResult({
      attemptedProviders: flow.attemptedProviders,
      notes: flow.notes,
      outcome: result,
      metadata: { provider: 'podcast', kind: 'apple_stream_url', streamUrl: appleStreamUrl },
    })
  }

  return null
}
