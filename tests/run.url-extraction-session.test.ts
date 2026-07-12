import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";

const createLinkPreviewClient = vi.hoisted(() => vi.fn());
const fetchYoutubeSourceMetrics = vi.hoisted(() => vi.fn());
const buildExtractCacheKey = vi.hoisted(() => vi.fn(() => "extract-key"));
const fetchLinkContentWithBirdTip = vi.hoisted(() => vi.fn());
const identifySpeakersInExtractedContent = vi.hoisted(() => vi.fn());
const rememberSpeakerMappings = vi.hoisted(() => vi.fn());

vi.mock("../src/content/index.js", () => ({
  createLinkPreviewClient,
}));

vi.mock("@steipete/summarize-core/content", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@steipete/summarize-core/content")>()),
  fetchYoutubeSourceMetrics,
}));

vi.mock("../src/cache.js", () => ({
  buildExtractCacheKey,
}));

vi.mock("../src/run/flows/url/extract.js", () => ({
  fetchLinkContentWithBirdTip,
}));

vi.mock("../src/speaker-identification/index.js", () => ({
  identifySpeakersInExtractedContent,
  rememberSpeakerMappings,
  SpeakerIdentificationError: class SpeakerIdentificationError extends Error {},
}));

import { createUrlExtractionSession } from "../src/run/flows/url/extraction-session.js";

function createCtx() {
  return {
    io: {
      env: {},
      envForRun: {},
      fetch: vi.fn(),
      stderr: process.stderr,
    },
    flags: {
      timeoutMs: 1_000,
      maxExtractCharacters: null,
      youtubeMode: "auto",
      videoMode: "auto",
      embeddedVideoMode: "auto",
      transcriptTimestamps: false,
      transcriptDiarization: null,
      speakerIdentification: null,
      firecrawlMode: "off",
      verbose: false,
      verboseColor: false,
      slides: null,
    },
    model: {
      apiStatus: {
        firecrawlApiKey: null,
        firecrawlConfigured: false,
        apifyToken: null,
        ytDlpPath: null,
        falApiKey: null,
        groqApiKey: null,
        assemblyaiApiKey: null,
        elevenlabsApiKey: null,
        openaiApiKey: null,
        googleApiKey: null,
        providerBaseUrls: { openai: null },
      },
      llmCalls: [],
    },
    cache: {
      mode: "default",
      ttlMs: 60_000,
      store: {
        transcriptCache: null,
        getJson: vi.fn(),
        setJson: vi.fn(),
      },
    },
    mediaCache: null,
  };
}

describe("createUrlExtractionSession", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    createLinkPreviewClient.mockReturnValue({});
    fetchYoutubeSourceMetrics.mockResolvedValue(null);
    fetchLinkContentWithBirdTip.mockResolvedValue({
      content: "video transcript",
      title: null,
      description: null,
      url: "https://example.com/video.mp4",
      siteName: null,
      wordCount: 2,
      totalCharacters: 16,
      truncated: false,
      mediaDurationSeconds: null,
      video: null,
      isVideoOnly: false,
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
          cacheMode: "default",
          cacheStatus: "bypassed",
          notes: null,
        },
        markdown: {
          requested: false,
          used: false,
          provider: null,
          notes: null,
        },
        transcript: {
          cacheMode: "default",
          cacheStatus: "miss",
          textProvided: false,
          provider: null,
          attemptedProviders: [],
        },
      },
    });
    identifySpeakersInExtractedContent.mockImplementation(async ({ extracted }) => ({
      extracted,
      mappings: [],
      transcriptHash: null,
      usage: null,
      inferenceAttempted: false,
      warning: null,
      cacheable: true,
    }));
    rememberSpeakerMappings.mockResolvedValue(undefined);
  });

  it("forwards ElevenLabs transcription credentials", () => {
    const ctx = createCtx();
    ctx.model.apiStatus.elevenlabsApiKey = "elevenlabs-key";

    createUrlExtractionSession({
      ctx: ctx as never,
      markdown: {
        convertHtmlToMarkdown: vi.fn(),
        effectiveMarkdownMode: "off",
        markdownRequested: false,
      },
      onProgress: null,
    });

    expect(createLinkPreviewClient).toHaveBeenCalledWith(
      expect.objectContaining({
        transcription: expect.objectContaining({
          elevenlabsApiKey: "elevenlabs-key",
        }),
      }),
    );
  });

  it("allows guarded yt-dlp only for explicit Loom transcript requests", () => {
    const ctx = createCtx();
    ctx.io.urlFetch = vi.fn() as unknown as typeof fetch;
    ctx.flags.videoMode = "transcript";
    ctx.model.apiStatus.ytDlpPath = "/usr/bin/yt-dlp";

    createUrlExtractionSession({
      ctx: ctx as never,
      targetUrl: "https://www.loom.com/share/ef3224a48a084371bd6d766ee81f083f",
      markdown: {
        convertHtmlToMarkdown: vi.fn(),
        effectiveMarkdownMode: "off",
        markdownRequested: false,
      },
      onProgress: null,
    });

    expect(createLinkPreviewClient).toHaveBeenCalledWith(
      expect.objectContaining({ ytDlpPath: "/usr/bin/yt-dlp" }),
    );
  });

  it("keeps guarded yt-dlp disabled for Loom auto mode", () => {
    const ctx = createCtx();
    ctx.io.urlFetch = vi.fn() as unknown as typeof fetch;
    ctx.flags.videoMode = "auto";
    ctx.model.apiStatus.ytDlpPath = "/usr/bin/yt-dlp";

    createUrlExtractionSession({
      ctx: ctx as never,
      targetUrl: "https://www.loom.com/share/ef3224a48a084371bd6d766ee81f083f",
      markdown: {
        convertHtmlToMarkdown: vi.fn(),
        effectiveMarkdownMode: "off",
        markdownRequested: false,
      },
      onProgress: null,
    });

    expect(createLinkPreviewClient).toHaveBeenCalledWith(
      expect.objectContaining({ ytDlpPath: null }),
    );
  });

  it("keeps remember-speakers out of earlier identity cache entries", async () => {
    const ctx = createCtx();
    ctx.flags.speakerIdentification = {
      sourceKey: "youtube:abcdefghijk",
      profileName: "modern-wisdom",
      host: "Chris Williamson",
      knownSpeakers: ["Chris Williamson"],
      context: "Modern Wisdom podcast",
      model: "openai/gpt-5.5",
      minimumConfidence: 0.85,
      anchors: [{ atMs: 0, name: "Chris Williamson" }],
      remembered: null,
      remember: true,
      explicit: true,
    };
    Object.assign(ctx.flags, { configPath: "/tmp/summarize-config.json" });
    ctx.model.apiStatus.openaiApiKey = "openai-key";
    identifySpeakersInExtractedContent.mockImplementationOnce(async ({ extracted }) => ({
      extracted,
      mappings: [
        {
          speaker: "Speaker 1",
          name: "Chris Williamson",
          confidence: 1,
          source: "anchor",
        },
      ],
      transcriptHash: "a".repeat(64),
      usage: null,
      inferenceAttempted: false,
      warning: null,
      cacheable: true,
    }));

    const session = createUrlExtractionSession({
      ctx: ctx as never,
      markdown: {
        convertHtmlToMarkdown: vi.fn(),
        effectiveMarkdownMode: "off",
        markdownRequested: false,
      },
      onProgress: null,
    });
    await session.fetchWithCache("https://www.youtube.com/watch?v=abcdefghijk");

    expect(ctx.cache.store.getJson).not.toHaveBeenCalled();
    expect(buildExtractCacheKey).toHaveBeenCalledWith(
      expect.objectContaining({
        options: expect.objectContaining({
          speakerIdentification: expect.objectContaining({ remember: true }),
        }),
      }),
    );
    expect(rememberSpeakerMappings).toHaveBeenCalledWith(
      expect.objectContaining({
        configPath: "/tmp/summarize-config.json",
        transcriptHash: "a".repeat(64),
      }),
    );
  });

  it("does not hide diarization failures when speaker identification is enabled", async () => {
    const ctx = createCtx();
    ctx.flags.speakerIdentification = {
      sourceKey: "youtube:abcdefghijk",
      profileName: "modern-wisdom",
      host: "Chris Williamson",
      knownSpeakers: ["Chris Williamson"],
      context: "Modern Wisdom podcast",
      model: "openai/gpt-5.5",
      minimumConfidence: 0.85,
      anchors: [],
      remembered: null,
      remember: false,
      explicit: true,
    };
    fetchLinkContentWithBirdTip.mockRejectedValueOnce(
      new Error("ElevenLabs transcription failed (401): invalid API key"),
    );

    const session = createUrlExtractionSession({
      ctx: ctx as never,
      markdown: {
        convertHtmlToMarkdown: vi.fn(),
        effectiveMarkdownMode: "off",
        markdownRequested: false,
      },
      onProgress: null,
    });

    await expect(
      session.fetchWithCache("https://www.youtube.com/watch?v=abcdefghijk"),
    ).rejects.toThrow(/ElevenLabs transcription failed/);
  });

  it("records speaker-identification calls without usage metadata", async () => {
    const ctx = createCtx();
    ctx.flags.speakerIdentification = {
      sourceKey: "youtube:abcdefghijk",
      profileName: "modern-wisdom",
      host: "Chris Williamson",
      knownSpeakers: ["Chris Williamson"],
      context: "Modern Wisdom podcast",
      model: "openai/gpt-5.5",
      minimumConfidence: 0.85,
      anchors: [],
      remembered: null,
      remember: false,
      explicit: true,
    };
    identifySpeakersInExtractedContent.mockImplementationOnce(async ({ extracted }) => ({
      extracted,
      mappings: [],
      transcriptHash: "a".repeat(64),
      usage: null,
      inferenceAttempted: true,
      warning: null,
      cacheable: true,
    }));

    const session = createUrlExtractionSession({
      ctx: ctx as never,
      markdown: {
        convertHtmlToMarkdown: vi.fn(),
        effectiveMarkdownMode: "off",
        markdownRequested: false,
      },
      onProgress: null,
    });
    await session.fetchWithCache("https://www.youtube.com/watch?v=abcdefghijk");

    expect(ctx.model.llmCalls).toEqual([
      {
        provider: "openai",
        model: "openai/gpt-5.5",
        usage: null,
        purpose: "speaker-identification",
      },
    ]);
  });

  it("bypasses extract-cache reuse for local file URLs and forwards file mtime", async () => {
    const filePath = path.join(tmpdir(), `summarize-local-slides-${Date.now().toString()}.webm`);
    await fs.writeFile(filePath, "video");

    try {
      const ctx = createCtx();
      const session = createUrlExtractionSession({
        ctx: ctx as never,
        markdown: {
          convertHtmlToMarkdown: vi.fn(),
          effectiveMarkdownMode: "off",
          markdownRequested: false,
        },
        onProgress: null,
      });

      await session.fetchWithCache(pathToFileURL(filePath).href);

      expect(buildExtractCacheKey).not.toHaveBeenCalled();
      expect(ctx.cache.store.getJson).not.toHaveBeenCalled();
      expect(ctx.cache.store.setJson).not.toHaveBeenCalled();
      expect(fetchLinkContentWithBirdTip).toHaveBeenCalledTimes(1);
      expect(fetchLinkContentWithBirdTip.mock.calls[0]?.[0]?.options.fileMtime).toBeGreaterThan(0);
      expect(fetchLinkContentWithBirdTip.mock.calls[0]?.[0]?.options.mediaTranscript).toBe("auto");
    } finally {
      await fs.rm(filePath, { force: true });
    }
  });

  it("prefers transcript extraction for local slide videos", async () => {
    const filePath = path.join(tmpdir(), `summarize-local-slides-${Date.now().toString()}.webm`);
    await fs.writeFile(filePath, "video");

    try {
      const ctx = createCtx();
      ctx.flags.slides = {
        enabled: true,
        ocr: false,
        outputDir: "/tmp/slides",
        sceneThreshold: 0.12,
        autoTuneThreshold: true,
        maxSlides: 6,
        minDurationSeconds: 2,
      };
      const session = createUrlExtractionSession({
        ctx: ctx as never,
        markdown: {
          convertHtmlToMarkdown: vi.fn(),
          effectiveMarkdownMode: "off",
          markdownRequested: false,
        },
        onProgress: null,
      });

      await session.fetchWithCache(pathToFileURL(filePath).href);

      expect(fetchLinkContentWithBirdTip.mock.calls[0]?.[0]?.options.mediaTranscript).toBe(
        "prefer",
      );
      expect(fetchLinkContentWithBirdTip.mock.calls[0]?.[0]?.options.transcriptTimestamps).toBe(
        false,
      );
    } finally {
      await fs.rm(filePath, { force: true });
    }
  });

  it("prefers transcript extraction for direct video URLs when slides are enabled", async () => {
    const ctx = createCtx();
    ctx.flags.slides = {
      enabled: true,
      ocr: false,
      outputDir: "/tmp/slides",
      sceneThreshold: 0.12,
      autoTuneThreshold: true,
      maxSlides: 6,
      minDurationSeconds: 2,
    };
    const session = createUrlExtractionSession({
      ctx: ctx as never,
      markdown: {
        convertHtmlToMarkdown: vi.fn(),
        effectiveMarkdownMode: "off",
        markdownRequested: false,
      },
      onProgress: null,
    });

    await session.fetchWithCache("https://cdn.example.com/video.mp4");

    expect(fetchLinkContentWithBirdTip.mock.calls[0]?.[0]?.options.mediaTranscript).toBe("prefer");
  });

  it("disables yt-dlp media fetches when daemon URL fetch guarding is active", () => {
    const ctx = createCtx();
    const guardedFetch = vi.fn();
    (ctx.io as typeof ctx.io & { urlFetch: typeof fetch }).urlFetch =
      guardedFetch as unknown as typeof fetch;
    ctx.model.apiStatus.ytDlpPath = "/usr/bin/yt-dlp";

    createUrlExtractionSession({
      ctx: ctx as never,
      markdown: {
        convertHtmlToMarkdown: vi.fn(),
        effectiveMarkdownMode: "off",
        markdownRequested: false,
      },
      onProgress: null,
    });

    expect(createLinkPreviewClient).toHaveBeenCalledWith(
      expect.objectContaining({
        fetch: guardedFetch,
        ytDlpPath: null,
      }),
    );
  });

  it("includes asset-like html error mode in extract cache keys", async () => {
    const ctx = createCtx();
    (ctx.flags as { throwOnAssetLikeHtmlError?: boolean }).throwOnAssetLikeHtmlError = true;
    const session = createUrlExtractionSession({
      ctx: ctx as never,
      markdown: {
        convertHtmlToMarkdown: vi.fn(),
        effectiveMarkdownMode: "off",
        markdownRequested: false,
      },
      onProgress: null,
    });

    await session.fetchWithCache("https://example.com/download");

    expect(buildExtractCacheKey).toHaveBeenCalledWith({
      url: "https://example.com/download",
      options: expect.objectContaining({
        throwOnAssetLikeHtmlError: true,
      }),
    });
  });

  it("refreshes legacy YouTube extract cache entries without source metrics", async () => {
    fetchYoutubeSourceMetrics.mockResolvedValueOnce({
      platform: "youtube",
      videoId: "abcdefghijk",
      viewCount: 19_335,
      observedAt: "2026-06-11T19:00:00.000Z",
    });
    const ctx = createCtx();
    ctx.cache.store.getJson.mockReturnValue({ content: "cached transcript" });
    const session = createUrlExtractionSession({
      ctx: ctx as never,
      markdown: {
        convertHtmlToMarkdown: vi.fn(),
        effectiveMarkdownMode: "off",
        markdownRequested: false,
      },
      onProgress: null,
    });

    await session.fetchWithCache("https://www.youtube.com/watch?v=abcdefghijk");

    expect(fetchLinkContentWithBirdTip).not.toHaveBeenCalled();
    expect(fetchYoutubeSourceMetrics).toHaveBeenCalled();
    expect(ctx.cache.store.setJson).toHaveBeenCalled();
  });

  it("keeps a legacy cached transcript when source metric refresh fails", async () => {
    const cached = {
      content: "cached transcript",
      video: { kind: "youtube", url: "https://www.youtube.com/watch?v=abcdefghijk" },
    };
    const ctx = createCtx();
    ctx.cache.store.getJson.mockReturnValue(cached);
    const session = createUrlExtractionSession({
      ctx: ctx as never,
      markdown: {
        convertHtmlToMarkdown: vi.fn(),
        effectiveMarkdownMode: "off",
        markdownRequested: false,
      },
      onProgress: null,
    });

    await expect(
      session.fetchWithCache("https://www.youtube.com/watch?v=abcdefghijk"),
    ).resolves.toBe(cached);
  });

  it("keeps a legacy transcript when metric refresh temporarily returns unavailable", async () => {
    const fresh = await fetchLinkContentWithBirdTip();
    const cached = {
      ...fresh,
      content: "cached transcript",
      transcriptSource: "captionTracks",
      sourceMetrics: null,
      video: { kind: "youtube", url: "https://www.youtube.com/watch?v=abcdefghijk" },
    };
    fetchYoutubeSourceMetrics.mockResolvedValueOnce({
      platform: "youtube",
      videoId: "abcdefghijk",
      viewCount: 20,
      observedAt: "2026-06-11T20:00:00.000Z",
    });
    const ctx = createCtx();
    ctx.cache.store.getJson.mockReturnValue(cached);
    const session = createUrlExtractionSession({
      ctx: ctx as never,
      markdown: {
        convertHtmlToMarkdown: vi.fn(),
        effectiveMarkdownMode: "off",
        markdownRequested: false,
      },
      onProgress: null,
    });

    const result = await session.fetchWithCache("https://www.youtube.com/watch?v=abcdefghijk");

    expect(result.content).toBe("cached transcript");
    expect(result.transcriptSource).toBe("captionTracks");
    expect(result.sourceMetrics?.viewCount).toBe(20);
  });

  it("uses a matching identified-speaker cache entry when metric refresh fails", async () => {
    const cached = {
      content: "Chris Williamson: cached transcript",
      transcriptSource: "captionTracks",
      video: { kind: "youtube", url: "https://www.youtube.com/watch?v=abcdefghijk" },
    };
    const ctx = createCtx();
    ctx.flags.speakerIdentification = {
      sourceKey: "youtube:abcdefghijk",
      profileName: "modern-wisdom",
      host: "Chris Williamson",
      knownSpeakers: ["Chris Williamson"],
      context: "Modern Wisdom podcast",
      model: "openai/gpt-5.5",
      minimumConfidence: 0.85,
      anchors: [],
      remembered: null,
      remember: false,
      explicit: true,
    };
    ctx.cache.store.getJson.mockReturnValue(cached);
    const session = createUrlExtractionSession({
      ctx: ctx as never,
      markdown: {
        convertHtmlToMarkdown: vi.fn(),
        effectiveMarkdownMode: "off",
        markdownRequested: false,
      },
      onProgress: null,
    });

    await expect(
      session.fetchWithCache("https://www.youtube.com/watch?v=abcdefghijk"),
    ).resolves.toBe(cached);
  });

  it("does not refresh legacy cache entries for YouTube pages without a video", async () => {
    const cached = { content: "channel page", video: null };
    const ctx = createCtx();
    ctx.cache.store.getJson.mockReturnValue(cached);
    const session = createUrlExtractionSession({
      ctx: ctx as never,
      markdown: {
        convertHtmlToMarkdown: vi.fn(),
        effectiveMarkdownMode: "off",
        markdownRequested: false,
      },
      onProgress: null,
    });

    await expect(session.fetchWithCache("https://www.youtube.com/@example")).resolves.toBe(cached);
    expect(fetchLinkContentWithBirdTip).not.toHaveBeenCalled();
  });

  it("does not migrate metrics for generic articles with incidental YouTube embeds", async () => {
    const cached = {
      content: "article",
      transcriptSource: "html",
      sourceMetrics: null,
      video: { kind: "youtube", url: "https://www.youtube.com/watch?v=abcdefghijk" },
    };
    const ctx = createCtx();
    ctx.cache.store.getJson.mockReturnValue(cached);
    const session = createUrlExtractionSession({
      ctx: ctx as never,
      markdown: {
        convertHtmlToMarkdown: vi.fn(),
        effectiveMarkdownMode: "off",
        markdownRequested: false,
      },
      onProgress: null,
    });

    await expect(session.fetchWithCache("https://example.com/article")).resolves.toBe(cached);
    expect(fetchLinkContentWithBirdTip).not.toHaveBeenCalled();
  });

  it("keeps processed extracts cached while source metrics refresh separately", async () => {
    const fresh = await fetchLinkContentWithBirdTip();
    fetchLinkContentWithBirdTip.mockClear();
    fetchLinkContentWithBirdTip.mockResolvedValueOnce({
      ...fresh,
      sourceMetrics: {
        platform: "youtube",
        videoId: "abcdefghijk",
        viewCount: 19_335,
        observedAt: "2026-06-11T19:00:00.000Z",
      },
    });
    const ctx = createCtx();
    ctx.cache.ttlMs = 2 * 60 * 60 * 1_000;
    const session = createUrlExtractionSession({
      ctx: ctx as never,
      markdown: {
        convertHtmlToMarkdown: vi.fn(),
        effectiveMarkdownMode: "off",
        markdownRequested: false,
      },
      onProgress: null,
    });

    await session.fetchWithCache("https://www.youtube.com/watch?v=abcdefghijk");

    expect(ctx.cache.store.setJson).toHaveBeenCalledWith(
      "extract",
      "extract-key",
      expect.objectContaining({
        sourceMetrics: expect.objectContaining({ viewCount: 19_335 }),
      }),
      2 * 60 * 60 * 1_000,
    );
  });

  it("surfaces podcast extraction errors instead of falling back to empty URL-only content", async () => {
    const ctx = createCtx();
    const session = createUrlExtractionSession({
      ctx: ctx as never,
      markdown: {
        convertHtmlToMarkdown: vi.fn(),
        effectiveMarkdownMode: "off",
        markdownRequested: false,
      },
      onProgress: null,
    });
    fetchLinkContentWithBirdTip.mockRejectedValueOnce(new Error("transcript failed"));

    await expect(session.fetchWithCache("https://open.spotify.com/episode/abc")).rejects.toThrow(
      /transcript failed/,
    );
  });
});
