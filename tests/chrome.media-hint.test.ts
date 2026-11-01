import { describe, expect, it, vi } from "vitest";
import { createCachedExtract } from "../apps/chrome-extension/src/entrypoints/background/cached-extract.js";
import {
  ensureChatExtract,
  primeMediaHint,
} from "../apps/chrome-extension/src/entrypoints/background/extract-cache.js";
import { createPanelSessionStore } from "../apps/chrome-extension/src/entrypoints/background/panel-session-store.js";
import { resolvePanelState } from "../apps/chrome-extension/src/entrypoints/background/panel-state.js";
import { defaultSettings } from "../apps/chrome-extension/src/lib/settings.js";

const url = "https://example.com/article";
const media = { hasVideo: false, hasAudio: false, hasCaptions: false };
type ExtractResult = Awaited<ReturnType<Parameters<typeof primeMediaHint>[0]["extractFromTab"]>>;

function createStore() {
  return createPanelSessionStore<
    ReturnType<typeof createCachedExtract>,
    { tabId: number; url: string },
    Record<string, never>,
    Record<string, never>
  >({ createDaemonRecovery: () => ({}), createDaemonStatus: () => ({}) });
}

function fullExtract(targetUrl = url) {
  return createCachedExtract({
    extracted: { url: targetUrl, text: "Full recording. ".repeat(500), truncated: false },
    source: "url",
    title: "Recording",
    transcript: { timedText: "[0:00] Full recording", source: "youtubei" },
  });
}

function pageResult(targetUrl = url): ExtractResult {
  return {
    ok: true,
    data: {
      ok: true,
      url: targetUrl,
      title: "Article",
      text: "Preview text",
      truncated: true,
      media,
      mediaDurationSeconds: 42,
    },
  };
}

function probe(
  store: ReturnType<typeof createStore>,
  extractFromTab: Parameters<typeof primeMediaHint>[0]["extractFromTab"],
  targetUrl = url,
) {
  return primeMediaHint({
    session: {},
    tabId: 7,
    url: targetUrl,
    title: "Article",
    panelSessionStore: store,
    extractFromTab,
    emitState: () => {},
  });
}

describe("media hints and chat source", () => {
  it.each(["browser", "daemon"] as const)(
    "extracts the full article for first chat after media priming in %s mode",
    async (slideRuntime) => {
      const store = createStore();
      const article = `${"Article details. ".repeat(500)}THE_ARTICLE_END`;
      const limits: number[] = [];
      const extractFromTab = vi.fn(
        async (_tabId: number, maxChars: number): Promise<ExtractResult> => {
          limits.push(maxChars);
          return {
            ok: true,
            data: {
              ok: true,
              url,
              title: "Article",
              text: article.slice(0, maxChars),
              truncated: maxChars < article.length,
              media,
            },
          };
        },
      );
      await probe(store, extractFromTab);
      const extracted = await ensureChatExtract({
        tab: { id: 7, url },
        settings: { ...defaultSettings, slideRuntime },
        panelSessionStore: store,
        sendStatus: vi.fn(),
        extractFromTab,
        fetchImpl: vi.fn(),
        daemonFetchImpl: vi.fn(),
      });
      expect(extracted.text).toBe(article);
      expect(extracted.truncated).toBe(false);
      expect(limits).toEqual([1200, Number.MAX_SAFE_INTEGER]);
    },
  );

  it("preserves full source and transcript metadata while adding a media hint", async () => {
    const store = createStore();
    const full = fullExtract();
    store.setCachedExtract(7, full);
    await probe(store, async () => pageResult());
    expect(store.getCachedExtract(7, url)).toBe(full);
    expect(store.getMediaHint(7, url)).toEqual({
      url,
      media,
      mediaDurationSeconds: 42,
      wordCount: 2,
    });
  });

  it("does not replace a full transcript that arrives while a media probe is pending", async () => {
    const store = createStore();
    const { promise, resolve } = Promise.withResolvers<ExtractResult>();
    const pending = probe(store, async () => promise);
    const full = fullExtract();
    store.setCachedExtract(7, full);
    resolve(pageResult());
    await pending;
    expect(store.getCachedExtract(7, url)).toBe(full);
  });

  it("ignores an old page's probe after a newer probe has started", async () => {
    const store = createStore();
    const { promise, resolve } = Promise.withResolvers<ExtractResult>();
    const pending = probe(store, async () => promise);
    const nextUrl = "https://example.com/new";
    const full = fullExtract(nextUrl);
    store.setCachedExtract(7, full);
    await probe(store, async () => pageResult(nextUrl), nextUrl);
    resolve(pageResult());
    await pending;
    expect(store.getCachedExtract(7, nextUrl)).toBe(full);
    expect(store.getMediaHint(7, nextUrl)?.url).toBe(nextUrl);
    expect(store.getMediaHint(7, url)).toBeNull();
  });

  it("rejects a probe response from a different URL", async () => {
    const store = createStore();
    await probe(store, async () => pageResult("https://example.com/new"));
    expect(store.getMediaHint(7)).toBeNull();
    expect(store.getCachedExtract(7)).toBeNull();
  });

  it("retries media detection after a hash change while a probe is pending", async () => {
    const store = createStore();
    const { promise, resolve } = Promise.withResolvers<ExtractResult>();
    const pending = probe(store, async () => promise);
    const anchoredUrl = `${url}#section`;
    resolve(pageResult(anchoredUrl));
    await pending;
    const extractFromTab = vi.fn(async () => pageResult(anchoredUrl));
    await probe(store, extractFromTab, anchoredUrl);
    expect(extractFromTab).toHaveBeenCalledOnce();
    expect(store.getMediaHint(7, anchoredUrl)?.url).toBe(anchoredUrl);
  });

  it("does not delete a newer page's full source when an older probe starts", async () => {
    const store = createStore();
    const nextUrl = "https://example.com/new";
    const full = fullExtract(nextUrl);
    store.setCachedExtract(7, full);
    await probe(store, async () => pageResult());
    expect(store.getCachedExtract(7, nextUrl)).toBe(full);
  });

  it("shows media hints in panel state without creating chat source content", async () => {
    const store = createStore();
    await probe(store, async () => pageResult());
    const state = await resolvePanelState({
      session: {
        windowId: 1,
        runController: null,
        agentController: null,
        inflightUrl: null,
        daemonRecovery: {
          getPendingUrl: () => null,
          maybeRecover: () => false,
          updateStatus: () => {},
        },
        daemonStatus: { resolve: (value) => value },
      },
      status: "",
      loadSettings: async () => ({ ...defaultSettings, token: "" }),
      getActiveTab: async () => ({ id: 7, url }),
      daemonHealth: async () => ({ ok: false }),
      daemonPing: async () => ({ ok: false }),
      panelSessionStore: store,
      urlsMatch: (left, right) => left === right,
      canSummarizeUrl: () => true,
    });
    expect(state.state.media).toEqual(media);
    expect(state.state.stats).toEqual({ pageWords: 2, videoDurationSeconds: 42 });
    expect(store.getCachedExtract(7)).toBeNull();
    store.clearTab(7);
    expect(store.getMediaHint(7)).toBeNull();
  });
});
