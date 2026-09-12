import { resolveTranscriptForLink } from "../../transcript/index.js";
import type { LinkPreviewDeps } from "../deps.js";
import type { FirecrawlDiagnostics } from "../types.js";
import type { FetchLinkContentOptions } from "./types.js";
import { selectBaseContent, selectEmbeddedVideoContent } from "./utils.js";
import { detectPrimaryVideoDetailsFromHtml, resolveEmbeddedYoutubeDecision } from "./video.js";
import { refreshYoutubeSourceMetrics } from "./youtube-source-metrics.js";

export type PageExtractionContext = {
  url: string;
  deps: LinkPreviewDeps;
  timeoutMs: number;
  maxCharacters: number | null;
  cacheMode: FetchLinkContentOptions["cacheMode"];
  youtubeTranscriptMode: FetchLinkContentOptions["youtubeTranscript"];
  mediaTranscriptMode: FetchLinkContentOptions["mediaTranscript"];
  embeddedVideoMode?: FetchLinkContentOptions["embeddedVideo"];
  transcriptTimestamps?: FetchLinkContentOptions["transcriptTimestamps"];
  transcriptDiarization?: FetchLinkContentOptions["transcriptDiarization"];
  transcriptVideoDownload?: FetchLinkContentOptions["transcriptVideoDownload"];
  firecrawlDiagnostics: FirecrawlDiagnostics;
  markdownRequested: boolean;
};

export async function resolvePageMedia(
  context: PageExtractionContext,
  html: string | null,
  startedAtMs: number,
  refreshMetrics = html !== null,
) {
  const { url, deps, timeoutMs } = context;
  const detection = html ? detectPrimaryVideoDetailsFromHtml(html, url) : null;
  const video = detection?.video ?? null;
  const mode = context.embeddedVideoMode ?? "auto";
  const embeddedYoutube = resolveEmbeddedYoutubeDecision({
    pageUrl: url,
    detection,
    mode,
    youtubeTranscriptMode: context.youtubeTranscriptMode ?? "auto",
    mediaTranscriptMode: context.mediaTranscriptMode ?? "auto",
  });
  const transcriptResolution = await resolveTranscriptForLink(url, html, deps, {
    timeoutMs,
    youtubeTranscriptMode: embeddedYoutube.youtubeTranscriptMode,
    mediaTranscriptMode: embeddedYoutube.mediaTranscriptMode,
    transcriptTimestamps: context.transcriptTimestamps,
    transcriptDiarization: context.transcriptDiarization,
    transcriptVideoDownload: context.transcriptVideoDownload,
    cacheMode: context.cacheMode,
    embeddedMediaUrl: embeddedYoutube.shouldUse ? embeddedYoutube.detection?.video.url : null,
  });
  if (refreshMetrics && html !== null) {
    await refreshYoutubeSourceMetrics({
      url,
      html,
      detectedVideo: video,
      transcriptResolution,
      deps,
      timeoutMs,
      startedAtMs,
    });
  }
  return { video, mode, embeddedYoutube, transcriptResolution };
}

export function composePageContent(
  articleContent: string,
  { mode, embeddedYoutube, transcriptResolution }: Awaited<ReturnType<typeof resolvePageMedia>>,
) {
  const selection =
    embeddedYoutube.shouldUse && embeddedYoutube.detection
      ? selectEmbeddedVideoContent({
          articleContent,
          transcriptText: transcriptResolution.text,
          transcriptSegments: transcriptResolution.segments,
          mode,
          videoUrl: embeddedYoutube.detection.video.url,
        })
      : null;
  return {
    baseContent:
      selection?.baseContent ??
      selectBaseContent(articleContent, transcriptResolution.text, transcriptResolution.segments),
    contentSections: selection?.contentSections ?? null,
    embeddedVideo: {
      mode,
      detected: embeddedYoutube.detection !== null,
      used: Boolean(embeddedYoutube.shouldUse && transcriptResolution.text),
      url: embeddedYoutube.detection?.video.url ?? null,
      source: embeddedYoutube.detection?.source ?? null,
      confidence: embeddedYoutube.detection?.confidence ?? null,
      composition: selection?.composition ?? "article",
      notes: embeddedYoutube.notes,
    },
  };
}
