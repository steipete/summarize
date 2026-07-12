import { describe, expect, it, vi } from "vitest";
import { createPanelMessageRouter } from "../apps/chrome-extension/src/entrypoints/background/panel-message-router.js";
import type { PanelToBg } from "../apps/chrome-extension/src/lib/panel-contracts.js";

function createHarness() {
  const handlers = {
    ready: vi.fn(),
    closed: vi.fn(),
    summarize: vi.fn(),
    storeCache: vi.fn(),
    getCache: vi.fn(),
    agent: vi.fn(),
    chatHistory: vi.fn(),
    ping: vi.fn(),
    setAuto: vi.fn(),
    setLength: vi.fn(),
    slidesContext: vi.fn(),
    slidesLocal: vi.fn(),
    slidesCapture: vi.fn(),
    openOptions: vi.fn(),
    seek: vi.fn(),
  };
  const session = {
    panelOpen: false,
    panelLastPingAt: 0,
    lastSummarizedUrl: null,
    inflightUrl: "https://example.com/inflight",
  };
  return {
    handlers,
    session,
    router: createPanelMessageRouter(handlers),
  };
}

describe("chrome panel message router", () => {
  it("ignores invalid messages", () => {
    const harness = createHarness();

    harness.router(harness.session, null);
    harness.router(harness.session, {});
    harness.router(harness.session, { type: 42 });

    expect(harness.session.panelOpen).toBe(false);
    expect(
      Object.values(harness.handlers).every((handler) => handler.mock.calls.length === 0),
    ).toBe(true);
  });

  it("routes the panel protocol and marks non-close messages as live", () => {
    const harness = createHarness();
    const cache = {
      tabId: 7,
      url: "https://example.com",
      title: "Example",
      runId: null,
      slidesRunId: null,
      summaryMarkdown: null,
      summaryFromCache: null,
      slidesSummaryMarkdown: null,
      slidesSummaryComplete: null,
      slidesSummaryModel: null,
      lastMeta: { inputSummary: null, model: null, modelLabel: null },
      slides: null,
      transcriptTimedText: null,
    };
    const messages: PanelToBg[] = [
      { type: "panel:ready" },
      { type: "panel:cache", cache },
      { type: "panel:get-cache", requestId: "cache-1", tabId: 7, url: cache.url },
      { type: "panel:agent", requestId: "agent-1", messages: [], tools: [] },
      { type: "panel:chat-history", requestId: "history-1" },
      { type: "panel:setAuto", value: true },
      { type: "panel:setLength", value: "long" },
      { type: "panel:slides-context", requestId: "context-1", url: cache.url },
      { type: "panel:slides-local", requestId: "slides-1", runId: "run-1" },
      { type: "panel:slides-capture", manual: true },
      { type: "panel:openOptions" },
    ];

    for (const message of messages) harness.router(harness.session, message);

    expect(harness.session.panelOpen).toBe(true);
    expect(harness.handlers.ready).toHaveBeenCalledWith(harness.session);
    expect(harness.handlers.storeCache).toHaveBeenCalledWith(harness.session, messages[1]);
    expect(harness.handlers.getCache).toHaveBeenCalledWith(harness.session, messages[2]);
    expect(harness.handlers.agent).toHaveBeenCalledWith(harness.session, messages[3]);
    expect(harness.handlers.chatHistory).toHaveBeenCalledWith(harness.session, messages[4]);
    expect(harness.handlers.setAuto).toHaveBeenCalledWith(harness.session, true);
    expect(harness.handlers.setLength).toHaveBeenCalledWith(harness.session, "long");
    expect(harness.handlers.slidesContext).toHaveBeenCalledWith(harness.session, messages[7]);
    expect(harness.handlers.slidesLocal).toHaveBeenCalledWith(harness.session, messages[8]);
    expect(harness.handlers.slidesCapture).toHaveBeenCalledWith(harness.session, messages[9]);
    expect(harness.handlers.openOptions).toHaveBeenCalledWith(undefined);
  });

  it("routes targeted options tabs and ignores invalid tab targets", () => {
    const harness = createHarness();

    harness.router(harness.session, { type: "panel:openOptions", tab: "runtime" });
    harness.router(harness.session, { type: "panel:openOptions", tab: "missing" });

    expect(harness.handlers.openOptions).toHaveBeenNthCalledWith(1, { tab: "runtime" });
    expect(harness.handlers.openOptions).toHaveBeenNthCalledWith(2, undefined);
  });

  it("derives summarize reason and options", () => {
    const harness = createHarness();

    harness.router(harness.session, {
      type: "panel:summarize",
      refresh: true,
      inputMode: "video",
    });
    harness.router(harness.session, { type: "panel:summarize" });

    expect(harness.handlers.summarize).toHaveBeenNthCalledWith(1, harness.session, "refresh", {
      refresh: true,
      inputMode: "video",
    });
    expect(harness.handlers.summarize).toHaveBeenNthCalledWith(2, harness.session, "manual", {
      refresh: false,
      inputMode: undefined,
    });
  });

  it("tracks ping and remember-url session state", () => {
    const harness = createHarness();
    vi.spyOn(Date, "now").mockReturnValue(1234);

    harness.router(harness.session, { type: "panel:ping" });
    harness.router(harness.session, {
      type: "panel:rememberUrl",
      url: "https://example.com/remembered",
    });

    expect(harness.session.panelLastPingAt).toBe(1234);
    expect(harness.handlers.ping).toHaveBeenCalledWith(harness.session);
    expect(harness.session.lastSummarizedUrl).toBe("https://example.com/remembered");
    expect(harness.session.inflightUrl).toBeNull();
  });

  it("does not mark a close message open", () => {
    const harness = createHarness();

    harness.router(harness.session, { type: "panel:closed" });

    expect(harness.session.panelOpen).toBe(false);
    expect(harness.handlers.closed).toHaveBeenCalledWith(harness.session);
  });

  it("validates and floors seek positions", () => {
    const harness = createHarness();

    harness.router(harness.session, { type: "panel:seek", seconds: -1 });
    harness.router(harness.session, { type: "panel:seek", seconds: Number.NaN });
    harness.router(harness.session, { type: "panel:seek", seconds: 12.9 });

    expect(harness.handlers.seek).toHaveBeenCalledOnce();
    expect(harness.handlers.seek).toHaveBeenCalledWith(harness.session, 12);
  });
});
