import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { MediaCache } from "../content/index.js";
import { isDirectMediaUrl } from "../content/index.js";
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
  buildSlidesMediaCacheKey,
  formatBytes,
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
  buildSlidesMediaCacheKey: (url: string) => string;
  formatBytes: (bytes: number) => string;
  reportSlidesProgress?: SlidesIngestProgress | null;
  logSlidesTiming?: ((label: string, startedAt: number) => number) | null;
  downloadYoutubeVideo: (args: {
    ytDlpPath: string;
    url: string;
    timeoutMs: number;
    format: string;
    cookiesFromBrowser?: string | null;
    onProgress?: ((percent: number, detail?: string) => void) | null;
  }) => Promise<{ filePath: string; cleanup: () => Promise<void> }>;
  downloadRemoteVideo: (args: {
    url: string;
    timeoutMs: number;
    fetchImpl?: typeof fetch;
    onProgress?: ((percent: number, detail?: string) => void) | null;
  }) => Promise<{ filePath: string; cleanup: () => Promise<void> }>;
  resolveYoutubeStreamUrl: (args: {
    ytDlpPath: string;
    url: string;
    timeoutMs: number;
    format: string;
    cookiesFromBrowser?: string | null;
  }) => Promise<string>;
}): Promise<{
  inputPath: string;
  inputCleanup: (() => Promise<void>) | null;
  cachedMedia: Awaited<ReturnType<NonNullable<MediaCache>["get"]>> | null;
  warnings: string[];
}> {
  const warnings: string[] = [];
  const localInputPath = await resolveLocalSlidesInputPath(source.url);
  if (localInputPath) {
    reportSlidesProgress?.("using local video", 35);
    return {
      inputPath: localInputPath,
      inputCleanup: null,
      cachedMedia: null,
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
      cachedMedia,
      warnings,
    };
  }

  if (source.kind === "youtube") {
    if (!ytDlpPath) {
      throw new Error("Slides for YouTube require yt-dlp (set YT_DLP_PATH or install yt-dlp).");
    }
    const format = resolveSlidesYtDlpExtractFormat();
    reportSlidesProgress?.("downloading video", 6);
    const downloadStartedAt = Date.now();
    try {
      const downloaded = await downloadYoutubeVideo({
        ytDlpPath,
        url: source.url,
        timeoutMs,
        format,
        cookiesFromBrowser: ytDlpCookiesFromBrowser,
        onProgress: (percent, detail) => {
          reportSlidesProgress?.(
            "downloading video",
            6 + (Math.max(0, Math.min(100, percent)) / 100) * 29,
            detail,
          );
        },
      });
      const cached = mediaCacheKey
        ? await mediaCache?.put({
            url: mediaCacheKey,
            filePath: downloaded.filePath,
            filename: path.basename(downloaded.filePath),
          })
        : null;
      logSlidesTiming?.(`yt-dlp download (detect+extract, format=${format})`, downloadStartedAt);
      return {
        inputPath: cached?.filePath ?? downloaded.filePath,
        inputCleanup: downloaded.cleanup,
        cachedMedia: cached ?? null,
        warnings,
      };
    } catch (error) {
      if (!allowStreamFallback) throw error;
      warnings.push(`Failed to download video; falling back to stream URL: ${String(error)}`);
      reportSlidesProgress?.("fetching video", 6);
      const streamStartedAt = Date.now();
      const streamUrl = await resolveYoutubeStreamUrl({
        ytDlpPath,
        url: source.url,
        format,
        timeoutMs,
        cookiesFromBrowser: ytDlpCookiesFromBrowser,
      });
      logSlidesTiming?.(`yt-dlp stream url (detect+extract, format=${format})`, streamStartedAt);
      return {
        inputPath: streamUrl,
        inputCleanup: null,
        cachedMedia: null,
        warnings,
      };
    }
  }

  if (!isDirectMediaUrl(source.url)) {
    if (!ytDlpPath) {
      throw new Error(
        "Slides for remote videos require yt-dlp (set YT_DLP_PATH or install yt-dlp).",
      );
    }
    const format = resolveSlidesYtDlpExtractFormat();
    reportSlidesProgress?.("downloading video", 6);
    const downloadStartedAt = Date.now();
    try {
      const downloaded = await downloadYoutubeVideo({
        ytDlpPath,
        url: source.url,
        timeoutMs,
        format,
        cookiesFromBrowser: ytDlpCookiesFromBrowser,
        onProgress: (percent, detail) => {
          reportSlidesProgress?.(
            "downloading video",
            6 + (Math.max(0, Math.min(100, percent)) / 100) * 29,
            detail,
          );
        },
      });
      const cached = mediaCacheKey
        ? await mediaCache?.put({
            url: mediaCacheKey,
            filePath: downloaded.filePath,
            filename: path.basename(downloaded.filePath),
          })
        : null;
      logSlidesTiming?.(`yt-dlp download (direct source, format=${format})`, downloadStartedAt);
      return {
        inputPath: cached?.filePath ?? downloaded.filePath,
        inputCleanup: downloaded.cleanup,
        cachedMedia: cached ?? null,
        warnings,
      };
    } catch (error) {
      if (!allowStreamFallback) throw error;
      warnings.push(`Failed to download video; falling back to stream URL: ${String(error)}`);
      reportSlidesProgress?.("fetching video", 6);
      const streamStartedAt = Date.now();
      const streamUrl = await resolveYoutubeStreamUrl({
        ytDlpPath,
        url: source.url,
        format,
        timeoutMs,
        cookiesFromBrowser: ytDlpCookiesFromBrowser,
      });
      logSlidesTiming?.(`yt-dlp stream url (direct source, format=${format})`, streamStartedAt);
      return {
        inputPath: streamUrl,
        inputCleanup: null,
        cachedMedia: null,
        warnings,
      };
    }
  }

  reportSlidesProgress?.("downloading video", 6);
  const downloadStartedAt = Date.now();
  try {
    const downloaded = await downloadRemoteVideo({
      url: source.url,
      timeoutMs,
      fetchImpl,
      onProgress: (percent, detail) => {
        reportSlidesProgress?.(
          "downloading video",
          6 + (Math.max(0, Math.min(100, percent)) / 100) * 29,
          detail,
        );
      },
    });
    const cached = mediaCacheKey
      ? await mediaCache?.put({
          url: mediaCacheKey,
          filePath: downloaded.filePath,
          filename: path.basename(downloaded.filePath),
        })
      : null;
    logSlidesTiming?.("download direct video (detect+extract)", downloadStartedAt);
    return {
      inputPath: cached?.filePath ?? downloaded.filePath,
      inputCleanup: downloaded.cleanup,
      cachedMedia: cached ?? null,
      warnings,
    };
  } catch (error) {
    if (!allowStreamFallback || !allowRemoteUrlFallback) throw error;
    warnings.push(`Failed to download video; falling back to stream URL: ${String(error)}`);
    return {
      inputPath: source.url,
      inputCleanup: null,
      cachedMedia: null,
      warnings,
    };
  }
}
