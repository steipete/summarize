import { describe, expect, it, vi } from "vitest";
import { fetchLinkContent } from "../packages/core/src/content/link-preview/content/index.js";
import { toTwitterSyndicationUrl } from "../packages/core/src/content/link-preview/content/twitter-utils.js";
import { buildExtractFinishLabel } from "../src/run/finish-line-labels.js";

describe("Twitter Syndication API Extraction", () => {
  it("extracts tweet text, author header, quoted tweet, and photos from syndication API", async () => {
    const tweetUrl = "https://x.com/0xLupenn/status/2094533934960758909";
    const syndicationUrl = toTwitterSyndicationUrl("2094533934960758909");

    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.url;
      if (url === syndicationUrl) {
        return new Response(
          JSON.stringify({
            text: "This man teaches calculus at a community college.",
            user: { name: "Lupen", screen_name: "0xLupenn" },
            quoted_tweet: {
              text: "Engineers passed calculus because of him.",
              user: { screen_name: "student" },
            },
            photos: [{ url: "https://pbs.twimg.com/media/test.jpg" }],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (url === tweetUrl) {
        return new Response("Not found", { status: 404 });
      }
      throw new Error(`Unexpected fetch URL: ${url}`);
    });

    const progressEvents: string[] = [];
    const result = await fetchLinkContent(
      tweetUrl,
      {},
      {
        env: {},
        fetch: fetchMock as unknown as typeof fetch,
        scrapeWithFirecrawl: null,
        apifyApiToken: null,
        ytDlpPath: null,
        convertHtmlToMarkdown: null,
        transcriptCache: null,
        onProgress: (e) => progressEvents.push(e.kind),
      },
    );

    expect(result.diagnostics.strategy).toBe("twitter-syndication");
    expect(result.content).toContain("**Lupen (@0xLupenn)**");
    expect(result.content).toContain("This man teaches calculus at a community college.");
    expect(result.content).toContain(
      "> Quoted @student: Engineers passed calculus because of him.",
    );
    expect(result.content).toContain("![photo](https://pbs.twimg.com/media/test.jpg)");

    expect(progressEvents).toContain("twitter-syndication-start");
    expect(progressEvents).toContain("twitter-syndication-done");

    const label = buildExtractFinishLabel({
      extracted: { diagnostics: result.diagnostics as any },
      format: "text",
      markdownMode: "off",
      hasMarkdownLlmCall: false,
    });
    expect(label).toBe("text via twitter-syndication");
  });

  it("falls back to Nitter when Twitter Syndication API fails with HTTP 404", async () => {
    const tweetUrl = "https://x.com/user/status/123";
    const syndicationUrl = "https://cdn.syndication.twimg.com/tweet-result?id=123&token=123";
    const nitterUrl = "https://nitter.net/user/status/123";

    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.url;
      if (url === syndicationUrl) {
        return new Response("Not found", { status: 404 });
      }
      if (url.includes("nitter")) {
        return new Response(
          "<html><head><title>Tweet</title></head><body><article>Content from Nitter</article></body></html>",
          { status: 200, headers: { "Content-Type": "text/html" } },
        );
      }
      throw new Error(`Unexpected fetch URL: ${url}`);
    });

    const result = await fetchLinkContent(
      tweetUrl,
      {},
      {
        env: {},
        fetch: fetchMock as unknown as typeof fetch,
        scrapeWithFirecrawl: null,
        apifyApiToken: null,
        ytDlpPath: null,
        convertHtmlToMarkdown: null,
        transcriptCache: null,
      },
    );

    expect(result.diagnostics.strategy).toBe("nitter");
    expect(result.content).toContain("Content from Nitter");
  });

  it("emits exactly one twitter-syndication-done event with ok:false when post-fetch extraction throws", async () => {
    const tweetUrl = "https://x.com/user/status/55555";
    const syndicationUrl = toTwitterSyndicationUrl("55555");

    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.url;
      if (url === syndicationUrl) {
        return new Response(
          JSON.stringify({
            text: "Valid tweet text",
            user: { screen_name: "testuser" },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response("Not found", { status: 404 });
    });

    const progressEvents: Array<{ kind: string; ok?: boolean }> = [];
    await fetchLinkContent(
      tweetUrl,
      {},
      {
        env: {},
        fetch: fetchMock as unknown as typeof fetch,
        scrapeWithFirecrawl: null,
        apifyApiToken: null,
        ytDlpPath: null,
        convertHtmlToMarkdown: null,
        transcriptCache: {
          get: () => {
            throw new Error("Transcript cache error inside buildResultFromHtmlDocument");
          },
          set: () => {},
        } as any,
        onProgress: (e) => progressEvents.push({ kind: e.kind, ok: (e as any).ok }),
      },
    ).catch(() => {});

    const doneEvents = progressEvents.filter((e) => e.kind === "twitter-syndication-done");
    expect(doneEvents).toHaveLength(1);
    expect(doneEvents[0].ok).toBe(false);
  });
});
