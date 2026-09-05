import { beforeEach, describe, expect, it, vi } from "vitest";
import { fetchLinkContent } from "../packages/core/src/content/link-preview/content/index.js";
import type { LinkPreviewDeps } from "../packages/core/src/content/link-preview/deps.js";
import type { TranscriptResolution } from "../packages/core/src/content/link-preview/types.js";

const { resolveTranscript } = vi.hoisted(() => ({
  resolveTranscript: vi.fn<() => Promise<TranscriptResolution>>(),
}));
vi.mock("../packages/core/src/content/transcript/index.js", () => ({
  resolveTranscriptForLink: resolveTranscript,
}));

const tweetUrl = "https://x.com/example/status/123";

function createDeps(): LinkPreviewDeps {
  return {
    env: {},
    fetch: vi.fn(async () =>
      Response.json({
        text: "A caption for the video.",
        user: { name: "Example", screen_name: "example" },
      }),
    ),
    scrapeWithFirecrawl: null,
    apifyApiToken: null,
    ytDlpPath: null,
    convertHtmlToMarkdown: null,
    transcriptCache: null,
  };
}

describe("Twitter Syndication transcript routing", () => {
  beforeEach(() => {
    resolveTranscript.mockReset();
  });

  it("honors explicit transcript mode and preserves transcript options and metadata", async () => {
    resolveTranscript.mockResolvedValue({
      text: "Spoken words from the video.",
      source: "yt-dlp",
      segments: [{ startMs: 1000, endMs: 3000, text: "Spoken words from the video." }],
      metadata: { transcriptionProvider: "openai" },
      diagnostics: {
        cacheMode: "bypass",
        cacheStatus: "bypassed",
        textProvided: true,
        provider: "yt-dlp",
        attemptedProviders: ["yt-dlp"],
      },
    });
    const deps = createDeps();
    const result = await fetchLinkContent(
      tweetUrl,
      {
        mediaTranscript: "prefer",
        cacheMode: "bypass",
        transcriptTimestamps: true,
        transcriptDiarization: "openai",
        transcriptVideoDownload: true,
      },
      deps,
    );

    expect(resolveTranscript).toHaveBeenCalledWith(tweetUrl, null, deps, {
      youtubeTranscriptMode: "auto",
      mediaTranscriptMode: "prefer",
      cacheMode: "bypass",
      transcriptTimestamps: true,
      transcriptDiarization: "openai",
      transcriptVideoDownload: true,
      fileMtime: null,
    });
    expect(result.content).toContain("[0:01] Spoken words from the video.");
    expect(result.content).not.toContain("A caption for the video.");
    expect(result.transcriptSource).toBe("yt-dlp");
    expect(result.transcriptionProvider).toBe("openai");
    expect(result.diagnostics.strategy).toBe("twitter-syndication");
    expect(result.diagnostics.transcript.cacheStatus).toBe("bypassed");
  });

  it("keeps auto mode text-only and reports cache bypass accurately", async () => {
    const result = await fetchLinkContent(tweetUrl, { cacheMode: "bypass" }, createDeps());

    expect(resolveTranscript).not.toHaveBeenCalled();
    expect(result.content).toContain("A caption for the video.");
    expect(result.transcriptSource).toBeNull();
    expect(result.diagnostics.transcript.cacheStatus).toBe("bypassed");
  });

  it("keeps tweet text when the requested transcript is unavailable", async () => {
    resolveTranscript.mockResolvedValue({ text: null, source: null });
    const result = await fetchLinkContent(tweetUrl, { mediaTranscript: "prefer" }, createDeps());

    expect(resolveTranscript).toHaveBeenCalledOnce();
    expect(result.content).toContain("A caption for the video.");
    expect(result.transcriptSource).toBeNull();
    expect(result.diagnostics.strategy).toBe("twitter-syndication");
  });
});
