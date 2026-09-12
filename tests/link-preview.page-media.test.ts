import { beforeEach, describe, expect, it, vi } from "vitest";

const { resolveTranscriptForLink, refreshYoutubeSourceMetrics } = vi.hoisted(() => ({
  resolveTranscriptForLink: vi.fn(),
  refreshYoutubeSourceMetrics: vi.fn(),
}));

vi.mock("../packages/core/src/content/transcript/index.js", () => ({ resolveTranscriptForLink }));
vi.mock("../packages/core/src/content/link-preview/content/youtube-source-metrics.js", () => ({
  refreshYoutubeSourceMetrics,
}));

import { buildResultFromFirecrawl } from "../packages/core/src/content/link-preview/content/firecrawl.js";
import { buildResultFromHtmlDocument } from "../packages/core/src/content/link-preview/content/html.js";
import type { PageExtractionContext } from "../packages/core/src/content/link-preview/content/page-media.js";

const videoUrl = "https://www.youtube.com/watch?v=abcdefghijk";
const article = "Useful article prose. ".repeat(200);
const html = `<article><p>${article}</p><iframe src="https://www.youtube.com/embed/abcdefghijk"></iframe></article>`;

function context(): PageExtractionContext {
  return {
    url: "https://example.com/article",
    deps: { fetch: vi.fn() } as never,
    timeoutMs: 2_000,
    cacheMode: "bypass",
    maxCharacters: null,
    youtubeTranscriptMode: "auto",
    mediaTranscriptMode: "prefer",
    embeddedVideoMode: "both",
    transcriptTimestamps: true,
    transcriptDiarization: "auto",
    transcriptVideoDownload: true,
    firecrawlDiagnostics: {
      attempted: true,
      used: false,
      cacheMode: "bypass",
      cacheStatus: "bypassed",
    },
    markdownRequested: false,
  };
}

beforeEach(() => {
  vi.resetAllMocks();
  resolveTranscriptForLink.mockResolvedValue({
    text: "Video transcript",
    source: "captionTracks",
    segments: null,
  });
});

describe.each(["html", "firecrawl"] as const)("%s page media", (strategy) => {
  async function build(options: PageExtractionContext) {
    return strategy === "html"
      ? buildResultFromHtmlDocument({
          ...options,
          html,
          markdownMode: "off",
          readabilityCandidate: null,
        })
      : buildResultFromFirecrawl({ ...options, payload: { html, markdown: article } });
  }

  it("preserves transcript policy, source metadata, and both content sections", async () => {
    const options = context();
    const result = await build(options);
    expect(resolveTranscriptForLink).toHaveBeenCalledExactlyOnceWith(
      options.url,
      html,
      options.deps,
      {
        timeoutMs: 2_000,
        cacheMode: "bypass",
        youtubeTranscriptMode: "auto",
        mediaTranscriptMode: "prefer",
        embeddedMediaUrl: videoUrl,
        transcriptTimestamps: true,
        transcriptDiarization: "auto",
        transcriptVideoDownload: true,
      },
    );
    expect(refreshYoutubeSourceMetrics).toHaveBeenCalledOnce();
    expect(result?.content).toContain("Article:\nUseful article prose.");
    expect(result?.content).toContain(`Embedded video transcript (${videoUrl}):\nVideo transcript`);
    expect(result?.diagnostics).toMatchObject({
      strategy,
      transcript: { cacheMode: "bypass", provider: "captionTracks" },
      embeddedVideo: { mode: "both", used: true, confidence: "high", composition: "both" },
    });
  });

  it("does not force incidental video transcription when embedding is disabled", async () => {
    resolveTranscriptForLink.mockResolvedValue({ text: null, source: null });
    const result = await build({ ...context(), embeddedVideoMode: "off" });
    expect(resolveTranscriptForLink).toHaveBeenCalledWith(
      expect.any(String),
      html,
      expect.any(Object),
      expect.objectContaining({ embeddedMediaUrl: null, mediaTranscriptMode: "auto" }),
    );
    expect(result?.diagnostics.embeddedVideo).toMatchObject({
      used: false,
      composition: "article",
    });
  });
});

it("converts HTML Markdown only after transcript and source metric resolution", async () => {
  const calls: string[] = [];
  resolveTranscriptForLink.mockImplementation(async () => {
    calls.push("transcript");
    return { text: "Video transcript", source: "captionTracks" };
  });
  refreshYoutubeSourceMetrics.mockImplementation(async () => {
    calls.push("metrics");
  });
  const options = context();
  const result = await buildResultFromHtmlDocument({
    ...options,
    html,
    deps: {
      ...options.deps,
      convertHtmlToMarkdown: async () => {
        calls.push("markdown");
        return "Converted article. ".repeat(200);
      },
    },
    readabilityCandidate: null,
    markdownRequested: true,
    markdownMode: "llm",
  });
  expect(calls).toEqual(["transcript", "metrics", "markdown"]);
  expect(result.content).toContain("Converted article.");
  expect(result.content).toContain("Video transcript");
});

it("keeps Firecrawl's empty Markdown short circuit ahead of media resolution", async () => {
  const options = context();
  expect(
    await buildResultFromFirecrawl({ ...options, payload: { html, markdown: "  " } }),
  ).toBeNull();
  expect(resolveTranscriptForLink).not.toHaveBeenCalled();
  expect(options.firecrawlDiagnostics.used).toBe(false);
});

it("preserves empty Firecrawl HTML without attempting a source metric refresh", async () => {
  await buildResultFromFirecrawl({ ...context(), payload: { html: "", markdown: article } });
  expect(resolveTranscriptForLink.mock.calls[0]?.[1]).toBe("");
  expect(refreshYoutubeSourceMetrics).not.toHaveBeenCalled();
});

it("still refreshes source metrics for an empty raw HTML document", async () => {
  await buildResultFromHtmlDocument({
    ...context(),
    html: "",
    readabilityCandidate: null,
    markdownMode: "off",
  });
  expect(refreshYoutubeSourceMetrics).toHaveBeenCalledWith(expect.objectContaining({ html: "" }));
});
