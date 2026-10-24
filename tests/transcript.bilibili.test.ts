import { beforeEach, describe, expect, it, vi } from "vitest";
import { fetchLinkContent } from "../packages/core/src/content/link-preview/content/index.js";
import { resolveTranscriptForLink } from "../packages/core/src/content/transcript/index.js";
import { fetchTranscript } from "../packages/core/src/content/transcript/providers/generic.js";
import { parseBilibiliVideoUrl } from "../packages/core/src/content/url.js";

const { download } = vi.hoisted(() => ({ download: vi.fn() }));
vi.mock("../packages/core/src/content/transcript/providers/youtube/yt-dlp.js", () => ({
  fetchTranscriptWithYtDlp: download,
}));

const url = "https://www.bilibili.com/video/BV1js411R7qA/";
const options = (overrides: Partial<Parameters<typeof fetchTranscript>[1]> = {}) => ({
  fetch: vi.fn<typeof fetch>(
    async () =>
      new Response(
        "<html><body><article>A video description, without speech.</article></body></html>",
        { headers: { "content-type": "text/html" } },
      ),
  ),
  scrapeWithFirecrawl: null,
  convertHtmlToMarkdown: null,
  transcriptCache: null,
  apifyApiToken: null,
  youtubeTranscriptMode: "auto" as const,
  mediaTranscriptMode: "prefer" as const,
  ytDlpPath: "/usr/bin/yt-dlp",
  openaiApiKey: "test",
  env: {},
  ...overrides,
});

beforeEach(() => {
  vi.clearAllMocks();
  download.mockResolvedValue({
    text: "Reverse the direction of the wrap to tie a stronger knot.",
    provider: "whisper.cpp",
    notes: [],
    error: null,
    segments: [{ startMs: 0, endMs: 1000, text: "Reverse the wrap." }],
  });
});

describe("Bilibili CLI transcript acquisition", () => {
  it("downloads the recording rather than an embedded player, preserving the selected part", async () => {
    const result = await fetchTranscript(
      {
        url: "https://www.bilibili.com/en/video/BV1js411R7qA/?p=2&share_source=copy",
        html: '<meta property="og:video" content="https://player.bilibili.com/player.html?bvid=BV1js411R7qA">',
        resourceKey: null,
      },
      options(),
    );

    expect(result.text).toContain("stronger knot");
    expect(download).toHaveBeenCalledWith(
      expect.objectContaining({
        url: "https://www.bilibili.com/video/BV1js411R7qA/?p=2",
        mediaKind: "video",
        extraArgs: ["--http-chunk-size", "1M"],
      }),
    );
    expect(result.metadata).toMatchObject({ site: "bilibili", videoId: "BV1js411R7qA", part: 2 });
  });

  it("does not start native media acquisition in auto mode", async () => {
    await fetchTranscript(
      { url, html: null, resourceKey: null },
      options({ mediaTranscriptMode: "auto" }),
    );
    expect(download).not.toHaveBeenCalled();
  });

  it("only forwards explicitly configured browser cookies", async () => {
    await fetchTranscript(
      { url, html: null, resourceKey: null },
      options({ env: { SUMMARIZE_YT_DLP_COOKIES_FROM_BROWSER: " chrome:Profile 1 " } }),
    );
    expect(download).toHaveBeenCalledWith(
      expect.objectContaining({
        extraArgs: ["--http-chunk-size", "1M", "--cookies-from-browser", "chrome:Profile 1"],
      }),
    );
  });

  it("accepts the legacy cookie environment name", async () => {
    await fetchTranscript(
      { url, html: null, resourceKey: null },
      options({ env: { YT_DLP_COOKIES_FROM_BROWSER: "firefox" } }),
    );
    expect(download).toHaveBeenCalledWith(
      expect.objectContaining({
        extraArgs: ["--http-chunk-size", "1M", "--cookies-from-browser", "firefox"],
      }),
    );
  });

  it("leaves downloader options unchanged for other media", async () => {
    await fetchTranscript(
      { url: "https://example.com/video.mp4", html: null, resourceKey: null },
      options({ env: { SUMMARIZE_YT_DLP_COOKIES_FROM_BROWSER: "chrome" } }),
    );
    expect(download).toHaveBeenCalledWith(
      expect.objectContaining({ url: "https://example.com/video.mp4", extraArgs: undefined }),
    );
  });

  it("extracts speech without fetching or summarizing the landing-page description", async () => {
    const opts = options();
    const result = await fetchLinkContent(url, { mediaTranscript: "prefer", format: "text" }, opts);
    expect(opts.fetch).not.toHaveBeenCalled();
    expect(result.transcriptSource).toBe("yt-dlp");
    expect(result.content).toContain("stronger knot");
    expect(result.siteName).toBe("Bilibili");
  });

  it("reports download failure instead of falling back to page text", async () => {
    download.mockResolvedValue({
      text: null,
      provider: null,
      notes: [],
      error: new Error("HTTP Error 567"),
    });
    const opts = options();
    await expect(fetchLinkContent(url, { mediaTranscript: "prefer" }, opts)).rejects.toThrow(
      /Failed to transcribe Bilibili video.*567/,
    );
    expect(opts.fetch).not.toHaveBeenCalled();
  });

  it("reports missing yt-dlp without falling back to page text", async () => {
    const opts = options({ ytDlpPath: null });
    await expect(fetchLinkContent(url, { mediaTranscript: "prefer" }, opts)).rejects.toThrow(
      /yt-dlp is not configured/,
    );
    expect(download).not.toHaveBeenCalled();
    expect(opts.fetch).not.toHaveBeenCalled();
  });

  it("reports missing transcription setup", async () => {
    await expect(
      fetchLinkContent(
        url,
        { mediaTranscript: "prefer" },
        options({ openaiApiKey: null, env: { SUMMARIZE_DISABLE_LOCAL_WHISPER_CPP: "1" } }),
      ),
    ).rejects.toThrow(/Missing transcription provider/);
    expect(download).not.toHaveBeenCalled();
  });

  it("rejects an empty downloader transcript", async () => {
    download.mockResolvedValue({ text: null, provider: null, notes: [], error: null });
    await expect(fetchLinkContent(url, { mediaTranscript: "prefer" }, options())).rejects.toThrow(
      /Failed to transcribe Bilibili video/,
    );
  });

  it("does not select incidental YouTube captions or reuse a legacy page transcript", async () => {
    const opts = options();
    const result = await resolveTranscriptForLink(
      url,
      '<iframe src="https://www.youtube.com/embed/dQw4w9WgXcQ"></iframe>',
      {
        ...opts,
        transcriptCache: {
          get: async () => ({
            content: "Unrelated embedded captions",
            source: "captionTracks",
            expired: false,
          }),
          set: vi.fn(),
        },
      },
      { mediaTranscriptMode: "prefer" },
    );
    expect(result.text).toContain("stronger knot");
    expect(download).toHaveBeenCalledWith(expect.objectContaining({ url }));
  });

  it("reuses a verified transcript for the selected recording part", async () => {
    const result = await resolveTranscriptForLink(
      `${url}?p=2`,
      null,
      {
        ...options(),
        transcriptCache: {
          get: async () => ({
            content: "The second part",
            source: "yt-dlp",
            expired: false,
            metadata: { site: "bilibili", videoUrl: `${url}?p=2` },
          }),
          set: vi.fn(),
        },
      },
      { mediaTranscriptMode: "prefer" },
    );
    expect(result.text).toBe("The second part");
    expect(download).not.toHaveBeenCalled();
  });

  it("refreshes a cached transcript belonging to a different part", async () => {
    const result = await resolveTranscriptForLink(
      `${url}?p=2`,
      null,
      {
        ...options(),
        transcriptCache: {
          get: async () => ({
            content: "The first part",
            source: "yt-dlp",
            expired: false,
            metadata: { site: "bilibili", videoUrl: url },
          }),
          set: vi.fn(),
        },
      },
      { mediaTranscriptMode: "prefer" },
    );
    expect(result.text).toContain("stronger knot");
    expect(download).toHaveBeenCalledWith(expect.objectContaining({ url: `${url}?p=2` }));
  });
});

describe("Bilibili recording URL identity", () => {
  it.each([
    [url, 1, url],
    ["http://bilibili.com/video/BV1js411R7qA", 1, url],
    ["https://www.bilibili.com/zh-Hans/video/BV1js411R7qA/?p=02&share=copy#t=30", 2, `${url}?p=2`],
    ["https://www.bilibili.com/en/video/BV1js411R7qA?p=1", 1, url],
  ])("preserves recording and part for %s", (input, part, canonical) => {
    expect(parseBilibiliVideoUrl(input)).toEqual({ videoId: "BV1js411R7qA", part, url: canonical });
  });

  it.each([
    "https://bilibili.com.evil.test/video/BV1js411R7qA/",
    "https://evil.test/video/BV1js411R7qA/",
    "https://user@www.bilibili.com/video/BV1js411R7qA/",
    "https://www.bilibili.com:8443/video/BV1js411R7qA/",
    "ftp://www.bilibili.com/video/BV1js411R7qA/",
    "https://www.bilibili.com/video/BV1js411R7qA/extra",
    "https://www.bilibili.com/video/BV1js411R7qA/?p=0",
    "https://www.bilibili.com/video/BV1js411R7qA/?p=-1",
    "https://www.bilibili.com/video/BV1js411R7qA/?p=1.5",
    "https://www.bilibili.com/video/BV1js411R7qA/?p=1&p=2",
    "https://www.bilibili.com/video/BV1js411R7qA/?p=9007199254740992",
    "https://www.bilibili.com/video/invalid/",
    "https://b23.tv/short",
    "not a URL",
  ])("does not recognize unsupported recording URL %s", (input) => {
    expect(parseBilibiliVideoUrl(input)).toBeNull();
  });
});
