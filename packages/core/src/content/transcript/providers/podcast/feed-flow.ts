import type { ProviderResult } from "../../types.js";
import type { PodcastFlowContext } from "./flow-context.js";
import { joinNotes } from "./results.js";
import { tryFetchTranscriptFromFeedXml } from "./rss-transcript.js";

export async function fetchFeedTranscript(
  flow: PodcastFlowContext,
  feedXml: string,
  episodeTitle: string | null,
  metadata: Record<string, unknown>,
  successNote?: string,
): Promise<ProviderResult | null> {
  if (!/podcast:transcript/i.test(feedXml)) return null;
  flow.pushOnce("podcastTranscript");
  const transcript = await tryFetchTranscriptFromFeedXml({
    fetchImpl: flow.options.fetch,
    feedXml,
    episodeTitle,
    notes: flow.notes,
  });
  if (!transcript) return null;
  if (successNote) flow.notes.push(successNote);
  return {
    text: transcript.text,
    source: "podcastTranscript",
    segments: flow.options.transcriptTimestamps ? (transcript.segments ?? null) : null,
    attemptedProviders: flow.attemptedProviders,
    notes: joinNotes(flow.notes),
    metadata: {
      provider: "podcast",
      ...metadata,
      transcriptUrl: transcript.transcriptUrl,
      transcriptType: transcript.transcriptType,
    },
  };
}
