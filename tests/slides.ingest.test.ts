import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { prepareSlidesInput } from "../src/slides/ingest.js";

const remoteSources = [
  { kind: "youtube", url: "https://youtube.com/watch?v=abc", sourceId: "yt:abc" },
  { kind: "direct", url: "https://vimeo.com/123", sourceId: "vimeo:123" },
  { kind: "direct", url: "https://cdn.example/video.mp4", sourceId: "direct:123" },
] as const;

function ingestOptions(source: (typeof remoteSources)[number]) {
  return {
    source,
    mediaCache: null,
    timeoutMs: 1000,
    ytDlpPath: "/usr/bin/yt-dlp",
    ytDlpCookiesFromBrowser: "firefox",
    resolveSlidesYtDlpExtractFormat: () => "best",
    resolveSlidesStreamFallback: () => true,
    reportSlidesProgress: vi.fn(),
    logSlidesTiming: vi.fn(),
    downloadYoutubeVideo: vi.fn(),
    downloadRemoteVideo: vi.fn(),
    resolveYoutubeStreamUrl: vi.fn(async () => "https://stream.example/video.m3u8"),
  };
}

describe("slides ingest", () => {
  it.each(remoteSources)("shares cache, cleanup, and progress for $url", async (source) => {
    const options = ingestOptions(source);
    const cleanup = vi.fn(async () => {});
    const downloaded = { filePath: "/tmp/downloaded.mp4", cleanup };
    const download = vi.fn(async ({ onProgress }) => {
      onProgress(-10, "starting");
      onProgress(150, "finished");
      return downloaded;
    });
    options.downloadYoutubeVideo.mockImplementation(download);
    options.downloadRemoteVideo.mockImplementation(download);
    const put = vi.fn(async () => ({ filePath: "/tmp/cached.mp4", sizeBytes: 2048 }));
    const result = await prepareSlidesInput({
      ...options,
      mediaCache: { get: vi.fn(async () => null), put } as never,
    });
    expect(download).toHaveBeenCalledOnce();
    const usesYtDlp = !source.url.endsWith(".mp4");
    expect(options.downloadYoutubeVideo).toHaveBeenCalledTimes(usesYtDlp ? 1 : 0);
    expect(options.downloadRemoteVideo).toHaveBeenCalledTimes(usesYtDlp ? 0 : 1);
    expect(download).toHaveBeenCalledWith(
      expect.objectContaining({
        url: source.url,
        timeoutMs: 1000,
        ...(usesYtDlp ? { format: "best", cookiesFromBrowser: "firefox" } : {}),
      }),
    );
    expect(put).toHaveBeenCalledWith(
      expect.objectContaining({
        filePath: downloaded.filePath,
        filename: "downloaded.mp4",
      }),
    );
    expect(result).toEqual({ inputPath: "/tmp/cached.mp4", inputCleanup: cleanup, warnings: [] });
    expect(options.reportSlidesProgress.mock.calls).toEqual([
      ["downloading video", 6],
      ["downloading video", 6, "starting"],
      ["downloading video", 35, "finished"],
    ]);
    expect(options.logSlidesTiming).toHaveBeenCalledOnce();
    expect(options.resolveYoutubeStreamUrl).not.toHaveBeenCalled();
  });

  it.each(remoteSources)("preserves stream fallback policy for $url", async (source) => {
    for (const allowStreamFallback of [false, true]) {
      for (const allowRemoteUrlFallback of [false, true]) {
        const options = ingestOptions(source);
        options.resolveSlidesStreamFallback = () => allowStreamFallback;
        options.downloadYoutubeVideo.mockRejectedValue(new Error("download failed"));
        options.downloadRemoteVideo.mockRejectedValue(new Error("download failed"));
        const result = prepareSlidesInput({ ...options, allowRemoteUrlFallback });
        const isExtractedRemote = source.url.includes("vimeo.com");
        if (allowStreamFallback && (allowRemoteUrlFallback || isExtractedRemote)) {
          await expect(result).resolves.toMatchObject({
            inputPath: source.url.endsWith(".mp4")
              ? source.url
              : "https://stream.example/video.m3u8",
            inputCleanup: null,
            warnings: [expect.stringContaining("Failed to download video")],
          });
          expect(options.resolveYoutubeStreamUrl).toHaveBeenCalledTimes(
            source.url.endsWith(".mp4") ? 0 : 1,
          );
        } else {
          await expect(result).rejects.toThrow("download failed");
          expect(options.resolveYoutubeStreamUrl).not.toHaveBeenCalled();
        }
      }
    }
  });

  it("short-circuits on cached media", async () => {
    const get = vi.fn(async () => ({ filePath: "/tmp/cached.mp4", sizeBytes: 2048 }));
    const progress = vi.fn();

    const result = await prepareSlidesInput({
      source: { kind: "youtube", url: "https://youtube.com/watch?v=abc", sourceId: "yt:abc" },
      mediaCache: { get, put: vi.fn() } as never,
      timeoutMs: 1000,
      ytDlpPath: "/usr/bin/yt-dlp",
      ytDlpCookiesFromBrowser: null,
      resolveSlidesYtDlpExtractFormat: () => "best",
      resolveSlidesStreamFallback: () => false,

      reportSlidesProgress: progress,
      logSlidesTiming: vi.fn(),
      downloadYoutubeVideo: vi.fn(),
      downloadRemoteVideo: vi.fn(),
      resolveYoutubeStreamUrl: vi.fn(),
    });

    expect(result.inputPath).toBe("/tmp/cached.mp4");
    expect(result.inputCleanup).toBeNull();
    expect(progress).toHaveBeenCalledWith("using cached video", 35, "(2KB)");
  });

  it("falls back to a stream URL for YouTube when enabled", async () => {
    const downloadYoutubeVideo = vi.fn(async () => {
      throw new Error("download failed");
    });
    const resolveYoutubeStreamUrl = vi.fn(async () => "https://stream.example/video.m3u8");

    const result = await prepareSlidesInput({
      source: { kind: "youtube", url: "https://youtube.com/watch?v=abc", sourceId: "yt:abc" },
      mediaCache: null,
      timeoutMs: 1000,
      ytDlpPath: "/usr/bin/yt-dlp",
      ytDlpCookiesFromBrowser: "firefox",
      resolveSlidesYtDlpExtractFormat: () => "best",
      resolveSlidesStreamFallback: () => true,

      reportSlidesProgress: vi.fn(),
      logSlidesTiming: vi.fn(),
      downloadYoutubeVideo,
      downloadRemoteVideo: vi.fn(),
      resolveYoutubeStreamUrl,
    });

    expect(downloadYoutubeVideo).toHaveBeenCalled();
    expect(resolveYoutubeStreamUrl).toHaveBeenCalledWith({
      ytDlpPath: "/usr/bin/yt-dlp",
      url: "https://youtube.com/watch?v=abc",
      format: "best",
      timeoutMs: 1000,
      cookiesFromBrowser: "firefox",
    });
    expect(result.inputPath).toBe("https://stream.example/video.m3u8");
    expect(result.warnings[0]).toContain("Failed to download video; falling back to stream URL");
  });

  it("requires yt-dlp for uncached YouTube slides", async () => {
    await expect(
      prepareSlidesInput({
        source: { kind: "youtube", url: "https://youtube.com/watch?v=abc", sourceId: "yt:abc" },
        mediaCache: null,
        timeoutMs: 1000,
        ytDlpPath: null,
        ytDlpCookiesFromBrowser: null,
        resolveSlidesYtDlpExtractFormat: () => "best",
        resolveSlidesStreamFallback: () => false,

        reportSlidesProgress: vi.fn(),
        logSlidesTiming: vi.fn(),
        downloadYoutubeVideo: vi.fn(),
        downloadRemoteVideo: vi.fn(),
        resolveYoutubeStreamUrl: vi.fn(),
      }),
    ).rejects.toThrow(/Slides for YouTube require yt-dlp/);
  });

  it("downloads direct remote video and preserves cleanup", async () => {
    const cleanup = vi.fn(async () => {});
    const fetchImpl = vi.fn();
    const downloadRemoteVideo = vi.fn(async () => ({
      filePath: "/tmp/direct.mp4",
      cleanup,
    }));
    const put = vi.fn(async ({ filePath }: { filePath: string }) => ({
      filePath,
      sizeBytes: 4096,
    }));

    const result = await prepareSlidesInput({
      source: { kind: "direct", url: "https://cdn.example/video.mp4", sourceId: "direct:1" },
      mediaCache: { get: vi.fn(async () => null), put } as never,
      timeoutMs: 1000,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      ytDlpPath: null,
      ytDlpCookiesFromBrowser: null,
      resolveSlidesYtDlpExtractFormat: () => "best",
      resolveSlidesStreamFallback: () => false,

      reportSlidesProgress: vi.fn(),
      logSlidesTiming: vi.fn(),
      downloadYoutubeVideo: vi.fn(),
      downloadRemoteVideo,
      resolveYoutubeStreamUrl: vi.fn(),
    });

    expect(downloadRemoteVideo).toHaveBeenCalledWith(
      expect.objectContaining({ fetchImpl, url: "https://cdn.example/video.mp4" }),
    );
    expect(put).toHaveBeenCalled();
    expect(result.inputPath).toBe("/tmp/direct.mp4");
    expect(result.inputCleanup).toBe(cleanup);
  });

  it("does not return a remote URL fallback when that fallback is disabled", async () => {
    const downloadRemoteVideo = vi.fn(async () => {
      throw new Error("guarded download rejected");
    });

    await expect(
      prepareSlidesInput({
        source: { kind: "direct", url: "https://cdn.example/video.mp4", sourceId: "direct:1" },
        mediaCache: null,
        timeoutMs: 1000,
        ytDlpPath: null,
        allowRemoteUrlFallback: false,
        ytDlpCookiesFromBrowser: null,
        resolveSlidesYtDlpExtractFormat: () => "best",
        resolveSlidesStreamFallback: () => true,

        reportSlidesProgress: vi.fn(),
        logSlidesTiming: vi.fn(),
        downloadYoutubeVideo: vi.fn(),
        downloadRemoteVideo,
        resolveYoutubeStreamUrl: vi.fn(),
      }),
    ).rejects.toThrow(/guarded download rejected/);
  });

  it("does not return a YouTube stream fallback when remote fallback is disabled", async () => {
    const downloadYoutubeVideo = vi.fn(async () => {
      throw new Error("guarded youtube download rejected");
    });
    const resolveYoutubeStreamUrl = vi.fn(async () => "https://stream.example/video.m3u8");

    await expect(
      prepareSlidesInput({
        source: { kind: "youtube", url: "https://youtube.com/watch?v=abc", sourceId: "yt:abc" },
        mediaCache: null,
        timeoutMs: 1000,
        ytDlpPath: "/usr/bin/yt-dlp",
        allowRemoteUrlFallback: false,
        ytDlpCookiesFromBrowser: null,
        resolveSlidesYtDlpExtractFormat: () => "best",
        resolveSlidesStreamFallback: () => true,

        reportSlidesProgress: vi.fn(),
        logSlidesTiming: vi.fn(),
        downloadYoutubeVideo,
        downloadRemoteVideo: vi.fn(),
        resolveYoutubeStreamUrl,
      }),
    ).rejects.toThrow(/guarded youtube download rejected/);
    expect(resolveYoutubeStreamUrl).not.toHaveBeenCalled();
  });

  it("uses local file URLs directly without downloading", async () => {
    const filePath = path.join(tmpdir(), `summarize-slides-local-${Date.now().toString()}.webm`);
    await fs.writeFile(filePath, "video");

    try {
      const downloadYoutubeVideo = vi.fn();
      const downloadRemoteVideo = vi.fn();
      const result = await prepareSlidesInput({
        source: {
          kind: "direct",
          url: pathToFileURL(filePath).href,
          sourceId: "local-video",
        },
        mediaCache: null,
        timeoutMs: 1000,
        ytDlpPath: null,
        ytDlpCookiesFromBrowser: null,
        resolveSlidesYtDlpExtractFormat: () => "best",
        resolveSlidesStreamFallback: () => false,

        reportSlidesProgress: vi.fn(),
        logSlidesTiming: vi.fn(),
        downloadYoutubeVideo,
        downloadRemoteVideo,
        resolveYoutubeStreamUrl: vi.fn(),
      });

      expect(result.inputPath).toBe(filePath);
      expect(result.inputCleanup).toBeNull();
      expect(downloadYoutubeVideo).not.toHaveBeenCalled();
      expect(downloadRemoteVideo).not.toHaveBeenCalled();
    } finally {
      await fs.rm(filePath, { force: true });
    }
  });
});
