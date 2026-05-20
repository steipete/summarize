import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { prepareSlidesInput } from "../src/slides/ingest.js";

describe("slides ingest", () => {
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
      buildSlidesMediaCacheKey: (url) => `${url}#slides`,
      formatBytes: (bytes) => `${bytes}B`,
      reportSlidesProgress: progress,
      logSlidesTiming: vi.fn(),
      downloadYoutubeVideo: vi.fn(),
      downloadRemoteVideo: vi.fn(),
      resolveYoutubeStreamUrl: vi.fn(),
    });

    expect(result.inputPath).toBe("/tmp/cached.mp4");
    expect(result.inputCleanup).toBeNull();
    expect(progress).toHaveBeenCalledWith("using cached video", 35, "(2048B)");
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
      buildSlidesMediaCacheKey: (url) => `${url}#slides`,
      formatBytes: (bytes) => `${bytes}B`,
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
      buildSlidesMediaCacheKey: (url) => `${url}#slides`,
      formatBytes: (bytes) => `${bytes}B`,
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
        buildSlidesMediaCacheKey: (url) => `${url}#slides`,
        formatBytes: (bytes) => `${bytes}B`,
        reportSlidesProgress: vi.fn(),
        logSlidesTiming: vi.fn(),
        downloadYoutubeVideo: vi.fn(),
        downloadRemoteVideo,
        resolveYoutubeStreamUrl: vi.fn(),
      }),
    ).rejects.toThrow(/guarded download rejected/);
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
        buildSlidesMediaCacheKey: (url) => `${url}#slides`,
        formatBytes: (bytes) => `${bytes}B`,
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
