import { describe, expect, it, vi } from "vitest";
import {
  routeExtract,
  type ExtractLog,
} from "../apps/chrome-extension/src/entrypoints/background/extractors/router.js";

function createContext(overrides: Partial<Parameters<typeof routeExtract>[0]> = {}) {
  const logs: { event: string; detail?: Record<string, unknown> }[] = [];
  const log: ExtractLog = (event, detail) => {
    logs.push({ event, detail });
  };
  const extractFromTab = vi.fn(async () => ({
    ok: true as const,
    data: {
      ok: true as const,
      url: "https://example.com/article",
      title: "Page Title",
      text: "Readable page text",
      truncated: false,
      media: null,
    },
  }));
  const fetchImpl = vi.fn(
    async () => new Response("{}", { status: 500 }),
  ) as unknown as typeof fetch;

  return {
    ctx: {
      tabId: 7,
      url: "https://example.com/article",
      title: "Tab Title",
      maxChars: 10_000,
      minTextChars: 1,
      token: "token",
      fetchImpl,
      extractFromTab,
      log,
      ...overrides,
    },
    extractFromTab,
    fetchImpl,
    logs,
  };
}

describe("chrome/extractor-router", () => {
  it("hard-switches preferUrl pages without trying extractors", async () => {
    const { ctx, extractFromTab, fetchImpl, logs } = createContext({
      url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
    });

    const result = await routeExtract(ctx);

    expect(result).toBeNull();
    expect(extractFromTab).not.toHaveBeenCalled();
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(logs.map((entry) => entry.event)).toEqual([
      "extractor.route.start",
      "extractor.route.preferUrlHardSwitch",
    ]);
  });

  it("extracts Reddit comments through the .json API before page readability", async () => {
    const redditJson = [
      {
        kind: "Listing",
        data: {
          children: [
            {
              kind: "t3",
              data: {
                title: "Useful thread",
                selftext: "Original post body",
                author: "op",
                created_utc: 1_700_000_000,
                num_comments: 2,
                subreddit: "summarize",
                score: 42,
              },
            },
          ],
        },
      },
      {
        kind: "Listing",
        data: {
          children: [
            {
              kind: "t1",
              data: {
                body: "Top level comment",
                author: "alice",
                created_utc: 1_700_000_100,
                score: 5,
                replies: {
                  kind: "Listing",
                  data: {
                    children: [
                      {
                        kind: "t1",
                        data: {
                          body: "Nested reply",
                          author: "bob",
                          created_utc: 1_700_000_200,
                          score: 3,
                          replies: "",
                        },
                      },
                    ],
                  },
                },
              },
            },
          ],
        },
      },
    ];
    const fetchImpl = vi.fn(async () => Response.json(redditJson)) as unknown as typeof fetch;
    const { ctx, extractFromTab, logs } = createContext({
      url: "https://www.reddit.com/r/summarize/comments/abc123/useful_thread/",
      title: "Fallback title",
      fetchImpl,
    });

    const result = await routeExtract(ctx);

    expect(result?.source).toBe("page");
    expect(result?.extracted.title).toBe("Useful thread");
    expect(result?.extracted.text).toContain("op posted in r/summarize");
    expect(result?.extracted.text).toContain("Title: Useful thread");
    expect(result?.extracted.text).toContain(
      "[2023-11-14T22:15:00.000Z] alice (score:5): Top level comment",
    );
    expect(result?.extracted.text).toContain(
      "  [2023-11-14T22:16:40.000Z] bob (score:3): Nested reply",
    );
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://www.reddit.com/r/summarize/comments/abc123.json",
      expect.objectContaining({ credentials: "include" }),
    );
    expect(extractFromTab).not.toHaveBeenCalled();
    expect(
      logs.some(
        (entry) =>
          entry.event === "extractor.success" && entry.detail?.extractor === "reddit-thread",
      ),
    ).toBe(true);
  });

  it("falls back to page readability when Reddit .json extraction fails", async () => {
    const fetchImpl = vi.fn(
      async () => new Response("{}", { status: 429 }),
    ) as unknown as typeof fetch;
    const { ctx, extractFromTab, logs } = createContext({
      url: "https://old.reddit.com/r/summarize/comments/abc123/useful_thread/",
      fetchImpl,
    });

    const result = await routeExtract(ctx);

    expect(result?.source).toBe("page");
    expect(result?.extracted.text).toBe("Readable page text");
    expect(extractFromTab).toHaveBeenCalledOnce();
    expect(
      logs.some(
        (entry) => entry.event === "extractor.fail" && entry.detail?.extractor === "reddit-thread",
      ),
    ).toBe(true);
    expect(
      logs.some(
        (entry) =>
          entry.event === "extractor.success" && entry.detail?.extractor === "page-readability",
      ),
    ).toBe(true);
  });

  it("falls back to daemon URL extraction when page readability is too small", async () => {
    const fetchMock = vi.fn(async () =>
      Response.json({
        ok: true,
        extracted: {
          content:
            "Daemon extracted article content with enough text to satisfy the chat threshold. This covers the fallback path after page extraction returns only a tiny stub.",
          title: "Daemon Title",
          url: "https://example.com/article",
          truncated: false,
        },
      }),
    );
    const extractFromTab = vi.fn(async () => ({
      ok: true as const,
      data: {
        ok: true as const,
        url: "https://example.com/article",
        title: "Page Title",
        text: "short",
        truncated: false,
        media: null,
      },
    }));
    const { ctx, logs } = createContext({
      fetchImpl: fetchMock as unknown as typeof fetch,
      extractFromTab,
      minTextChars: 100,
    });

    const result = await routeExtract(ctx);

    expect(result?.source).toBe("url");
    expect(result?.extracted.title).toBe("Daemon Title");
    expect(result?.extracted.text).toContain("Daemon extracted article content");
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toMatchObject({
      url: "https://example.com/article",
      mode: "url",
      extractOnly: true,
    });
    expect(
      logs.some(
        (entry) => entry.event === "extractor.success" && entry.detail?.extractor === "url-daemon",
      ),
    ).toBe(true);
  });
});
