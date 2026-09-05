import { extractApplePodcastIds } from "../../../url.js";
import type { ProviderResult } from "../../types.js";
import { extractAppleEpisodeTitleFromHtml, extractEmbeddedJsonUrl } from "./apple.js";
import { TRANSCRIPTION_TIMEOUT_MS } from "./constants.js";
import { fetchFeedTranscript } from "./feed-flow.js";
import type { PodcastFlowContext } from "./flow-context.js";
import { resolveApplePodcastEpisodeFromItunesLookup } from "./itunes.js";
import type { TranscribeRequest } from "./media.js";
import { buildWhisperResult } from "./results.js";
import { decodeXmlEntities, extractEnclosureForEpisode, extractEnclosureFromFeed } from "./rss.js";

export async function fetchAppleTranscriptFromItunesLookup(
  flow: PodcastFlowContext,
): Promise<ProviderResult | null> {
  const appleIds =
    typeof flow.context.html !== "string" ? extractApplePodcastIds(flow.context.url) : null;
  if (!appleIds) return null;

  try {
    const episode = await resolveApplePodcastEpisodeFromItunesLookup({
      fetchImpl: flow.options.fetch,
      showId: appleIds.showId,
      episodeId: appleIds.episodeId,
    });
    if (!episode) {
      throw new Error("iTunes lookup did not return an episodeUrl");
    }

    if (episode.feedUrl && episode.episodeTitle) {
      flow.pushOnce("podcastTranscript");
      const feedResponse = await flow.options.fetch(episode.feedUrl, {
        redirect: "follow",
        signal: AbortSignal.timeout(TRANSCRIPTION_TIMEOUT_MS),
      });
      if (feedResponse.ok) {
        const transcript = await fetchFeedTranscript(
          flow,
          await feedResponse.text(),
          episode.episodeTitle,
          {
            kind: "apple_itunes_rss_transcript",
            showId: appleIds.showId,
            episodeId: appleIds.episodeId,
            feedUrl: episode.feedUrl,
            episodeTitle: episode.episodeTitle,
          },
          "Resolved Apple Podcasts episode via RSS <podcast:transcript>",
        );
        if (transcript) return transcript;
      }
    }

    const missing = flow.ensureTranscriptionProvider();
    if (missing) return missing;
    flow.pushOnce("whisper");
    const result = await flow.transcribe({
      url: episode.episodeUrl,
      filenameHint: episode.fileExtension ? `episode.${episode.fileExtension}` : "episode.mp3",
      durationSecondsHint: episode.durationSeconds,
    });

    if (result.text) {
      flow.notes.push("Resolved Apple Podcasts episode via iTunes lookup");
    }
    return buildWhisperResult({
      attemptedProviders: flow.attemptedProviders,
      notes: flow.notes,
      outcome: result,
      includeProviderOnFailure: true,
      metadata: {
        provider: "podcast",
        kind: "apple_itunes_episode",
        showId: appleIds.showId,
        episodeId: appleIds.episodeId,
        episodeUrl: episode.episodeUrl,
        feedUrl: episode.feedUrl,
        durationSeconds: episode.durationSeconds,
      },
    });
  } catch (error) {
    return {
      text: null,
      source: null,
      attemptedProviders: flow.attemptedProviders,
      notes: `Apple Podcasts iTunes lookup failed: ${error instanceof Error ? error.message : String(error)}`,
      metadata: { provider: "podcast", kind: "apple_itunes_episode", showId: appleIds.showId },
    };
  }
}

export async function fetchAppleTranscriptFromEmbeddedHtml(
  flow: PodcastFlowContext,
): Promise<ProviderResult | null> {
  if (typeof flow.context.html !== "string") return null;

  const appleEpisodeTitle = extractAppleEpisodeTitleFromHtml(flow.context.html);

  const appleFeedUrl = extractEmbeddedJsonUrl(flow.context.html, "feedUrl");
  if (appleFeedUrl) {
    try {
      const feedResponse = await flow.options.fetch(appleFeedUrl, {
        signal: AbortSignal.timeout(TRANSCRIPTION_TIMEOUT_MS),
      });
      if (!feedResponse.ok) {
        throw new Error(`Feed fetch failed (${feedResponse.status})`);
      }
      const xml = await feedResponse.text();

      const transcript = await fetchFeedTranscript(flow, xml, appleEpisodeTitle, {
        kind: "apple_feed_transcript",
        feedUrl: appleFeedUrl,
        episodeTitle: appleEpisodeTitle,
      });
      if (transcript) return transcript;

      const enclosure =
        appleEpisodeTitle != null
          ? extractEnclosureForEpisode(xml, appleEpisodeTitle)
          : extractEnclosureFromFeed(xml);
      if (enclosure) {
        const resolvedUrl = decodeXmlEntities(enclosure.enclosureUrl);
        const durationSeconds = enclosure.durationSeconds;
        return await transcribeAppleMedia(
          flow,
          {
            url: resolvedUrl,
            filenameHint: "episode.mp3",
            durationSecondsHint: durationSeconds,
          },
          {
            provider: "podcast",
            kind: "apple_feed_url",
            feedUrl: appleFeedUrl,
            episodeTitle: appleEpisodeTitle,
            enclosureUrl: resolvedUrl,
            durationSeconds,
          },
        );
      }
    } catch (error) {
      // Apple pages usually contain both `feedUrl` and `streamUrl`. If the feed is flaky/blocked,
      // fall back to `streamUrl` instead of failing the whole provider.
      flow.notes.push(
        `Podcast feed fetch failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  const appleStreamUrl = extractEmbeddedJsonUrl(flow.context.html, "streamUrl");
  return appleStreamUrl
    ? transcribeAppleMedia(
        flow,
        {
          url: appleStreamUrl,
          filenameHint: "episode.mp3",
          durationSecondsHint: null,
        },
        { provider: "podcast", kind: "apple_stream_url", streamUrl: appleStreamUrl },
      )
    : null;
}

async function transcribeAppleMedia(
  flow: PodcastFlowContext,
  request: TranscribeRequest,
  metadata: Record<string, unknown>,
): Promise<ProviderResult> {
  const missing = flow.ensureTranscriptionProvider();
  if (missing) return missing;
  flow.pushOnce("whisper");
  let outcome: Awaited<ReturnType<typeof flow.transcribe>>;
  try {
    outcome = await flow.transcribe(request);
  } catch (error) {
    return {
      text: null,
      source: null,
      attemptedProviders: flow.attemptedProviders,
      notes: error instanceof Error ? error.message : String(error),
      metadata,
    };
  }
  return buildWhisperResult({
    attemptedProviders: flow.attemptedProviders,
    notes: flow.notes,
    outcome,
    metadata,
  });
}
