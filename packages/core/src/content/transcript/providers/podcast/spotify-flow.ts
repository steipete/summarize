import type { ProviderResult } from "../../types.js";
import { TRANSCRIPTION_TIMEOUT_MS } from "./constants.js";
import { fetchFeedTranscript } from "./feed-flow.js";
import type { PodcastFlowContext } from "./flow-context.js";
import {
  resolvePodcastEpisodeFromItunesSearch,
  resolvePodcastFeedUrlFromItunesSearch,
} from "./itunes.js";
import { buildWhisperResult } from "./results.js";
import { decodeXmlEntities, extractEnclosureForEpisode } from "./rss.js";
import {
  extractSpotifyEmbedData,
  extractSpotifyEpisodeId,
  fetchSpotifyEmbedHtml,
} from "./spotify.js";

export async function fetchSpotifyTranscript(
  flow: PodcastFlowContext,
): Promise<ProviderResult | null> {
  const spotifyEpisodeId = extractSpotifyEpisodeId(flow.context.url);
  if (!spotifyEpisodeId) return null;

  try {
    // Spotify episode pages frequently trigger bot protection (captcha/recaptcha) and the
    // episode audio itself is sometimes DRM-protected. So we:
    // - fetch the lightweight embed page for stable metadata (__NEXT_DATA__),
    // - first try the embed-provided audio URL (works for many episodes),
    // - then fall back to resolving the publisher RSS feed via Apple’s iTunes directory.
    const embedUrl = `https://open.spotify.com/embed/episode/${spotifyEpisodeId}`;
    const { html: embedHtml, via } = await fetchSpotifyEmbedHtml({
      embedUrl,
      episodeId: spotifyEpisodeId,
      fetchImpl: flow.options.fetch,
      scrapeWithFirecrawl: flow.options.scrapeWithFirecrawl ?? null,
    });

    const embedData = extractSpotifyEmbedData(embedHtml);
    if (!embedData) {
      throw new Error("Spotify embed data not found (missing __NEXT_DATA__)");
    }
    const showTitle = embedData.showTitle;
    const episodeTitle = embedData.episodeTitle;
    const embedAudioUrl = embedData.audioUrl;
    const embedDurationSeconds = embedData.durationSeconds;
    const embedAudioLooksEncrypted = looksLikeSpotifyEncryptedAudioFormat(embedData.drmFormat);

    if (embedAudioUrl && embedAudioLooksEncrypted) {
      flow.notes.push(
        `Spotify embed audio format ${embedData.drmFormat ?? "unknown"} looks encrypted; falling back to iTunes RSS`,
      );
    } else if (embedAudioUrl) {
      const missing = flow.ensureTranscriptionProvider();
      if (missing) return missing;
      flow.pushOnce("whisper");
      const result = await flow
        .transcribe({
          url: embedAudioUrl,
          filenameHint: "episode.mp4",
          durationSecondsHint: embedDurationSeconds,
        })
        .catch((error: unknown) => ({
          text: null,
          provider: null,
          error: error instanceof Error ? error : new Error(String(error)),
        }));
      const embedTranscriptChars = result.text?.trim().length ?? 0;
      const shouldTreatAsPreview =
        embedTranscriptChars > 0 &&
        (embedTranscriptChars < 200 ||
          (embedTranscriptChars < 800 &&
            (embedDurationSeconds == null ||
              (typeof embedDurationSeconds === "number" && embedDurationSeconds >= 600))));

      if (result.text && !shouldTreatAsPreview) {
        flow.notes.push(
          via === "firecrawl"
            ? "Resolved Spotify embed audio via Firecrawl"
            : "Resolved Spotify embed audio",
        );
        return buildWhisperResult({
          attemptedProviders: flow.attemptedProviders,
          notes: flow.notes,
          outcome: result,
          metadata: {
            provider: "podcast",
            kind: "spotify_embed_audio",
            episodeId: spotifyEpisodeId,
            showTitle,
            episodeTitle,
            audioUrl: embedAudioUrl,
            durationSeconds: embedDurationSeconds,
            drmFormat: embedData.drmFormat,
          },
        });
      }
      if (shouldTreatAsPreview) {
        flow.notes.push(
          `Spotify embed audio looked like a short clip (${embedTranscriptChars} chars); falling back to iTunes RSS`,
        );
      }
      flow.notes.push(
        `Spotify embed audio transcription failed; falling back to iTunes RSS: ${
          result.error?.message ?? "unknown error"
        }`,
      );
    }

    const feedUrl = await resolvePodcastFeedUrlFromItunesSearch(flow.options.fetch, showTitle);
    if (feedUrl) {
      const feedResponse = await flow.options.fetch(feedUrl, {
        signal: AbortSignal.timeout(TRANSCRIPTION_TIMEOUT_MS),
      });
      if (!feedResponse.ok) {
        throw new Error(`Podcast feed fetch failed (${feedResponse.status})`);
      }
      const feedXml = await feedResponse.text();
      const transcript = await fetchFeedTranscript(flow, feedXml, episodeTitle, {
        kind: "spotify_itunes_rss_transcript",
        episodeId: spotifyEpisodeId,
        showTitle,
        episodeTitle,
        feedUrl,
      });
      if (transcript) return transcript;
      const match = extractEnclosureForEpisode(feedXml, episodeTitle);
      if (match) {
        const enclosureUrl = decodeXmlEntities(match.enclosureUrl);
        const durationSeconds = match.durationSeconds;

        flow.notes.push(
          via === "firecrawl"
            ? "Resolved Spotify episode via Firecrawl embed + iTunes RSS"
            : "Resolved Spotify episode via iTunes RSS",
        );
        const missing = flow.ensureTranscriptionProvider();
        if (missing) return missing;
        flow.pushOnce("whisper");
        const result = await flow.transcribe({
          url: enclosureUrl,
          filenameHint: "episode.mp3",
          durationSecondsHint: durationSeconds,
        });
        return buildWhisperResult({
          attemptedProviders: flow.attemptedProviders,
          notes: flow.notes,
          outcome: result,
          includeProviderOnFailure: true,
          metadata: {
            provider: "podcast",
            kind: "spotify_itunes_rss_enclosure",
            episodeId: spotifyEpisodeId,
            showTitle,
            episodeTitle,
            feedUrl,
            enclosureUrl,
            durationSeconds,
          },
        });
      }
    }
    const episodeFromSearch = await resolvePodcastEpisodeFromItunesSearch(
      flow.options.fetch,
      showTitle,
      episodeTitle,
    );
    if (episodeFromSearch) {
      const missing = flow.ensureTranscriptionProvider();
      if (missing) return missing;
      flow.pushOnce("whisper");
      const result = await flow.transcribe({
        url: episodeFromSearch.episodeUrl,
        filenameHint: "episode.mp3",
        durationSecondsHint: episodeFromSearch.durationSeconds,
      });
      if (result.text) {
        flow.notes.push("Resolved Spotify episode via iTunes episode search");
        return buildWhisperResult({
          attemptedProviders: flow.attemptedProviders,
          notes: flow.notes,
          outcome: result,
          metadata: {
            provider: "podcast",
            kind: "spotify_itunes_search_episode",
            episodeId: spotifyEpisodeId,
            showTitle,
            episodeTitle: episodeFromSearch.episodeTitle,
            episodeUrl: episodeFromSearch.episodeUrl,
            durationSeconds: episodeFromSearch.durationSeconds,
          },
        });
      }
    }
    throw new Error(
      feedUrl
        ? `Episode enclosure not found in RSS feed for "${episodeTitle}"`
        : `Spotify episode audio appears DRM-protected; could not resolve RSS feed via iTunes Search API for show "${showTitle}"`,
    );
  } catch (error) {
    return {
      text: null,
      source: null,
      attemptedProviders: flow.attemptedProviders,
      notes: `Spotify episode fetch failed: ${error instanceof Error ? error.message : String(error)}`,
      metadata: {
        provider: "podcast",
        kind: "spotify_itunes_rss_enclosure",
        episodeId: spotifyEpisodeId,
      },
    };
  }
}

function looksLikeSpotifyEncryptedAudioFormat(format: string | null): boolean {
  return /(?:^|_)C(?:BCS|ENC)(?:_|$)/i.test(format ?? "");
}
