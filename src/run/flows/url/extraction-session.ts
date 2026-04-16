import { NEGATIVE_TTL_MS } from "@steipete/summarize-core/content";
import * as urlUtils from "@steipete/summarize-core/content/url";
import { buildExtractCacheKey } from "../../../cache.js";
import {
  createLinkPreviewClient,
  type ExtractedLinkContent,
  type LinkPreviewProgressEvent,
} from "../../../content/index.js";
import { createFirecrawlScraper } from "../../../firecrawl.js";
import { resolveSlideSource } from "../../../slides/index.js";
import { readTweetWithPreferredClient } from "../../bird.js";
import { resolveTwitterCookies } from "../../cookies/twitter.js";
import { hasBirdCli, hasXurlCli } from "../../env.js";
import { writeVerbose } from "../../logging.js";
import { fetchLinkContentWithBirdTip } from "./extract.js";
import { resolveUrlFetchOptions } from "./fetch-options.js";
import type { UrlFlowContext } from "./types.js";

type LinkPreviewClientOptions = NonNullable<Parameters<typeof createLinkPreviewClient>[0]>;
type ConvertHtmlToMarkdown = LinkPreviewClientOptions["convertHtmlToMarkdown"];
type LinkPreviewProgressHandler = ((event: LinkPreviewProgressEvent) => void) | null;

export type UrlExtractionSession = {
  cacheStore: UrlFlowContext["cache"]["store"] | null;
  fetchInitialExtract: (url: string) => Promise<ExtractedLinkContent>;
  fetchWithCache: (
    targetUrl: string,
    options?: { bypassExtractCache?: boolean },
  ) => Promise<ExtractedLinkContent>;
};

export function createUrlExtractionSession({
  ctx,
  markdown,
  onProgress,
}: {
  ctx: UrlFlowContext;
  markdown: {
    convertHtmlToMarkdown: ConvertHtmlToMarkdown;
    effectiveMarkdownMode: "off" | "auto" | "llm" | "readability";
    markdownRequested: boolean;
  };
  onProgress: LinkPreviewProgressHandler;
}): UrlExtractionSession {
  const { io, flags, model, cache: cacheState } = ctx;
  const cacheStore = cacheState.mode === "default" ? cacheState.store : null;
  const transcriptCache = cacheStore ? cacheStore.transcriptCache : null;
  const firecrawlApiKey = model.apiStatus.firecrawlApiKey;
  const scrapeWithFirecrawl =
    model.apiStatus.firecrawlConfigured && flags.firecrawlMode !== "off" && firecrawlApiKey
      ? createFirecrawlScraper({
          apiKey: firecrawlApiKey,
          fetchImpl: io.fetch,
        })
      : null;

  const readTweetWithBirdClient =
    hasXurlCli(io.env) || hasBirdCli(io.env)
      ? ({ url, timeoutMs }: { url: string; timeoutMs: number }) =>
          readTweetWithPreferredClient({ url, timeoutMs, env: io.env })
      : null;

  const client = createLinkPreviewClient({
    env: io.envForRun,
    apifyApiToken: model.apiStatus.apifyToken,
    ytDlpPath: model.apiStatus.ytDlpPath,
    transcription: {
      env: io.envForRun,
      falApiKey: model.apiStatus.falApiKey,
      groqApiKey: model.apiStatus.groqApiKey,
      assemblyaiApiKey: model.apiStatus.assemblyaiApiKey,
      openaiApiKey: model.apiStatus.openaiApiKey,
      geminiApiKey: model.apiStatus.googleApiKey,
    },
    scrapeWithFirecrawl,
    convertHtmlToMarkdown: markdown.convertHtmlToMarkdown,
    readTweetWithBird: readTweetWithBirdClient,
    resolveTwitterCookies: async (_args) => {
      const res = await resolveTwitterCookies({ env: io.env });
      return {
        cookiesFromBrowser: res.cookies.cookiesFromBrowser,
        source: res.cookies.source,
        warnings: res.warnings,
      };
    },
    fetch: io.fetch,
    transcriptCache,
    mediaCache: ctx.mediaCache ?? null,
    onProgress,
  });

  const fetchWithCache = async (
    targetUrl: string,
    { bypassExtractCache = false }: { bypassExtractCache?: boolean } = {},
  ): Promise<ExtractedLinkContent> => {
    const { localFile, options } = resolveUrlFetchOptions({
      targetUrl,
      flags,
      markdown,
      cacheMode: cacheState.mode,
    });
    const cacheKey =
      !localFile && cacheStore && cacheState.mode === "default"
        ? buildExtractCacheKey({
            url: targetUrl,
            options: {
              youtubeTranscript: options.youtubeTranscript,
              mediaTranscript: options.mediaTranscript,
              firecrawl: options.firecrawl,
              format: options.format,
              markdownMode: options.markdownMode ?? null,
              transcriptTimestamps: options.transcriptTimestamps ?? false,
              ...(typeof options.maxCharacters === "number"
                ? { maxCharacters: options.maxCharacters }
                : {}),
            },
          })
        : null;
    if (!bypassExtractCache && cacheKey && cacheStore) {
      const cached = cacheStore.getJson<ExtractedLinkContent>("extract", cacheKey);
      if (cached) {
        writeVerbose(
          io.stderr,
          flags.verbose,
          "cache hit extract",
          flags.verboseColor,
          io.envForRun,
        );
        return cached;
      }
      writeVerbose(
        io.stderr,
        flags.verbose,
        "cache miss extract",
        flags.verboseColor,
        io.envForRun,
      );
    }
    try {
      const extracted = await fetchLinkContentWithBirdTip({
        client,
        url: targetUrl,
        options,
        env: io.env,
      });
      if (cacheKey && cacheStore) {
        const extractTtlMs =
          extracted.transcriptSource === "unavailable" ? NEGATIVE_TTL_MS : cacheState.ttlMs;
        cacheStore.setJson("extract", cacheKey, extracted, extractTtlMs);
        writeVerbose(
          io.stderr,
          flags.verbose,
          "cache write extract",
          flags.verboseColor,
          io.envForRun,
        );
      }
      return extracted;
    } catch (err) {
      const preferUrlMode =
        typeof urlUtils.shouldPreferUrlMode === "function"
          ? urlUtils.shouldPreferUrlMode(targetUrl)
          : false;
      const isTwitter = urlUtils.isTwitterStatusUrl?.(targetUrl) ?? false;
      const isPodcast = urlUtils.isPodcastHost?.(targetUrl) ?? false;
      if (!preferUrlMode || isTwitter || isPodcast) throw err;
      writeVerbose(
        io.stderr,
        flags.verbose,
        `extract fallback url-only (${(err as Error).message ?? String(err)})`,
        flags.verboseColor,
        io.envForRun,
      );
      return {
        content: "",
        title: null,
        description: null,
        url: targetUrl,
        siteName: null,
        wordCount: 0,
        totalCharacters: 0,
        truncated: false,
        mediaDurationSeconds: null,
        video: null,
        isVideoOnly: true,
        transcriptSource: null,
        transcriptCharacters: null,
        transcriptWordCount: null,
        transcriptLines: null,
        transcriptMetadata: null,
        transcriptSegments: null,
        transcriptTimedText: null,
        transcriptionProvider: null,
        diagnostics: {
          strategy: "html",
          firecrawl: {
            attempted: false,
            used: false,
            cacheMode: cacheState.mode,
            cacheStatus: "bypassed",
            notes: "skipped (url-only fallback)",
          },
          markdown: {
            requested: false,
            used: false,
            provider: null,
            notes: "skipped (url fallback)",
          },
          transcript: {
            cacheMode: cacheState.mode,
            cacheStatus: "unknown",
            textProvided: false,
            provider: null,
            attemptedProviders: [],
          },
        },
      };
    }
  };

  const fetchInitialExtract = async (url: string): Promise<ExtractedLinkContent> => {
    let extracted = await fetchWithCache(url);
    if (flags.slides && !resolveSlideSource({ url, extracted })) {
      const isTwitter = urlUtils.isTwitterStatusUrl?.(url) ?? false;
      if (isTwitter) {
        const refreshed = await fetchWithCache(url, { bypassExtractCache: true });
        if (resolveSlideSource({ url, extracted: refreshed })) {
          writeVerbose(
            io.stderr,
            flags.verbose,
            "extract refresh for slides",
            flags.verboseColor,
            io.envForRun,
          );
          extracted = refreshed;
        }
      }
    }
    return extracted;
  };

  return {
    cacheStore,
    fetchInitialExtract,
    fetchWithCache,
  };
}
