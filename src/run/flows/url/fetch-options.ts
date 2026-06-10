import { isLocalFileUrl, resolveLocalFileMtime } from "@steipete/summarize-core/content/local-file";
import { isDirectVideoInput } from "@steipete/summarize-core/content/url";
import type { CacheMode, FetchLinkContentOptions } from "../../../content/index.js";

type UrlFetchFlags = {
  timeoutMs: number;
  maxExtractCharacters?: number | null;
  youtubeMode: "auto" | "web" | "apify" | "yt-dlp" | "no-auto";
  videoMode: "auto" | "transcript" | "understand";
  transcriptTimestamps: boolean;
  transcriptDiarization: "auto" | "elevenlabs" | "openai" | null;
  firecrawlMode: "off" | "auto" | "always";
  slides: object | null;
  throwOnAssetLikeHtmlError?: boolean;
};

type UrlMarkdownOptions = {
  effectiveMarkdownMode: "off" | "auto" | "llm" | "readability";
  markdownRequested: boolean;
};

export function shouldPreferTranscriptForTarget({
  targetUrl,
  videoMode,
  slides,
}: {
  targetUrl: string;
  videoMode: UrlFetchFlags["videoMode"];
  slides: UrlFetchFlags["slides"];
}): boolean {
  return videoMode === "transcript" || (Boolean(slides) && isDirectVideoInput(targetUrl));
}

export function resolveUrlFetchOptions({
  targetUrl,
  flags,
  markdown,
  cacheMode,
}: {
  targetUrl: string;
  flags: UrlFetchFlags;
  markdown: UrlMarkdownOptions;
  cacheMode: CacheMode;
}): { localFile: boolean; options: FetchLinkContentOptions } {
  const localFile = isLocalFileUrl(targetUrl);
  const options = {
    timeoutMs: flags.timeoutMs,
    maxCharacters:
      typeof flags.maxExtractCharacters === "number" && flags.maxExtractCharacters > 0
        ? flags.maxExtractCharacters
        : undefined,
    youtubeTranscript: flags.youtubeMode,
    mediaTranscript: shouldPreferTranscriptForTarget({
      targetUrl,
      videoMode: flags.videoMode,
      slides: flags.slides,
    })
      ? "prefer"
      : "auto",
    transcriptTimestamps: flags.transcriptTimestamps,
    transcriptDiarization: flags.transcriptDiarization,
    firecrawl: flags.firecrawlMode,
    format: markdown.markdownRequested ? "markdown" : "text",
    markdownMode: markdown.markdownRequested ? markdown.effectiveMarkdownMode : undefined,
    cacheMode,
    fileMtime: localFile ? resolveLocalFileMtime(targetUrl) : null,
    throwOnAssetLikeHtmlError: flags.throwOnAssetLikeHtmlError ?? false,
  } satisfies FetchLinkContentOptions;
  return {
    localFile,
    options,
  };
}
