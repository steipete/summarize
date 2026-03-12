import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CacheState } from "../src/cache.js";
import type { ExtractedLinkContent } from "../src/content/index.js";
import type { LinkPreviewClientOptions } from "../src/content/index.js";
import { createDaemonUrlFlowContext } from "../src/daemon/flow-context.js";

const mocks = vi.hoisted(() => {
  const fetchLinkContent = vi.fn<(url: string) => Promise<ExtractedLinkContent>>();
  const createLinkPreviewClient = vi.fn((options?: LinkPreviewClientOptions) => ({
    fetchLinkContent: async (url: string) => fetchLinkContent(url),
    options,
  }));
  return { fetchLinkContent, createLinkPreviewClient };
});

vi.mock("../src/content/index.js", () => ({
  createLinkPreviewClient: mocks.createLinkPreviewClient,
}));

import { runUrlFlow } from "../src/run/flows/url/flow.js";

afterEach(() => {
  vi.clearAllMocks();
});

describe("runUrlFlow transcription wiring", () => {
  it("forwards googleApiKey into link preview transcription config", async () => {
    const root = mkdtempSync(join(tmpdir(), "summarize-gemini-url-flow-"));
    const url = "https://www.youtube.com/watch?v=hhAbp3iQA44";
    const cache: CacheState = {
      mode: "bypass",
      store: null,
      ttlMs: 0,
      maxBytes: 0,
      path: null,
    };

    mocks.fetchLinkContent.mockResolvedValueOnce({
      url,
      title: "Video",
      description: null,
      siteName: "YouTube",
      content: "Transcript text",
      truncated: false,
      totalCharacters: 15,
      wordCount: 2,
      transcriptCharacters: 15,
      transcriptLines: 1,
      transcriptWordCount: 2,
      transcriptSource: "yt-dlp",
      transcriptionProvider: "gemini-2.5-flash",
      transcriptMetadata: null,
      transcriptSegments: null,
      transcriptTimedText: null,
      mediaDurationSeconds: 120,
      video: { kind: "youtube", url },
      isVideoOnly: false,
      diagnostics: {
        strategy: "html",
        firecrawl: {
          attempted: false,
          used: false,
          cacheMode: "bypass",
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
          cacheMode: "bypass",
          cacheStatus: "unknown",
          textProvided: true,
          provider: "yt-dlp",
          attemptedProviders: ["yt-dlp"],
          notes: null,
        },
      },
    });

    const ctx = createDaemonUrlFlowContext({
      env: { HOME: root, OPENAI_API_KEY: "test" },
      fetchImpl: vi.fn() as unknown as typeof fetch,
      cache,
      modelOverride: "google/gemini-3-flash",
      promptOverride: null,
      lengthRaw: "short",
      languageRaw: "auto",
      maxExtractCharacters: null,
      extractOnly: true,
      runStartedAtMs: Date.now(),
      stdoutSink: { writeChunk: () => {} },
    });

    ctx.model.apiStatus.googleApiKey = "gemini-key";
    ctx.model.apiStatus.googleConfigured = true;

    await runUrlFlow({ ctx, url, isYoutubeUrl: true });

    expect(mocks.createLinkPreviewClient).toHaveBeenCalledTimes(1);
    const options = mocks.createLinkPreviewClient.mock.calls[0]?.[0];
    expect(options?.transcription?.geminiApiKey).toBe("gemini-key");
    expect(options?.transcription?.openaiApiKey).toBe("test");
  });
});
