import { describe, expect, it, vi } from "vitest";
import {
  isBlockedRedditThreadHtml,
  normalizeOldRedditThreadHtml,
  toOldRedditThreadUrl,
} from "../packages/core/src/content/link-preview/content/reddit.js";
import { createLinkPreviewClient } from "../src/content/index.js";

const threadUrl = "https://www.reddit.com/r/example/comments/abc123/thread_title/";
const oldThreadUrl = "https://old.reddit.com/r/example/comments/abc123/thread_title/";
const blockedHtml = `<!doctype html><html><head><title>Reddit - Please wait for verification</title></head><body><p>Reddit - Please wait for verification</p></body></html>`;
const oldRedditHtml = `<!doctype html><html><head><title>Old Reddit</title></head><body>
  <nav><p>Navigation noise that must not survive extraction.</p></nav>
  <div class="thing link" id="thing_t3_abc123" data-type="link" data-subreddit="example" data-domain="example.com">
    <div class="entry unvoted">
      <a class="title may-blank" href="https://example.com/source">Thread title</a>
      <p class="tagline"><a class="author">original-poster</a></p>
      <div class="usertext-body"><div class="md"><p>Original post body with enough useful detail.</p></div></div>
    </div>
  </div>
  <div class="thing comment" id="thing_t1_first">
    <div class="entry unvoted">
      <p class="tagline"><a class="author">first-user</a></p>
      <div class="usertext-body"><div class="md"><p>First useful comment body with enough detail to retain.</p></div></div>
    </div>
    <div class="child">
      <div class="thing comment" id="thing_t1_reply">
        <div class="entry unvoted">
          <p class="tagline"><a class="author">reply-user</a></p>
          <div class="usertext-body"><div class="md"><p>Works, thanks!</p></div></div>
        </div>
      </div>
    </div>
  </div>
  <footer><p>Footer noise that must not survive extraction.</p></footer>
</body></html>`;

const htmlResponse = (html: string, status = 200) =>
  new Response(html, { status, headers: { "Content-Type": "text/html" } });

describe("link preview extraction (Reddit)", () => {
  it("retries verification-blocked threads through old Reddit and extracts the discussion", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.url;
      if (url === threadUrl) return htmlResponse(blockedHtml);
      if (url === oldThreadUrl) return htmlResponse(oldRedditHtml);
      throw new Error(`Unexpected fetch call: ${url}`);
    });
    const client = createLinkPreviewClient({ fetch: fetchMock as unknown as typeof fetch });

    const result = await client.fetchLinkContent(threadUrl, {
      firecrawl: "off",
      format: "text",
      timeoutMs: 2000,
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.title).toBe("Thread title");
    expect(result.siteName).toBe("Reddit");
    expect(result.url).toBe(threadUrl);
    expect(result.content).toContain("Original post body with enough useful detail.");
    expect(result.content).toContain("Comment by u/first-user");
    expect(result.content).toContain("First useful comment body with enough detail to retain.");
    expect(result.content).toContain("Comment by u/reply-user");
    expect(result.content).toContain("Works, thanks!");
    expect(result.content).toContain("Link: https://example.com/source");
    expect(result.content).not.toContain("Navigation noise");
    expect(result.content).not.toContain("Footer noise");
  });

  it("keeps source media detection while normalizing the discussion", async () => {
    const videoRedditHtml = oldRedditHtml.replace(
      "<head>",
      '<head><meta property="og:video" content="https://cdn.example.com/post.mp4">',
    );
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.url;
      if (url === threadUrl) return htmlResponse(blockedHtml);
      if (url === oldThreadUrl) return htmlResponse(videoRedditHtml);
      throw new Error(`Unexpected fetch call: ${url}`);
    });
    const client = createLinkPreviewClient({ fetch: fetchMock as unknown as typeof fetch });

    const result = await client.fetchLinkContent(threadUrl, {
      embeddedVideo: "off",
      firecrawl: "off",
      format: "text",
      timeoutMs: 2000,
    });

    expect(result.url).toBe(threadUrl);
    expect(result.video).toEqual({ kind: "direct", url: "https://cdn.example.com/post.mp4" });
    expect(result.content).toContain("Original post body with enough useful detail.");
  });

  it("passes the normalized thread, not page chrome, to Markdown conversion", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.url;
      if (url === oldThreadUrl) return htmlResponse(oldRedditHtml);
      throw new Error(`Unexpected fetch call: ${url}`);
    });
    const convertHtmlToMarkdown = vi.fn(async ({ html }: { html: string }) => {
      expect(html).toContain("Original post body with enough useful detail.");
      expect(html).toContain("First useful comment body with enough detail to retain.");
      expect(html).toContain("Works, thanks!");
      expect(html).toContain('href="https://example.com/source"');
      expect(html).not.toContain("Navigation noise");
      expect(html).not.toContain("Footer noise");
      return "# Thread title\n\nOriginal post body.\n\n## Comments\n\nFirst useful comment body.";
    });
    const client = createLinkPreviewClient({
      fetch: fetchMock as unknown as typeof fetch,
      convertHtmlToMarkdown,
    });

    const result = await client.fetchLinkContent(oldThreadUrl, {
      firecrawl: "off",
      format: "markdown",
      markdownMode: "readability",
      timeoutMs: 2000,
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(convertHtmlToMarkdown).toHaveBeenCalledTimes(1);
    expect(result.content).toContain("## Comments");
  });

  it("does not mistake user-authored verification phrases for a challenge page", async () => {
    const phraseInPost = oldRedditHtml.replace(
      "Original post body with enough useful detail.",
      "Please wait for verification is user-authored text inside a valid Reddit post.",
    );
    const fetchMock = vi.fn(async () => htmlResponse(phraseInPost));
    const client = createLinkPreviewClient({ fetch: fetchMock as unknown as typeof fetch });

    const result = await client.fetchLinkContent(oldThreadUrl, {
      firecrawl: "off",
      format: "text",
      timeoutMs: 2000,
    });

    expect(isBlockedRedditThreadHtml(oldThreadUrl, phraseInPost)).toBe(false);
    expect(result.content).toContain("Please wait for verification is user-authored text");
  });

  it("does not trust a normalized-thread marker from fetched HTML", async () => {
    const untrustedMarkerHtml = `<!doctype html><html><head><title>Ordinary page</title></head><body>
      <script>const spoof = 'data-reddit-thread="true"';</script>
      <main><p>This ordinary page has enough useful content for normal extraction behavior.</p></main>
    </body></html>`;
    const fetchMock = vi.fn(async () => htmlResponse(untrustedMarkerHtml));
    const client = createLinkPreviewClient({ fetch: fetchMock as unknown as typeof fetch });

    const result = await client.fetchLinkContent("https://example.com/article", {
      firecrawl: "off",
      format: "text",
      timeoutMs: 2000,
    });

    expect(result.content).not.toContain("const spoof");
  });

  it("fails clearly when both Reddit HTML surfaces return verification pages", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.url;
      if (url === threadUrl) return htmlResponse(blockedHtml);
      if (url === oldThreadUrl) {
        return htmlResponse("<!doctype html><html><body>Log in to continue.</body></html>");
      }
      throw new Error(`Unexpected fetch call: ${url}`);
    });
    const client = createLinkPreviewClient({ fetch: fetchMock as unknown as typeof fetch });

    await expect(
      client.fetchLinkContent(threadUrl, {
        firecrawl: "off",
        format: "text",
        timeoutMs: 2000,
      }),
    ).rejects.toThrow(/Reddit returned a verification page.*old\.reddit\.com fallback/i);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("keeps Firecrawl as the final fallback when old Reddit is unavailable", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.url;
      if (url === threadUrl) return htmlResponse(blockedHtml);
      if (url === oldThreadUrl) return htmlResponse("Unavailable", 403);
      throw new Error(`Unexpected fetch call: ${url}`);
    });
    const scrapeWithFirecrawl = vi.fn(async () => ({
      markdown: "# Thread title\n\nRecovered Reddit discussion.",
      html: "<html><head><title>Thread title</title></head><body></body></html>",
      metadata: { title: "Thread title", siteName: "Reddit" },
    }));
    const client = createLinkPreviewClient({
      fetch: fetchMock as unknown as typeof fetch,
      scrapeWithFirecrawl,
    });

    const result = await client.fetchLinkContent(threadUrl, {
      firecrawl: "auto",
      format: "text",
      timeoutMs: 2000,
    });

    expect(result.diagnostics.strategy).toBe("firecrawl");
    expect(result.content).toContain("Recovered Reddit discussion.");
    expect(scrapeWithFirecrawl).toHaveBeenCalledOnce();
  });

  it("only rewrites supported Reddit thread URLs", () => {
    expect(toOldRedditThreadUrl(threadUrl)).toBe(oldThreadUrl);
    expect(toOldRedditThreadUrl(`${threadUrl}?sort=new`)).toBe(`${oldThreadUrl}?sort=new`);
    expect(toOldRedditThreadUrl("not a URL")).toBeNull();
    expect(
      toOldRedditThreadUrl("https://example.com/r/example/comments/abc123/thread/"),
    ).toBeNull();
    expect(toOldRedditThreadUrl("https://www.reddit.com/r/example/new/")).toBeNull();
    expect(isBlockedRedditThreadHtml("https://example.com", blockedHtml)).toBe(false);
  });

  it("requires a real old Reddit post and rejects unsafe title links", () => {
    expect(
      normalizeOldRedditThreadHtml(
        oldThreadUrl,
        "<!doctype html><html><body><p>No post here.</p></body></html>",
      ),
    ).toBeNull();
    expect(
      normalizeOldRedditThreadHtml(oldThreadUrl, oldRedditHtml.replace("Thread title", "")),
    ).toBeNull();

    const unsafeLinkHtml = oldRedditHtml.replace(
      "https://example.com/source",
      "javascript:alert(1)",
    );
    expect(normalizeOldRedditThreadHtml(oldThreadUrl, unsafeLinkHtml)).not.toContain("javascript:");

    const selfPostHtml = oldRedditHtml
      .replace('class="thing link"', 'class="thing link self"')
      .replace('data-domain="example.com"', 'data-domain="self.example"');
    expect(normalizeOldRedditThreadHtml(oldThreadUrl, selfPostHtml)).not.toContain("<p>Link:");
  });

  it("selects the requested post instead of a preceding promoted link", () => {
    const promotedHtml = oldRedditHtml.replace(
      '<div class="thing link" id="thing_t3_abc123"',
      `<div class="thing link promoted" id="thing_t3_advert" data-type="link">
        <div class="entry"><a class="title" href="https://ads.example.com">Sponsored title</a></div>
      </div>
      <div class="thing link" id="thing_t3_abc123"`,
    );

    const normalized = normalizeOldRedditThreadHtml(oldThreadUrl, promotedHtml);

    expect(normalized).toContain("Thread title");
    expect(normalized).not.toContain("Sponsored title");
    expect(
      normalizeOldRedditThreadHtml(
        oldThreadUrl,
        promotedHtml.replace('id="thing_t3_abc123"', 'id="thing_t3_other"'),
      ),
    ).toBeNull();
  });
});
