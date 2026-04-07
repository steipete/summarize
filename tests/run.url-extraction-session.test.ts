import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";

const createLinkPreviewClient = vi.hoisted(() => vi.fn());
const buildExtractCacheKey = vi.hoisted(() => vi.fn(() => "extract-key"));
const fetchLinkContentWithBirdTip = vi.hoisted(() => vi.fn());

vi.mock("../src/content/index.js", () => ({
  createLinkPreviewClient,
}));

vi.mock("../src/cache.js", () => ({
  buildExtractCacheKey,
}));

vi.mock("../src/run/flows/url/extract.js", () => ({
  fetchLinkContentWithBirdTip,
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
      transcriptTimestamps: false,
      firecrawlMode: "off",
      verbose: false,
      verboseColor: false,
      slides: false,
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
        openaiTranscriptionKey: null,
        googleApiKey: null,
      },
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
    } finally {
      await fs.rm(filePath, { force: true });
    }
  });
});
