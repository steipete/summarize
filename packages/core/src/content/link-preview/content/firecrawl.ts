import type { FirecrawlScrapeResult } from "../deps.js";
import { extractArticleContent, extractPlainText } from "./article.js";
import { normalizeForPrompt } from "./cleaner.js";
import {
  BLOCKED_HTML_HINT_PATTERN,
  MIN_HTML_CONTENT_CHARACTERS,
  MIN_HTML_DOCUMENT_CHARACTERS_FOR_FALLBACK,
  MIN_METADATA_DESCRIPTION_CHARACTERS,
  READABILITY_RELATIVE_THRESHOLD,
} from "./constants.js";
import { extractJsonLdContent } from "./jsonld.js";
import { composePageContent, resolvePageMedia, type PageExtractionContext } from "./page-media.js";
import { extractMetadataFromFirecrawl, extractMetadataFromHtml } from "./parsers.js";
import { isPodcastHost, isPodcastLikeJsonLdType } from "./podcast-utils.js";
import type { ExtractedLinkContent } from "./types.js";
import {
  appendNote,
  ensureTranscriptDiagnostics,
  finalizeExtractedLinkContent,
  pickFirstText,
  safeHostname,
} from "./utils.js";

export function shouldFallbackToFirecrawl(html: string): boolean {
  const plainText = normalizeForPrompt(extractPlainText(html));
  if (BLOCKED_HTML_HINT_PATTERN.test(plainText)) return true;
  const normalized = normalizeForPrompt(extractArticleContent(html));
  if (normalized.length >= MIN_HTML_CONTENT_CHARACTERS) {
    return false;
  }

  // Avoid spending Firecrawl on truly small/simple pages where the extracted HTML content is short but
  // likely complete (e.g. https://example.com). Only treat "thin" content as a Firecrawl signal when
  // the HTML document itself is large (SSR/app-shell pages, blocked pages without a match, etc.).
  return html.length >= MIN_HTML_DOCUMENT_CHARACTERS_FOR_FALLBACK;
}

export async function buildResultFromFirecrawl(
  options: PageExtractionContext & {
    payload: FirecrawlScrapeResult;
  },
): Promise<ExtractedLinkContent | null> {
  const { url, payload, cacheMode, maxCharacters, firecrawlDiagnostics, markdownRequested } =
    options;
  const extractionStartedAt = Date.now();
  const normalizedMarkdown = normalizeForPrompt(payload.markdown ?? "");
  if (normalizedMarkdown.length === 0) {
    firecrawlDiagnostics.notes = appendNote(
      firecrawlDiagnostics.notes,
      "Firecrawl markdown normalization yielded empty text",
    );
    return null;
  }

  const jsonLd = payload.html ? extractJsonLdContent(payload.html) : null;
  const isPodcastJsonLd = isPodcastLikeJsonLdType(jsonLd?.type);

  const media = await resolvePageMedia(
    options,
    payload.html ?? null,
    extractionStartedAt,
    Boolean(payload.html),
  );
  const { video, transcriptResolution } = media;
  const htmlMetadata = payload.html
    ? extractMetadataFromHtml(payload.html, url)
    : { title: null, description: null, siteName: null };
  const metadata = extractMetadataFromFirecrawl(payload.metadata ?? null);

  const title = pickFirstText([jsonLd?.title, metadata.title, htmlMetadata.title]);
  const description = pickFirstText([
    jsonLd?.description,
    metadata.description,
    htmlMetadata.description,
  ]);
  const siteName = pickFirstText([metadata.siteName, htmlMetadata.siteName, safeHostname(url)]);

  const descriptionCandidate = description ? normalizeForPrompt(description) : "";
  const preferDescription =
    descriptionCandidate.length >= MIN_METADATA_DESCRIPTION_CHARACTERS &&
    (isPodcastJsonLd ||
      isPodcastHost(url) ||
      normalizedMarkdown.length < MIN_HTML_CONTENT_CHARACTERS ||
      descriptionCandidate.length >= normalizedMarkdown.length * READABILITY_RELATIVE_THRESHOLD);
  const baseCandidate = preferDescription ? descriptionCandidate : normalizedMarkdown;
  const { baseContent, contentSections, embeddedVideo } = composePageContent(baseCandidate, media);
  if (baseContent.length === 0) {
    firecrawlDiagnostics.notes = appendNote(
      firecrawlDiagnostics.notes,
      "Firecrawl produced content that normalized to an empty string",
    );
    return null;
  }

  firecrawlDiagnostics.used = true;

  const transcriptDiagnostics = ensureTranscriptDiagnostics(
    transcriptResolution,
    cacheMode ?? "default",
  );

  const isVideoOnly =
    !transcriptResolution.text &&
    normalizedMarkdown.length < MIN_HTML_CONTENT_CHARACTERS &&
    video !== null;

  return finalizeExtractedLinkContent({
    url,
    baseContent,
    contentSections,
    maxCharacters,
    title,
    description,
    siteName,
    transcriptResolution,
    video,
    isVideoOnly,
    diagnostics: {
      strategy: "firecrawl",
      firecrawl: firecrawlDiagnostics,
      markdown: {
        requested: markdownRequested,
        used: true,
        provider: "firecrawl",
      },
      transcript: transcriptDiagnostics,
      embeddedVideo,
    },
  });
}
