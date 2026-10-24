import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { extractBilibiliTranscriptInTab } from "../apps/chrome-extension/src/entrypoints/background/bilibili-transcript";
import { parseBilibiliPageVideo } from "../apps/chrome-extension/src/lib/bilibili-page-transcript";

const videoUrl = "https://www.bilibili.com/video/BV1ipnr6cExW/";
const cid = 42932375196;
const captionUrl = "https://aisubtitle.hdslb.com/bfs/ai_subtitle/prod/fixture";

function track(lan = "ai-en", subtitle_url = captionUrl) {
  return { lan, subtitle_url, is_lock: false, type: lan.startsWith("ai-") ? 1 : 0 };
}

describe("Bilibili captions in the active browser tab", () => {
  let href = videoUrl;
  let view: unknown;
  let metadata: unknown;
  let captions: unknown;
  let fetchImpl: ReturnType<typeof vi.fn<typeof fetch>>;
  let executeScript: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    href = videoUrl;
    view = {
      code: 0,
      data: { bvid: "BV1ipnr6cExW", pages: [{ page: 1, cid, duration: 567 }] },
    };
    metadata = { code: 0, data: { cid, subtitle: { subtitles: [track()] } } };
    captions = {
      body: [
        { from: 1.16, to: 2.96, content: "First caption" },
        { from: 562, to: 562.8, content: "Last caption" },
      ],
    };
    vi.stubGlobal("location", {
      get href() {
        return href;
      },
    });
    fetchImpl = vi.fn<typeof fetch>(async (input) => {
      const url = new URL(String(input));
      const payload =
        url.pathname === "/x/web-interface/view"
          ? view
          : url.pathname === "/x/player/wbi/v2"
            ? metadata
            : captions;
      return new Response(JSON.stringify(payload), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchImpl);
    executeScript = vi.fn(
      async (options: { func: (...args: never[]) => unknown; args: unknown[] }) => {
        // Run Chrome's serialized function without module scope or imported helpers.
        const injected: (...args: unknown[]) => unknown = Function(
          `return (${options.func.toString()})`,
        )();
        return [{ result: await injected(...options.args) }];
      },
    );
    vi.stubGlobal("chrome", { scripting: { executeScript } });
  });

  afterEach(() => vi.unstubAllGlobals());

  it("retrieves timestamped AI captions with login only on Bilibili's API", async () => {
    const result = await extractBilibiliTranscriptInTab(7, 10_000, videoUrl);
    expect(result).toEqual({
      ok: true,
      url: videoUrl,
      text: "Transcript:\n[0:01] First caption\n[9:22] Last caption",
      transcriptTimedText: "[0:01] First caption\n[9:22] Last caption",
      truncated: false,
      durationSeconds: 567,
      language: "ai-en",
      generated: true,
    });
    expect(executeScript).toHaveBeenCalledWith(
      expect.objectContaining({ target: { tabId: 7 }, world: "MAIN" }),
    );
    expect(
      fetchImpl.mock.calls.map(([url, options]) => [String(url), options?.credentials]),
    ).toEqual([
      ["https://api.bilibili.com/x/web-interface/view?bvid=BV1ipnr6cExW", "include"],
      [`https://api.bilibili.com/x/player/wbi/v2?bvid=BV1ipnr6cExW&cid=${cid}`, "include"],
      [captionUrl, "omit"],
    ]);
    expect(fetchImpl.mock.calls.every(([, options]) => options?.redirect === "error")).toBe(true);
  });

  it("resolves the requested part instead of using the first page or a stale player CID", async () => {
    href = `${videoUrl}?p=2`;
    view = {
      code: 0,
      data: {
        bvid: "BV1ipnr6cExW",
        pages: [
          { page: 1, cid: 1 },
          { page: 2, cid, duration: 12 },
        ],
      },
    };
    expect(await extractBilibiliTranscriptInTab(7, 10_000, href)).toMatchObject({
      ok: true,
      url: href,
      durationSeconds: 12,
    });
    expect(String(fetchImpl.mock.calls[1]?.[0])).toContain(`cid=${cid}`);
  });

  it("prefers human English captions over generated English and Chinese", async () => {
    metadata = {
      code: 0,
      data: {
        cid,
        subtitle: {
          subtitles: [track("ai-zh", `${captionUrl}/zh`), track(), track("en", `${captionUrl}/en`)],
        },
      },
    };
    expect(await extractBilibiliTranscriptInTab(7, 10_000, href)).toMatchObject({
      ok: true,
      language: "en",
      generated: false,
    });
    expect(String(fetchImpl.mock.calls.at(-1)?.[0])).toBe(`${captionUrl}/en`);
  });

  it("tries another track when a signed caption URL has expired", async () => {
    metadata = {
      code: 0,
      data: { cid, subtitle: { subtitles: [track(), track("ai-zh", `${captionUrl}/zh`)] } },
    };
    const normalFetch = fetchImpl.getMockImplementation()!;
    fetchImpl.mockImplementation(async (url, options) =>
      String(url) === captionUrl
        ? new Response("expired", { status: 403 })
        : normalFetch(url, options),
    );
    expect(await extractBilibiliTranscriptInTab(7, 10_000, href)).toMatchObject({
      ok: true,
      language: "ai-zh",
    });
  });

  it("reports missing session captions without treating page descriptions as transcripts", async () => {
    metadata = { code: 0, data: { cid, subtitle: { subtitles: [] } } };
    expect(await extractBilibiliTranscriptInTab(7, 10_000, href)).toEqual({
      ok: false,
      reason: "failed",
      error: "No Bilibili caption tracks are available in this browser session.",
    });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it.each([
    { code: 0, data: { bvid: "BV1111111111", pages: [{ page: 1, cid }] } },
    { code: -404 },
    { code: 0, data: { bvid: "BV1ipnr6cExW", pages: [{ page: 2, cid }] } },
    { code: 0, data: { bvid: "BV1ipnr6cExW", pages: [{ page: 1, cid: "invalid" }] } },
  ])("rejects mismatched or unavailable video identity: %j", async (payload) => {
    view = payload;
    expect(await extractBilibiliTranscriptInTab(7, 10_000, href)).toMatchObject({ ok: false });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("rejects caption metadata belonging to another CID", async () => {
    metadata = { code: 0, data: { cid: 1, subtitle: { subtitles: [track()] } } };
    expect(await extractBilibiliTranscriptInTab(7, 10_000, href)).toMatchObject({ ok: false });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it.each([`${videoUrl}?p=2`, videoUrl.replace("BV1ipnr6cExW", "BV1111111111")])(
    "rejects navigation to %s before injection",
    async (nextUrl) => {
      href = nextUrl;
      expect(await extractBilibiliTranscriptInTab(7, 10_000, videoUrl)).toMatchObject({
        ok: false,
      });
      expect(fetchImpl).not.toHaveBeenCalled();
    },
  );

  it("rejects navigation while a caption response body is loading", async () => {
    const normalFetch = fetchImpl.getMockImplementation()!;
    fetchImpl.mockImplementation(async (url, options) => {
      if (String(url) !== captionUrl) return normalFetch(url, options);
      return {
        ok: true,
        text: async () => {
          href = `${videoUrl}?p=2`;
          return JSON.stringify(captions);
        },
      } as Response;
    });
    expect(await extractBilibiliTranscriptInTab(7, 10_000, videoUrl)).toMatchObject({ ok: false });
  });

  it("skips locked, malformed, and untrusted caption URLs", async () => {
    metadata = {
      code: 0,
      data: {
        cid,
        subtitle: {
          subtitles: [
            { ...track(), is_lock: true },
            track("en", "https://evil.example/captions"),
            track("en", "http://aisubtitle.hdslb.com/captions"),
            track("en", "https://[invalid"),
            track("ai-zh", "//aisubtitle.hdslb.com/bfs/ai_subtitle/prod/chinese"),
          ],
        },
      },
    };
    expect(await extractBilibiliTranscriptInTab(7, 10_000, href)).toMatchObject({
      ok: true,
      language: "ai-zh",
    });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it.each([
    { body: [] },
    {
      body: [
        { from: -1, to: 4, content: "bad" },
        { from: 1, to: 1, content: "bad" },
      ],
    },
    { elements: [{ content: "Danmaku" }] },
  ])("rejects empty/malformed captions and danmaku: %j", async (body) => {
    captions = body;
    expect(await extractBilibiliTranscriptInTab(7, 10_000, href)).toMatchObject({ ok: false });
  });

  it("clamps extracted and timestamped text", async () => {
    expect(await extractBilibiliTranscriptInTab(7, 35, href)).toMatchObject({
      ok: true,
      truncated: true,
    });
    const result = await extractBilibiliTranscriptInTab(7, 35, href);
    if (!result.ok) throw new Error(result.error);
    expect(result.text).toHaveLength(35);
    expect(result.transcriptTimedText).toHaveLength(35);
    expect(result.text.endsWith("[TRUNCATED]")).toBe(true);
  });

  it("reports failed tab injection", async () => {
    executeScript.mockRejectedValueOnce(new Error("cannot inject"));
    expect(await extractBilibiliTranscriptInTab(7, 10_000, href)).toMatchObject({ ok: false });
  });

  it.each(["https://evil.example/video/BV1ipnr6cExW/", `${videoUrl}?p=0`, `${videoUrl}?p=1&p=2`])(
    "does not inject on unsupported URLs: %s",
    async (url) => {
      expect(await extractBilibiliTranscriptInTab(7, 10_000, url)).toMatchObject({ ok: false });
      expect(executeScript).not.toHaveBeenCalled();
    },
  );
});

describe("Bilibili browser URL identity", () => {
  it("accepts a language path and preserves the part", () => {
    expect(
      parseBilibiliPageVideo("https://www.bilibili.com/en/video/BV1ipnr6cExW?p=2&tracking=1"),
    ).toMatchObject({ bvid: "BV1ipnr6cExW", part: 2 });
  });
  it.each([
    "https://bilibili.com.evil.example/video/BV1ipnr6cExW",
    "https://www.bilibili.com/video/av123",
    `${videoUrl}?p=-1`,
    `${videoUrl}?p=1.5`,
    `${videoUrl}?p=01`,
    `${videoUrl}?p=9007199254740992`,
  ])("rejects unsupported identity: %s", (url) => {
    expect(parseBilibiliPageVideo(url)).toBeNull();
  });
});
