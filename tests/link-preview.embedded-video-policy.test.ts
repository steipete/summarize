import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  resolveTranscriptForLink: vi.fn(),
}));

vi.mock("../packages/core/src/content/transcript/index.js", () => ({
  resolveTranscriptForLink: mocks.resolveTranscriptForLink,
}));

import { fetchLinkContent } from "../packages/core/src/content/link-preview/content/index.js";

const VIDEO_ID = "abcdefghijk";
const VIDEO_URL = `https://www.youtube.com/watch?v=${VIDEO_ID}`;

function transcriptResolution(text: string | null) {
  return {
    text,
    source: text ? ("captionTracks" as const) : null,
    metadata: null,
    diagnostics: {
      cacheMode: "default" as const,
      cacheStatus: "miss" as const,
      textProvided: Boolean(text),
      provider: text ? ("captionTracks" as const) : null,
      attemptedProviders: text ? (["captionTracks"] as const) : [],
      notes: null,
    },
  };
}

function buildHtml(
  article: string,
  embeds = [`<iframe src="https://www.youtube.com/embed/${VIDEO_ID}"></iframe>`],
) {
  return `<!doctype html><html><head><title>Test page</title></head><body>
    <article><p>${article}</p>${embeds.join("\n")}</article>
  </body></html>`;
}

function buildDeps(
  fetchImpl: typeof fetch,
  convertHtmlToMarkdown: ((args: never) => Promise<string>) | null = null,
) {
  return {
    fetch: fetchImpl,
    scrapeWithFirecrawl: null,
    apifyApiToken: null,
    ytDlpPath: null,
    groqApiKey: null,
    falApiKey: null,
    openaiApiKey: null,
    convertHtmlToMarkdown,
    transcriptCache: null,
    readTweetWithBird: null,
    resolveTwitterCookies: null,
    onProgress: null,
  };
}

async function extract(
  html: string,
  options: Parameters<typeof fetchLinkContent>[1] = { format: "text" },
  convertHtmlToMarkdown: ((args: never) => Promise<string>) | null = null,
  url = "https://example.com/article",
) {
  const fetchMock = vi.fn(
    async () => new Response(html, { status: 200, headers: { "content-type": "text/html" } }),
  );
  return fetchLinkContent(
    url,
    options,
    buildDeps(fetchMock as unknown as typeof fetch, convertHtmlToMarkdown),
  );
}

describe("embedded YouTube policy", () => {
  beforeEach(() => {
    mocks.resolveTranscriptForLink.mockReset();
    mocks.resolveTranscriptForLink.mockImplementation(
      async (_url, _html, _deps, options: { embeddedMediaUrl?: string | null }) =>
        transcriptResolution(options.embeddedMediaUrl ? "Video transcript text." : null),
    );
  });

  it("combines a substantial article with its high-confidence embedded transcript", async () => {
    const result = await extract(buildHtml("Article sentence. ".repeat(180)));

    expect(result.content).toContain("Article:\n");
    expect(result.content).toContain(`Embedded video transcript (${VIDEO_URL}):`);
    expect(result.content).toContain("Video transcript text.");
    expect(result.diagnostics.embeddedVideo).toMatchObject({
      mode: "auto",
      detected: true,
      used: true,
      confidence: "high",
      composition: "both",
    });
    expect(mocks.resolveTranscriptForLink).toHaveBeenCalledWith(
      "https://example.com/article",
      expect.any(String),
      expect.any(Object),
      expect.objectContaining({
        embeddedMediaUrl: VIDEO_URL,
        youtubeTranscriptMode: "web",
      }),
    );
  });

  it("keeps lightweight embed pages transcript-first", async () => {
    const result = await extract(buildHtml("Short episode page."));

    expect(result.content).toBe("Transcript:\nVideo transcript text.");
    expect(result.diagnostics.embeddedVideo?.composition).toBe("transcript");
  });

  it("supports explicit article-only and transcript-only modes", async () => {
    const html = buildHtml("Article sentence. ".repeat(180));
    const articleOnly = await extract(html, {
      format: "text",
      embeddedVideo: "off",
      mediaTranscript: "prefer",
    });
    const transcriptOnly = await extract(html, { format: "text", embeddedVideo: "prefer" });

    expect(articleOnly.content).toContain("Article sentence.");
    expect(articleOnly.content).not.toContain("Video transcript text.");
    expect(articleOnly.diagnostics.embeddedVideo?.composition).toBe("article");
    expect(transcriptOnly.content).toBe("Transcript:\nVideo transcript text.");
    expect(mocks.resolveTranscriptForLink).toHaveBeenNthCalledWith(
      1,
      "https://example.com/article",
      expect.any(String),
      expect.any(Object),
      expect.objectContaining({
        embeddedMediaUrl: null,
        mediaTranscriptMode: "auto",
      }),
    );
  });

  it("skips ambiguous multiple embeds in automatic mode", async () => {
    const html = `<!doctype html><html><body>
      <p>${"Article sentence. ".repeat(180)}</p>
      <iframe src="https://www.youtube.com/embed/${VIDEO_ID}"></iframe>
      <iframe src="https://www.youtube.com/embed/zyxwvutsrqp"></iframe>
    </body></html>`;
    const result = await extract(html);

    expect(result.content).not.toContain("Video transcript text.");
    expect(result.diagnostics.embeddedVideo).toMatchObject({
      detected: true,
      used: false,
      confidence: "medium",
      composition: "article",
    });
  });

  it("does not treat ordinary YouTube links as the primary media", async () => {
    const html = `<!doctype html><html><body><article>
      <p>${"Article sentence. ".repeat(180)}</p>
      <a href="${VIDEO_URL}">Related video</a>
    </article></body></html>`;
    const result = await extract(html);

    expect(result.video).toBeNull();
    expect(result.content).not.toContain("Video transcript text.");
    expect(result.diagnostics.embeddedVideo?.detected).toBe(false);
  });

  it("does not compose a Loom transcript as incidental embedded YouTube content", async () => {
    const loomUrl = "https://www.loom.com/share/ef3224a48a084371bd6d766ee81f083f";
    mocks.resolveTranscriptForLink.mockResolvedValueOnce(
      transcriptResolution("Loom transcript text."),
    );

    const result = await extract(
      buildHtml("Recording landing page. ".repeat(180)),
      { format: "text" },
      null,
      loomUrl,
    );

    expect(result.content).toContain("Loom transcript text.");
    expect(result.content).not.toContain("Embedded video transcript");
    expect(result.video).toBeNull();
    expect(result.diagnostics.embeddedVideo).toMatchObject({ detected: false, used: false });
    expect(mocks.resolveTranscriptForLink).toHaveBeenCalledWith(
      loomUrl,
      expect.any(String),
      expect.any(Object),
      expect.objectContaining({ embeddedMediaUrl: null }),
    );
  });

  it("preserves both sources under an extraction character budget", async () => {
    const result = await extract(buildHtml("Article sentence. ".repeat(300)), {
      format: "text",
      embeddedVideo: "both",
      maxCharacters: 500,
    });

    expect(result.content.length).toBeLessThanOrEqual(500);
    expect(result.content).toContain("Article:");
    expect(result.content).toContain("Embedded video transcript");
    expect(result.truncated).toBe(true);
    expect(result.totalCharacters).toBeGreaterThan(result.content.length);
  });

  it("combines the converted Markdown article instead of replacing the transcript", async () => {
    const result = await extract(
      buildHtml("Article sentence. ".repeat(180)),
      { format: "markdown", markdownMode: "llm", embeddedVideo: "both" },
      vi.fn(async () => "# Converted article\n\nUseful details."),
    );

    expect(result.content).toContain("Article:\n# Converted article");
    expect(result.content).toContain("Embedded video transcript");
    expect(result.diagnostics.markdown.used).toBe(true);
  });
});
