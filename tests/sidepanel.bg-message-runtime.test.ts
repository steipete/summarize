import { describe, expect, it, vi } from "vitest";
import { createSidepanelBgMessageRuntime } from "../apps/chrome-extension/src/entrypoints/sidepanel/bg-message-runtime";
import type { BgToPanel, UiState } from "../apps/chrome-extension/src/lib/panel-contracts";

function createRuntime(
  overrides: Partial<Parameters<typeof createSidepanelBgMessageRuntime>[0]> = {},
) {
  const options = {
    panelState: {
      ui: null,
      error: null,
      chatStreaming: false,
      currentSource: { url: "https://www.youtube.com/watch?v=current" },
      summaryMarkdown: null,
      slides: null,
    },
    applyUiState: vi.fn(),
    setStatus: vi.fn(),
    isStreaming: vi.fn(() => false),
    setPhase: vi.fn(),
    finishStreamingMessage: vi.fn(),
    setSlidesBusy: vi.fn(),
    showSlideNotice: vi.fn(),
    getActiveTabUrl: vi.fn(() => "https://www.youtube.com/watch?v=current"),
    rememberPendingSlidesRun: vi.fn(),
    startSlidesStreamForRunId: vi.fn(),
    startSlidesSummaryStreamForRunId: vi.fn(),
    handleSlidesLocal: vi.fn(),
    getSlidesContextRequestId: vi.fn(() => 1),
    setSlidesContextPending: vi.fn(),
    setSlidesTranscriptTimedText: vi.fn(),
    updateSlidesTextState: vi.fn(),
    getSlidesSummaryState: vi.fn(() => ({ complete: false, markdown: "" })),
    updateSlideSummaryFromMarkdown: vi.fn(),
    renderInlineSlidesFallback: vi.fn(),
    schedulePanelCacheSync: vi.fn(),
    consumeUiCache: vi.fn(() => null),
    clearPanelCache: vi.fn(),
    getActiveTabId: vi.fn(() => 1),
    applyPanelCache: vi.fn(),
    rememberPendingSummaryRun: vi.fn(),
    rememberPendingSummarySnapshot: vi.fn(),
    attachSummaryRun: vi.fn(),
    applySummarySnapshot: vi.fn(),
    handleChatHistory: vi.fn(),
    handleAgentChunk: vi.fn(),
    handleAgentResponse: vi.fn(),
    ...overrides,
  };
  return { runtime: createSidepanelBgMessageRuntime(options), options };
}

describe("sidepanel background message runtime", () => {
  it("preserves local browser slide runs when deferring for another tab", () => {
    const { runtime, options } = createRuntime();

    runtime.handle({
      type: "slides:run",
      ok: true,
      runId: "browser-run",
      url: "https://www.youtube.com/watch?v=other",
      local: true,
    });

    expect(options.rememberPendingSlidesRun).toHaveBeenCalledWith({
      runId: "browser-run",
      url: "https://www.youtube.com/watch?v=other",
      local: true,
    });
    expect(options.startSlidesStreamForRunId).not.toHaveBeenCalled();
    expect(options.startSlidesSummaryStreamForRunId).not.toHaveBeenCalled();
  });

  it("starts local browser slide runs without daemon summary streaming", () => {
    const { runtime, options } = createRuntime();

    runtime.handle({
      type: "slides:run",
      ok: true,
      runId: "browser-run",
      url: "https://www.youtube.com/watch?v=current",
      local: true,
    });

    expect(options.startSlidesStreamForRunId).toHaveBeenCalledWith("browser-run", {
      url: "https://www.youtube.com/watch?v=current",
      local: true,
    });
    expect(options.startSlidesSummaryStreamForRunId).not.toHaveBeenCalled();
  });

  it("starts daemon slide runs with summary streaming", () => {
    const { runtime, options } = createRuntime();

    runtime.handle({
      type: "slides:run",
      ok: true,
      runId: "daemon-run",
      url: "https://www.youtube.com/watch?v=current",
    });

    expect(options.startSlidesStreamForRunId).toHaveBeenCalledWith("daemon-run", {
      url: "https://www.youtube.com/watch?v=current",
      local: false,
    });
    expect(options.startSlidesSummaryStreamForRunId).toHaveBeenCalledWith(
      "daemon-run",
      "https://www.youtube.com/watch?v=current",
    );
  });

  it("surfaces slide run failures", () => {
    const { runtime, options } = createRuntime();

    runtime.handle({ type: "slides:run", ok: false, error: "capture failed" });

    expect(options.setSlidesBusy).toHaveBeenCalledWith(false);
    expect(options.showSlideNotice).toHaveBeenCalledWith("capture failed", { allowRetry: true });
  });

  it("gates status updates while streaming and records errors", () => {
    const { runtime, options } = createRuntime({
      isStreaming: vi.fn(() => true),
      panelState: {
        ui: null,
        error: null,
        chatStreaming: true,
        currentSource: { url: "https://www.youtube.com/watch?v=current" },
        summaryMarkdown: null,
        slides: null,
      },
    });

    runtime.handle({ type: "ui:status", status: "Working" });
    runtime.handle({ type: "run:error", message: "no daemon" });

    expect(options.setStatus).toHaveBeenCalledTimes(1);
    expect(options.setStatus).toHaveBeenCalledWith("Error: no daemon");
    expect(options.setPhase).toHaveBeenCalledWith("error", { error: "no daemon" });
    expect(options.finishStreamingMessage).toHaveBeenCalled();
  });

  it("applies current-tab cache and defers mismatched summary runs", () => {
    const cache = { summary: "cached" };
    const { runtime, options } = createRuntime({
      consumeUiCache: vi.fn(() => ({
        tabId: 1,
        url: "https://www.youtube.com/watch?v=current",
        cache,
        preserveChat: true,
      })),
    });

    runtime.handle({ type: "ui:cache", requestId: "cache-1", ok: true, cache } as BgToPanel);
    runtime.handle({
      type: "run:start",
      run: {
        id: "run-1",
        url: "https://www.youtube.com/watch?v=other",
        title: null,
        model: "auto",
        reason: "tab-activated",
      },
    });

    expect(options.applyPanelCache).toHaveBeenCalledWith(cache, { preserveChat: true });
    expect(options.rememberPendingSummaryRun).toHaveBeenCalledWith(
      expect.objectContaining({ id: "run-1" }),
    );
  });

  it("applies local browser summary snapshots without daemon streaming", () => {
    const { runtime, options } = createRuntime();

    runtime.handle({
      type: "run:snapshot",
      run: {
        id: "browser-summary",
        url: "https://www.youtube.com/watch?v=current",
        title: "Current",
        model: "Browser",
        reason: "manual",
        slides: true,
      },
      markdown: "## Summary\n\nBrowser summary.",
    });

    expect(options.applySummarySnapshot).toHaveBeenCalledWith({
      run: expect.objectContaining({ id: "browser-summary", model: "Browser" }),
      markdown: "## Summary\n\nBrowser summary.",
    });
    expect(options.attachSummaryRun).not.toHaveBeenCalled();
  });

  it("queues stale local browser summary snapshots for their tab", () => {
    const { runtime, options } = createRuntime();

    runtime.handle({
      type: "run:snapshot",
      run: {
        id: "browser-summary-other",
        url: "https://www.youtube.com/watch?v=other",
        title: "Other",
        model: "Browser",
        reason: "tab-activated",
      },
      markdown: "Wrong page",
    });

    expect(options.applySummarySnapshot).not.toHaveBeenCalled();
    expect(options.rememberPendingSummaryRun).not.toHaveBeenCalled();
    expect(options.rememberPendingSummarySnapshot).toHaveBeenCalledWith({
      run: expect.objectContaining({ id: "browser-summary-other" }),
      markdown: "Wrong page",
    });
  });

  it("uses slide context to rebuild rendered fallback text", () => {
    const { runtime, options } = createRuntime({
      panelState: {
        ui: null,
        error: null,
        chatStreaming: false,
        currentSource: { url: "https://www.youtube.com/watch?v=current" },
        summaryMarkdown: "Summary markdown",
        slides: {},
      },
      getSlidesSummaryState: vi.fn(() => ({ complete: true, markdown: "Slide markdown" })),
    });

    runtime.handle({
      type: "slides:context",
      requestId: "slides-1",
      ok: true,
      transcriptTimedText: "[0:00] hello",
    });

    expect(options.setSlidesContextPending).toHaveBeenCalledWith(false);
    expect(options.setSlidesTranscriptTimedText).toHaveBeenCalledWith("[0:00] hello");
    expect(options.updateSlideSummaryFromMarkdown).toHaveBeenCalledWith("Slide markdown", {
      preserveIfEmpty: false,
      source: "slides",
    });
    expect(options.renderInlineSlidesFallback).toHaveBeenCalled();
    expect(options.schedulePanelCacheSync).toHaveBeenCalled();
  });

  it("routes simple delegated messages", () => {
    const state = { status: "" } as UiState;
    const { runtime, options } = createRuntime();

    runtime.handle({ type: "ui:state", state });
    runtime.handle({ type: "slides:local", requestId: "local-1", ok: false, error: "missing" });
    runtime.handle({ type: "chat:history", requestId: "chat-1", ok: true, messages: [] });
    runtime.handle({ type: "agent:chunk", requestId: "agent-1", text: "hi" });
    runtime.handle({ type: "agent:response", requestId: "agent-1", ok: true });

    expect(options.applyUiState).toHaveBeenCalledWith(state);
    expect(options.handleSlidesLocal).toHaveBeenCalled();
    expect(options.handleChatHistory).toHaveBeenCalled();
    expect(options.handleAgentChunk).toHaveBeenCalled();
    expect(options.handleAgentResponse).toHaveBeenCalled();
  });

  it("clears local panel cache when background broadcasts cache invalidation", () => {
    const { runtime, options } = createRuntime({ clearPanelCache: vi.fn() });

    runtime.handle({ type: "ui:cache-cleared" });

    expect(options.clearPanelCache).toHaveBeenCalled();
  });
});
