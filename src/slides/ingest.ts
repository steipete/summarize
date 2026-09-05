import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { MediaCache } from "../content/index.js";
import { isDirectMediaUrl } from "../content/index.js";
import { buildSlidesMediaCacheKey, formatBytes } from "./download.js";
import type * as downloads from "./download.js";
import type { SlideSource } from "./types.js";

export type SlidesIngestProgress = (label: string, percent: number, detail?: string) => void;

async function resolveLocalSlidesInputPath(url: string): Promise<string | null> {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "file:") return null;
    parsed.search = "";
    parsed.hash = "";
    const filePath = fileURLToPath(parsed);
    const stat = await fs.stat(filePath);
    return stat.isFile() ? filePath : null;
  } catch {
    return null;
  }
}

export async function prepareSlidesInput({
  source,
  mediaCache,
  timeoutMs,
  fetchImpl,
  ytDlpPath,
  allowRemoteUrlFallback = true,
  ytDlpCookiesFromBrowser,
  resolveSlidesYtDlpExtractFormat,
  resolveSlidesStreamFallback,
  reportSlidesProgress,
  logSlidesTiming,
  downloadYoutubeVideo,
  downloadRemoteVideo,
  resolveYoutubeStreamUrl,
}: {
  source: SlideSource;
  mediaCache: MediaCache | null;
  timeoutMs: number;
  fetchImpl?: typeof fetch;
  ytDlpPath: string | null;
  allowRemoteUrlFallback?: boolean;
  ytDlpCookiesFromBrowser?: string | null;
  resolveSlidesYtDlpExtractFormat: () => string;
  resolveSlidesStreamFallback: () => boolean;
  reportSlidesProgress?: SlidesIngestProgress | null;
  logSlidesTiming?: ((label: string, startedAt: number) => number) | null;
  downloadYoutubeVideo: typeof downloads.downloadYoutubeVideo;
  downloadRemoteVideo: typeof downloads.downloadRemoteVideo;
  resolveYoutubeStreamUrl: typeof downloads.resolveYoutubeStreamUrl;
}): Promise<{
  inputPath: string;
  inputCleanup: (() => Promise<void>) | null;
  warnings: string[];
}> {
  const warnings: string[] = [];
  const localInputPath = await resolveLocalSlidesInputPath(source.url);
  if (localInputPath) {
    reportSlidesProgress?.("using local video", 35);
    return {
      inputPath: localInputPath,
      inputCleanup: null,
      warnings,
    };
  }

  const allowStreamFallback = resolveSlidesStreamFallback();
  const mediaCacheKey = mediaCache ? buildSlidesMediaCacheKey(source.url) : null;
  const cachedMedia = mediaCacheKey ? await mediaCache?.get({ url: mediaCacheKey }) : null;

  if (cachedMedia) {
    const detail =
      typeof cachedMedia.sizeBytes === "number"
        ? `(${formatBytes(cachedMedia.sizeBytes)})`
        : undefined;
    reportSlidesProgress?.("using cached video", 35, detail);
    return {
      inputPath: cachedMedia.filePath,
      inputCleanup: null,
      warnings,
    };
  }

  const needsYtDlp = source.kind === "youtube" || !isDirectMediaUrl(source.url);
  if (needsYtDlp && !ytDlpPath) {
    const sourceLabel = source.kind === "youtube" ? "YouTube" : "remote videos";
    throw new Error(
      `Slides for ${sourceLabel} require yt-dlp (set YT_DLP_PATH or install yt-dlp).`,
    );
  }
  const ytDlpOptions = needsYtDlp
    ? {
        ytDlpPath: ytDlpPath!,
        url: source.url,
        timeoutMs,
        format: resolveSlidesYtDlpExtractFormat(),
        cookiesFromBrowser: ytDlpCookiesFromBrowser,
      }
    : null;
  const timingDetail = ytDlpOptions
    ? `${source.kind === "youtube" ? "detect+extract" : "direct source"}, format=${ytDlpOptions.format}`
    : "detect+extract";
  const onProgress = (percent: number, detail?: string) => {
    reportSlidesProgress?.(
      "downloading video",
      6 + (Math.max(0, Math.min(100, percent)) / 100) * 29,
      detail,
    );
  };

  reportSlidesProgress?.("downloading video", 6);
  const downloadStartedAt = Date.now();
  try {
    const downloaded = ytDlpOptions
      ? await downloadYoutubeVideo({ ...ytDlpOptions, onProgress })
      : await downloadRemoteVideo({ url: source.url, timeoutMs, fetchImpl, onProgress });
    const cached = mediaCacheKey
      ? await mediaCache?.put({
          url: mediaCacheKey,
          filePath: downloaded.filePath,
          filename: path.basename(downloaded.filePath),
        })
      : null;
    logSlidesTiming?.(
      ytDlpOptions ? `yt-dlp download (${timingDetail})` : "download direct video (detect+extract)",
      downloadStartedAt,
    );
    return {
      inputPath: cached?.filePath ?? downloaded.filePath,
      inputCleanup: downloaded.cleanup,
      warnings,
    };
  } catch (error) {
    const remoteFallbackAllowed =
      allowRemoteUrlFallback || (needsYtDlp && source.kind !== "youtube");
    if (!allowStreamFallback || !remoteFallbackAllowed) throw error;
    warnings.push(`Failed to download video; falling back to stream URL: ${String(error)}`);
    if (!ytDlpOptions) {
      return { inputPath: source.url, inputCleanup: null, warnings };
    }
    reportSlidesProgress?.("fetching video", 6);
    const streamStartedAt = Date.now();
    const streamUrl = await resolveYoutubeStreamUrl(ytDlpOptions);
    logSlidesTiming?.(`yt-dlp stream url (${timingDetail})`, streamStartedAt);
    return { inputPath: streamUrl, inputCleanup: null, warnings };
  }
}
