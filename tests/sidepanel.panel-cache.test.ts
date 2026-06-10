import { describe, expect, it, vi } from "vitest";
import {
  createPanelCacheController,
  type PanelCachePayload,
} from "../apps/chrome-extension/src/entrypoints/sidepanel/panel-cache.js";

const samplePayload = (overrides: Partial<PanelCachePayload> = {}): PanelCachePayload => ({
  tabId: 1,
  url: "https://example.com",
  title: "Example",
  runId: "run-1",
  summaryMarkdown: "Hello",
  summaryFromCache: true,
  lastMeta: { inputSummary: "Summary", model: "model", modelLabel: "label" },
  slides: null,
  transcriptTimedText: null,
  ...overrides,
});

describe("panel cache controller", () => {
  it("stores and resolves snapshots per tab", () => {
    const sendCache = vi.fn();
    const sendRequest = vi.fn();
    const payload = samplePayload();
    const controller = createPanelCacheController({
      getSnapshot: () => payload,
      sendCache,
      sendRequest,
    });

    controller.syncNow();
    expect(sendCache).toHaveBeenCalledWith(payload);
    expect(controller.resolve(1, "https://example.com")).toEqual(payload);
    expect(controller.resolve(1, "https://other.example")).toBeNull();
  });

  it("debounces scheduled sync and stores latest snapshot", () => {
    vi.useFakeTimers();
    const sendCache = vi.fn();
    const sendRequest = vi.fn();
    let snapshot = samplePayload({ summaryMarkdown: "First" });
    const controller = createPanelCacheController({
      getSnapshot: () => snapshot,
      sendCache,
      sendRequest,
    });

    controller.scheduleSync(10);
    snapshot = samplePayload({ summaryMarkdown: "Second" });
    controller.scheduleSync(10);

    vi.runAllTimers();

    expect(sendCache).toHaveBeenCalledTimes(1);
    expect(sendCache).toHaveBeenCalledWith(snapshot);
    expect(controller.resolve(1, "https://example.com")?.summaryMarkdown).toBe("Second");
    vi.useRealTimers();
  });

  it("stores scheduled snapshots before the async sync fires", () => {
    vi.useFakeTimers();
    const sendCache = vi.fn();
    const sendRequest = vi.fn();
    const payload = samplePayload({
      slides: {
        sourceUrl: "https://example.com",
        sourceId: "youtube-abc123",
        sourceKind: "youtube",
        ocrAvailable: false,
        slides: [
          { index: 1, timestamp: 0, imageUrl: "" },
          { index: 2, timestamp: 30, imageUrl: "" },
        ],
      },
    });
    const controller = createPanelCacheController({
      getSnapshot: () => payload,
      sendCache,
      sendRequest,
    });

    controller.scheduleSync(0);

    expect(controller.resolve(1, "https://example.com")).toEqual(payload);
    expect(sendCache).not.toHaveBeenCalled();

    vi.runAllTimers();
    expect(sendCache).toHaveBeenCalledWith(payload);
    vi.useRealTimers();
  });

  it("returns pending request info on cache response", () => {
    const sendCache = vi.fn();
    const sendRequest = vi.fn();
    const payload = samplePayload();
    const controller = createPanelCacheController({
      getSnapshot: () => payload,
      sendCache,
      sendRequest,
    });

    const request = controller.request(2, "https://example.com/2", true);
    const result = controller.consumeResponse({
      requestId: request.requestId,
      ok: true,
      cache: payload,
    });

    expect(sendRequest).toHaveBeenCalledWith(request);
    expect(result).toEqual({
      tabId: 2,
      url: "https://example.com/2",
      preserveChat: true,
      cache: payload,
    });
  });

  it("ignores stale cache responses", () => {
    const sendCache = vi.fn();
    const sendRequest = vi.fn();
    const payload = samplePayload();
    const controller = createPanelCacheController({
      getSnapshot: () => payload,
      sendCache,
      sendRequest,
    });

    controller.request(2, "https://example.com/2", false);
    const result = controller.consumeResponse({
      requestId: "cache-unknown",
      ok: true,
      cache: payload,
    });

    expect(result).toBeNull();
  });

  it("clears local snapshots, pending requests, and scheduled syncs", () => {
    vi.useFakeTimers();
    const sendCache = vi.fn();
    const sendRequest = vi.fn();
    const payload = samplePayload();
    const controller = createPanelCacheController({
      getSnapshot: () => payload,
      sendCache,
      sendRequest,
    });

    controller.scheduleSync(10);
    const request = controller.request(2, "https://example.com/2", false);
    controller.clear();
    vi.runAllTimers();

    expect(sendCache).not.toHaveBeenCalled();
    expect(controller.resolve(1, "https://example.com")).toBeNull();
    expect(
      controller.consumeResponse({ requestId: request.requestId, ok: true, cache: payload }),
    ).toBeNull();
    vi.useRealTimers();
  });
});
