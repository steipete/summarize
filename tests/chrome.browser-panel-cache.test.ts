import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createBrowserPanelCacheStore } from "../apps/chrome-extension/src/lib/browser-panel-cache.js";
import type { PanelCachePayload } from "../apps/chrome-extension/src/lib/panel-contracts.js";

function createStorageArea() {
  const values = new Map<string, unknown>();
  const area = {
    get(keys: string | string[] | null, callback: (items: Record<string, unknown>) => void) {
      const result: Record<string, unknown> = {};
      if (keys === null) {
        for (const [key, value] of values) {
          result[key] = value;
        }
        callback(result);
        return;
      }
      for (const key of Array.isArray(keys) ? keys : [keys]) {
        if (values.has(key)) result[key] = values.get(key);
      }
      callback(result);
    },
    set(items: Record<string, unknown>, callback?: () => void) {
      for (const [key, value] of Object.entries(items)) {
        values.set(key, value);
      }
      callback?.();
    },
    remove(keys: string | string[], callback?: () => void) {
      for (const key of Array.isArray(keys) ? keys : [keys]) {
        values.delete(key);
      }
      callback?.();
    },
    values,
  };
  return area;
}

function samplePayload(overrides: Partial<PanelCachePayload> = {}): PanelCachePayload {
  return {
    tabId: 1,
    url: "https://www.youtube.com/watch?v=abc#ignored",
    title: "Video",
    runId: "run",
    slidesRunId: "slides-run",
    summaryMarkdown: "Summary",
    summaryFromCache: false,
    slidesSummaryMarkdown: "## Slide 1\nSummary",
    slidesSummaryComplete: true,
    slidesSummaryModel: "browser",
    lastMeta: { inputSummary: null, model: null, modelLabel: null },
    transcriptTimedText: "0:00 hello",
    slides: {
      sourceUrl: "https://www.youtube.com/watch?v=abc",
      sourceId: "slides-run",
      sourceKind: "browser-capture",
      slideRuntime: "browser",
      ocrAvailable: false,
      transcriptTimedText: "0:00 hello",
      slides: [
        {
          index: 1,
          timestamp: 0,
          imageUrl: "data:image/jpeg;base64,AAAA",
          ocrText: null,
          ocrConfidence: null,
        },
      ],
    },
    ...overrides,
  };
}

describe("browser panel cache store", () => {
  beforeEach(() => {
    vi.stubGlobal("chrome", { runtime: { lastError: null } });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("persists panel snapshots with slide thumbnails and restores by normalized url", async () => {
    const storage = createStorageArea();
    const store = createBrowserPanelCacheStore(storage);
    const payload = samplePayload();

    await store.setPanel(payload);
    const restored = await store.getPanel("https://www.youtube.com/watch?v=abc#ignored");
    const stats = await store.stats();

    expect(restored?.slides?.slides[0]?.imageUrl).toBe("data:image/jpeg;base64,AAAA");
    expect(restored?.summaryMarkdown).toBe("Summary");
    expect(stats.totalEntries).toBe(1);
    expect(stats.sizeBytes).toBeGreaterThan(0);
  });

  it("expires entries after 30 days and clears storage", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const storage = createStorageArea();
    const store = createBrowserPanelCacheStore(storage);

    await store.setPanel(samplePayload());
    vi.setSystemTime(31 * 24 * 60 * 60 * 1000);

    expect(await store.getPanel("https://www.youtube.com/watch?v=abc")).toBeNull();
    expect((await store.stats()).totalEntries).toBe(0);

    await store.setPanel(samplePayload());
    expect((await store.clear()).totalEntries).toBe(0);
    expect(storage.values.size).toBe(1);
  });

  it("serializes concurrent writes so the index keeps every snapshot", async () => {
    const storage = createStorageArea();
    const store = createBrowserPanelCacheStore(storage);

    await Promise.all([
      store.setPanel(samplePayload({ url: "https://example.com/a" })),
      store.setPanel(samplePayload({ url: "https://example.com/b" })),
    ]);

    expect((await store.stats()).totalEntries).toBe(2);
    expect(await store.getPanel("https://example.com/a")).not.toBeNull();
    expect(await store.getPanel("https://example.com/b")).not.toBeNull();
  });

  it("discovers orphaned entries for stats and clear", async () => {
    const storage = createStorageArea();
    const store = createBrowserPanelCacheStore(storage);
    await store.setPanel(samplePayload({ url: "https://example.com/orphan" }));
    const entryKeys = Array.from(storage.values.keys()).filter((key) =>
      key.startsWith("summarize.browserCache.entry.v1."),
    );
    storage.values.set("summarize.browserCache.index.v1", []);

    expect(entryKeys.length).toBe(1);
    expect((await store.stats()).totalEntries).toBe(1);
    expect((await store.clear()).totalEntries).toBe(0);
    expect(Array.from(storage.values.keys()).filter((key) => key.includes("entry.v1")).length).toBe(
      0,
    );
  });

  it("keeps hash-routed pages isolated", async () => {
    const storage = createStorageArea();
    const store = createBrowserPanelCacheStore(storage);

    await store.setPanel(samplePayload({ url: "https://example.com/#/doc/a", title: "A" }));
    await store.setPanel(samplePayload({ url: "https://example.com/#/doc/b", title: "B" }));

    expect((await store.getPanel("https://example.com/#/doc/a"))?.title).toBe("A");
    expect((await store.getPanel("https://example.com/#/doc/b"))?.title).toBe("B");
  });
});
