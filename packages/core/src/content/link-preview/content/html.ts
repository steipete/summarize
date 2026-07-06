import { resolveTranscriptForLink } from "../../transcript/index.js";
import { extractYouTubeVideoId, isYouTubeUrl, isYouTubeVideoUrl } from "../../url.js";
import type { LinkPreviewDeps } from "../deps.js";
import type { FirecrawlDiagnostics, MarkdownDiagnostics } from "../types.js";
import { extractArticleContent, sanitizeHtmlForMarkdownConversion } from "./article.js";
import { normalizeForPrompt } from "./cleaner.js";
import {
  MIN_HTML_CONTENT_CHARACTERS,
  MIN_METADATA_DESCRIPTION_CHARACTERS,
  MIN_READABILITY_CONTENT_CHARACTERS,
  READABILITY_RELATIVE_THRESHOLD,
} from "./constants.js";
import { extractJsonLdContent } from "./jsonld.js";
import { extractMetadataFromHtml } from "./parsers.js";
import { isPodcastHost, isPodcastLikeJsonLdType } from "./podcast-utils.js";
import { extractReadabilityFromHtml, toReadabilityHtml } from "./readability.js";
import type { ExtractedLinkContent, FetchLinkContentOptions, MarkdownMode } from "./types.js";
import {
  ensureTranscriptDiagnostics,
  finalizeExtractedLinkContent,
  pickFirstText,
  selectBaseContent,
  selectEmbeddedVideoContent,
} from "./utils.js";
import { detectPrimaryVideoDetailsFromHtml, resolveEmbeddedYoutubeDecision } from "./video.js";
import { refreshYoutubeSourceMetrics } from "./youtube-source-metrics.js";
import { extractYouTubeShortDescription } from "./youtube.js";

const LEADING_CONTROL_PATTERN = /^[\s\p{Cc}]+/u;

function stripLeadingTitle(content: string, title: string | null | undefined): string {
  if (!(content && title)) {
    return content;
  }

  const normalizedTitle = title.trim();
  if (normalizedTitle.length === 0) {
    return content;
  }

  const trimmedContent = content.trimStart();
  if (!trimmedContent.toLowerCase().startsWith(normalizedTitle.toLowerCase())) {
    return content;
  }

  const remainderOriginal = trimmedContent.slice(normalizedTitle.length);
  const remainder = remainderOriginal.replace(LEADING_CONTROL_PATTERN, "");
  return remainder;
}

export async function buildResultFromHtmlDocument({
  url,
  html,
  cacheMode,
  maxCharacters,
  youtubeTranscriptMode,
  mediaTranscriptMode,
  embeddedVideoMode,
  transcriptTimestamps,
  transcriptDiarization,
  transcriptVideoDownload,
  firecrawlDiagnostics,
  markdownRequested,
  markdownMode,
  timeoutMs,
  deps,
  readabilityCandidate,
  isNormalizedRedditThread = false,
  mediaHtml = html,
}: {
  url: string;
  html: string;
  cacheMode: FetchLinkContentOptions["cacheMode"];
  maxCharacters: number | null;
  youtubeTranscriptMode: FetchLinkContentOptions["youtubeTranscript"];
  mediaTranscriptMode: FetchLinkContentOptions["mediaTranscript"];
  embeddedVideoMode: FetchLinkContentOptions["embeddedVideo"];
  transcriptTimestamps?: FetchLinkContentOptions["transcriptTimestamps"];
  transcriptDiarization?: FetchLinkContentOptions["transcriptDiarization"];
  transcriptVideoDownload?: FetchLinkContentOptions["transcriptVideoDownload"];
  firecrawlDiagnostics: FirecrawlDiagnostics;
  markdownRequested: boolean;
  markdownMode: MarkdownMode;
  timeoutMs: number;
  deps: LinkPreviewDeps;
  readabilityCandidate: Awaited<ReturnType<typeof extractReadabilityFromHtml>> | null;
  isNormalizedRedditThread?: boolean;
  mediaHtml?: string;
}): Promise<ExtractedLinkContent> {
  const extractionStartedAt = Date.now();
  if (isYouTubeVideoUrl(url) && !extractYouTubeVideoId(url)) {
    throw new Error("Invalid YouTube video id in URL");
  }

  const { title, description, siteName } = extractMetadataFromHtml(html, url);
  const jsonLd = extractJsonLdContent(html);
  const mergedTitle = pickFirstText([jsonLd?.title, title]);
  const mergedDescription = pickFirstText([jsonLd?.description, description]);
  const isPodcastJsonLd = isPodcastLikeJsonLdType(jsonLd?.type);
  const readability = readabilityCandidate ?? (await extractReadabilityFromHtml(html, url));
  const readabilityText = readability?.text ? normalizeForPrompt(readability.text) : "";
  const readabilityHtml = toReadabilityHtml(readability);

  const normalizedSegmentsFromHtml = normalizeForPrompt(
    extractArticleContent(html, { preserveShortSegments: isNormalizedRedditThread }),
  );
  const normalizedSegmentsFromReadabilityHtml = readabilityHtml
    ? normalizeForPrompt(extractArticleContent(readabilityHtml))
    : "";
  const preferReadabilityHtml =
    !isNormalizedRedditThread &&
    normalizedSegmentsFromReadabilityHtml.length >= MIN_READABILITY_CONTENT_CHARACTERS &&
    (normalizedSegmentsFromHtml.length < MIN_HTML_CONTENT_CHARACTERS ||
      normalizedSegmentsFromReadabilityHtml.length >=
        normalizedSegmentsFromHtml.length * READABILITY_RELATIVE_THRESHOLD);
  const normalizedSegments = preferReadabilityHtml
    ? normalizedSegmentsFromReadabilityHtml
    : normalizedSegmentsFromHtml;

  const preferReadabilityText =
    !isNormalizedRedditThread &&
    !preferReadabilityHtml &&
    readabilityText.length >= MIN_READABILITY_CONTENT_CHARACTERS &&
    (normalizedSegmentsFromHtml.length < MIN_HTML_CONTENT_CHARACTERS ||
      readabilityText.length >= normalizedSegmentsFromHtml.length * READABILITY_RELATIVE_THRESHOLD);
  const preferReadability = preferReadabilityHtml || preferReadabilityText;
  const effectiveNormalized = preferReadabilityText ? readabilityText : normalizedSegments;
  const descriptionCandidate = mergedDescription ? normalizeForPrompt(mergedDescription) : "";
  const preferDescription =
    descriptionCandidate.length >= MIN_METADATA_DESCRIPTION_CHARACTERS &&
    (isPodcastJsonLd ||
      isPodcastHost(url) ||
      (!preferReadability &&
        (effectiveNormalized.length < MIN_HTML_CONTENT_CHARACTERS ||
          descriptionCandidate.length >=
            effectiveNormalized.length * READABILITY_RELATIVE_THRESHOLD)));
  const effectiveNormalizedWithDescription = preferDescription
    ? descriptionCandidate
    : effectiveNormalized;
  const videoDetection = detectPrimaryVideoDetailsFromHtml(mediaHtml, url);
  const detectedVideo = videoDetection?.video ?? null;
  const resolvedEmbeddedVideoMode = embeddedVideoMode ?? "auto";
  const embeddedYoutube = resolveEmbeddedYoutubeDecision({
    pageUrl: url,
    detection: videoDetection,
    mode: resolvedEmbeddedVideoMode,
    youtubeTranscriptMode: youtubeTranscriptMode ?? "auto",
    mediaTranscriptMode: mediaTranscriptMode ?? "auto",
  });
  const transcriptResolution = await resolveTranscriptForLink(url, mediaHtml, deps, {
    timeoutMs,
    youtubeTranscriptMode: embeddedYoutube.youtubeTranscriptMode,
    mediaTranscriptMode: embeddedYoutube.mediaTranscriptMode,
    transcriptTimestamps,
    transcriptDiarization,
    transcriptVideoDownload,
    cacheMode,
    embeddedMediaUrl: embeddedYoutube.shouldUse ? embeddedYoutube.detection?.video.url : null,
  });
  await refreshYoutubeSourceMetrics({
    url,
    html: mediaHtml,
    detectedVideo,
    transcriptResolution,
    deps,
    timeoutMs,
    startedAtMs: extractionStartedAt,
  });

  const youtubeDescription =
    transcriptResolution.text === null ? extractYouTubeShortDescription(mediaHtml) : null;
  let articleContent = youtubeDescription
    ? normalizeForPrompt(youtubeDescription)
    : effectiveNormalizedWithDescription;
  if (articleContent === normalizedSegments) {
    articleContent = stripLeadingTitle(articleContent, mergedTitle ?? title);
  }

  const transcriptDiagnostics = ensureTranscriptDiagnostics(
    transcriptResolution,
    cacheMode ?? "default",
  );

  const markdownDiagnostics: MarkdownDiagnostics = await (async () => {
    if (!markdownRequested) {
      return { requested: false, used: false, provider: null, notes: null };
    }

    if (isYouTubeUrl(url)) {
      return {
        requested: true,
        used: false,
        provider: null,
        notes: "Skipping Markdown conversion for YouTube URLs",
      };
    }

    if (!deps.convertHtmlToMarkdown) {
      return {
        requested: true,
        used: false,
        provider: null,
        notes: "No HTML→Markdown converter configured",
      };
    }

    try {
      const htmlForMarkdown =
        markdownMode === "readability" && readabilityHtml && !isNormalizedRedditThread
          ? readabilityHtml
          : html;
      const sanitizedHtml = sanitizeHtmlForMarkdownConversion(htmlForMarkdown);
      const markdown = await deps.convertHtmlToMarkdown({
        url,
        html: sanitizedHtml,
        title: mergedTitle ?? title,
        siteName,
        timeoutMs,
      });
      const normalizedMarkdown = normalizeForPrompt(markdown);
      if (normalizedMarkdown.length === 0) {
        return {
          requested: true,
          used: false,
          provider: null,
          notes: "HTML→Markdown conversion returned empty content",
        };
      }

      articleContent = normalizedMarkdown;
      return {
        requested: true,
        used: true,
        provider: "llm",
        notes:
          markdownMode === "readability" && readabilityHtml && !isNormalizedRedditThread
            ? "Readability HTML used for markdown input"
            : null,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        requested: true,
        used: false,
        provider: null,
        notes: `HTML→Markdown conversion failed: ${message}`,
      };
    }
  })();

  const embeddedSelection =
    embeddedYoutube.shouldUse && embeddedYoutube.detection
      ? selectEmbeddedVideoContent({
          articleContent,
          transcriptText: transcriptResolution.text,
          transcriptSegments: transcriptResolution.segments,
          mode: resolvedEmbeddedVideoMode,
          videoUrl: embeddedYoutube.detection.video.url,
        })
      : null;
  const baseContent =
    embeddedSelection?.baseContent ??
    selectBaseContent(articleContent, transcriptResolution.text, transcriptResolution.segments);
  const contentSections = embeddedSelection?.contentSections ?? null;
  const video = detectedVideo;
  const isVideoOnly =
    !transcriptResolution.text &&
    articleContent.length < MIN_HTML_CONTENT_CHARACTERS &&
    video !== null;

  return finalizeExtractedLinkContent({
    url,
    baseContent,
    contentSections,
    maxCharacters,
    title: mergedTitle ?? title,
    description: mergedDescription ?? description,
    siteName,
    transcriptResolution,
    video,
    isVideoOnly,
    diagnostics: {
      strategy: "html",
      firecrawl: firecrawlDiagnostics,
      markdown: markdownDiagnostics,
      transcript: transcriptDiagnostics,
      embeddedVideo: {
        mode: resolvedEmbeddedVideoMode,
        detected: embeddedYoutube.detection !== null,
        used: Boolean(embeddedYoutube.shouldUse && transcriptResolution.text),
        url: embeddedYoutube.detection?.video.url ?? null,
        source: embeddedYoutube.detection?.source ?? null,
        confidence: embeddedYoutube.detection?.confidence ?? null,
        composition: embeddedSelection?.composition ?? "article",
        notes: embeddedYoutube.notes,
      },
    },
  });
}
