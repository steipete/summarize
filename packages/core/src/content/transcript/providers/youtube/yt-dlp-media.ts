import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { basename, extname, join } from "node:path";
import { buildSharedVideoMediaCacheKey, type MediaCache } from "../../../cache/types.js";
import type { LinkPreviewProgressEvent } from "../../../link-preview/deps.js";
import { ProgressKind } from "../../../link-preview/deps.js";
import { resolveLocalDirectMediaSource, type LocalDirectMediaSource } from "../../../local-file.js";
import { runYtDlpDownload } from "./yt-dlp-process.js";

const DEFAULT_AUDIO_FORMAT =
  "bestaudio[vcodec=none]/best[height<=360][acodec!=none]/best[height<=480][acodec!=none]/best[height<=720][acodec!=none]/best[acodec!=none]";
const DEFAULT_SHARED_VIDEO_FORMAT =
  "bestvideo[height<=720][vcodec^=avc1][ext=mp4]/bestvideo[height<=720][ext=mp4]/bestvideo[height<=720],bestaudio[vcodec=none]";

export type AcquiredYtDlpMedia = {
  filePath: string;
  mediaType: string;
  filename: string;
  cleanup: () => Promise<void>;
};

export function resolveYtDlpLocalMediaSource(
  url: string,
  mediaKind: "video" | "audio" | null,
): LocalDirectMediaSource | null {
  return resolveLocalDirectMediaSource(url, mediaKind);
}

export async function acquireYtDlpMedia({
  ytDlpPath,
  url,
  service,
  mediaKind,
  mediaCache,
  downloadVideo,
  extraArgs,
  localFileInput,
  onProgress,
  onNote,
}: {
  ytDlpPath: string | null;
  url: string;
  service: "youtube" | "podcast" | "generic";
  mediaKind: "video" | "audio" | null;
  mediaCache: MediaCache | null;
  downloadVideo: boolean;
  extraArgs?: string[];
  localFileInput: LocalDirectMediaSource | null;
  onProgress?: ((event: LinkPreviewProgressEvent) => void) | null;
  onNote?: ((note: string) => void) | null;
}): Promise<AcquiredYtDlpMedia> {
  const mediaCacheKey = url;
  const sharedVideoMediaCacheKey = buildSharedVideoMediaCacheKey(url);
  const cachedMedia = localFileInput
    ? null
    : mediaCache
      ? await mediaCache.get({ url: mediaCacheKey })
      : null;
  const cachedSharedVideo =
    !localFileInput && downloadVideo && mediaCache
      ? await mediaCache.get({ url: sharedVideoMediaCacheKey })
      : null;
  if (cachedSharedVideo?.filePath) onNote?.("shared slide video cache hit");

  if (localFileInput) {
    onNote?.("local file input");
    return {
      filePath: localFileInput.filePath,
      mediaType: localFileInput.mediaType,
      filename: localFileInput.filename,
      cleanup: async () => {},
    };
  }

  if (cachedMedia?.filePath) {
    onProgress?.({
      kind: ProgressKind.TranscriptMediaDownloadStart,
      url,
      service,
      mediaUrl: url,
      mediaKind,
      totalBytes: cachedMedia.sizeBytes ?? null,
    });
    onProgress?.({
      kind: ProgressKind.TranscriptMediaDownloadDone,
      url,
      service,
      downloadedBytes: cachedMedia.sizeBytes ?? 0,
      totalBytes: cachedMedia.sizeBytes ?? null,
      mediaKind,
    });
    onNote?.("media cache hit");
    return {
      filePath: cachedMedia.filePath,
      mediaType:
        cachedMedia.mediaType ??
        inferMediaType(
          cachedMedia.filename ?? cachedMedia.filePath,
          downloadVideo ? "video" : "audio",
        ) ??
        "audio/mpeg",
      filename: cachedMedia.filename ?? basename(cachedMedia.filePath),
      cleanup: async () => {},
    };
  }

  if (!ytDlpPath) {
    throw new Error("yt-dlp is not configured (set YT_DLP_PATH or ensure yt-dlp is on PATH)");
  }

  onProgress?.({
    kind: ProgressKind.TranscriptMediaDownloadStart,
    url,
    service,
    mediaUrl: url,
    mediaKind,
    totalBytes: null,
  });
  const onDownloadProgress = onProgress
    ? (downloadedBytes: number, totalBytes: number | null) => {
        onProgress({
          kind: ProgressKind.TranscriptMediaDownloadProgress,
          url,
          service,
          downloadedBytes,
          totalBytes,
          mediaKind,
        });
      }
    : null;
  const outputFile = join(tmpdir(), `summarize-${randomUUID()}.mp3`);
  let cleanupDownloaded: (() => Promise<void>) | null = null;

  try {
    const downloaded =
      downloadVideo && !cachedSharedVideo?.filePath
        ? await downloadSlidesVideoAndAudio(ytDlpPath, url, extraArgs, onDownloadProgress)
        : await downloadAudio(ytDlpPath, url, outputFile, extraArgs, onDownloadProgress);
    let filePath = downloaded.filePath;
    let mediaType = downloaded.mediaType;
    let filename = downloaded.filename;
    cleanupDownloaded = downloaded.cleanup;
    const stat = await fs.stat(filePath);
    onProgress?.({
      kind: ProgressKind.TranscriptMediaDownloadDone,
      url,
      service,
      downloadedBytes: stat.size,
      totalBytes: null,
      mediaKind,
    });

    if (downloaded.sharedVideo && mediaCache) {
      const storedVideo = await mediaCache.put({
        url: sharedVideoMediaCacheKey,
        filePath: downloaded.sharedVideo.filePath,
        mediaType: downloaded.sharedVideo.mediaType,
        filename: downloaded.sharedVideo.filename,
      });
      if (storedVideo?.filePath) onNote?.("shared slide video cached");
    } else if (mediaCache) {
      const stored = await mediaCache.put({
        url: mediaCacheKey,
        filePath,
        mediaType,
        filename,
      });
      if (stored?.filePath) {
        filePath = stored.filePath;
        mediaType = stored.mediaType ?? mediaType;
        filename = stored.filename ?? filename;
        await cleanupDownloaded();
        cleanupDownloaded = null;
        onNote?.("media cached");
      }
    }

    return {
      filePath,
      mediaType,
      filename,
      cleanup: async () => {
        await cleanupDownloaded?.();
      },
    };
  } catch (error) {
    await cleanupDownloaded?.();
    throw error;
  }
}

async function downloadAudio(
  ytDlpPath: string,
  url: string,
  outputFile: string,
  extraArgs?: string[],
  onProgress?: ((downloadedBytes: number, totalBytes: number | null) => void) | null,
): Promise<{
  filePath: string;
  mediaType: string;
  filename: string;
  sharedVideo?: undefined;
  cleanup: () => Promise<void>;
}> {
  await runYtDlpDownload({
    ytDlpPath,
    url,
    output: outputFile,
    format: DEFAULT_AUDIO_FORMAT,
    extractAudio: true,
    extraArgs,
    onProgress,
  });
  return {
    filePath: outputFile,
    mediaType: "audio/mpeg",
    filename: "audio.mp3",
    cleanup: async () => {
      await fs.unlink(outputFile).catch(() => {});
    },
  };
}

async function downloadSlidesVideoAndAudio(
  ytDlpPath: string,
  url: string,
  extraArgs?: string[],
  onProgress?: ((downloadedBytes: number, totalBytes: number | null) => void) | null,
): Promise<{
  filePath: string;
  mediaType: string;
  filename: string;
  sharedVideo: {
    filePath: string;
    mediaType: string;
    filename: string;
  };
  cleanup: () => Promise<void>;
}> {
  const dir = await fs.mkdtemp(join(tmpdir(), `summarize-shared-video-${randomUUID()}-`));
  const outputTemplate = join(dir, "media.%(vcodec)s.%(acodec)s.%(ext)s");
  try {
    await runYtDlpDownload({
      ytDlpPath,
      url,
      output: outputTemplate,
      format: DEFAULT_SHARED_VIDEO_FORMAT,
      extractAudio: false,
      extraArgs,
      onProgress,
    });
    const entries = await fs.readdir(dir);
    const candidates = (
      await Promise.all(
        entries
          .filter((entry) => !entry.endsWith(".part") && !entry.endsWith(".ytdl"))
          .map(async (entry) => {
            const filePath = join(dir, entry);
            const stat = await fs.stat(filePath).catch(() => null);
            return stat?.isFile() ? { filePath, size: stat.size } : null;
          }),
      )
    ).filter((entry): entry is { filePath: string; size: number } => entry !== null);
    const audio = candidates
      .filter((entry) => basename(entry.filePath).startsWith("media.none."))
      .sort((a, b) => b.size - a.size)[0];
    const video = candidates
      .filter((entry) => !basename(entry.filePath).startsWith("media.none."))
      .sort((a, b) => b.size - a.size)[0];
    if (!audio || !video) {
      throw new Error("yt-dlp completed without both audio and video streams");
    }
    const audioFilename = basename(audio.filePath);
    const videoFilename = basename(video.filePath);
    return {
      filePath: audio.filePath,
      mediaType: inferMediaType(audioFilename, "audio") ?? "audio/webm",
      filename: audioFilename,
      sharedVideo: {
        filePath: video.filePath,
        mediaType: inferMediaType(videoFilename, "video") ?? "video/mp4",
        filename: videoFilename,
      },
      cleanup: async () => {
        await fs.rm(dir, { recursive: true, force: true });
      },
    };
  } catch (error) {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}

function inferMediaType(value: string, kind: "audio" | "video"): string | null {
  switch (extname(value).toLowerCase()) {
    case ".mp3":
      return "audio/mpeg";
    case ".m4a":
      return "audio/mp4";
    case ".mp4":
    case ".m4v":
    case ".mov":
      return kind === "audio" ? "audio/mp4" : "video/mp4";
    case ".webm":
      return kind === "audio" ? "audio/webm" : "video/webm";
    case ".mkv":
      return "video/x-matroska";
    default:
      return null;
  }
}
