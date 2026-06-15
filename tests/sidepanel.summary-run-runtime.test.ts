import { describe, expect, it, vi } from "vitest";
import {
  applyPanelStateAction,
  createInitialPanelState,
} from "../apps/chrome-extension/src/entrypoints/sidepanel/panel-state-store";
import { createSummaryRunRuntime } from "../apps/chrome-extension/src/entrypoints/sidepanel/summary-run-runtime";
import type {
  PanelState,
  RunStart,
} from "../apps/chrome-extension/src/entrypoints/sidepanel/types";

function createRun(overrides: Partial<RunStart> = {}): RunStart {
  return {
    id: "run-1",
    url: "https://example.com/watch?v=1",
    title: "Example",
    model: "openai/gpt-5.4",
    reason: "manual",
    ...overrides,
  };
}

function createHarness(
  options: {
    activeTabId?: number | null;
    activeTabUrl?: string | null;
    dispatch?: boolean;
    panelState?: PanelState;
    preserveChat?: boolean;
    streaming?: boolean;
  } = {},
) {
  const panelState = options.panelState ?? createInitialPanelState();
  panelState.navigation.activeTabId = options.activeTabId ?? 7;
  panelState.navigation.activeTabUrl =
    options.activeTabUrl === undefined ? "https://example.com/watch?v=1" : options.activeTabUrl;
  const calls = {
    browserAiCancel: vi.fn(),
    browserAiEnhance: vi.fn(),
    chatClearHistory: vi.fn(async () => {}),
    chatFinishStreamingMessage: vi.fn(),
    chatReset: vi.fn(),
    cancelAutoSummarize: vi.fn(),
    queueEmptyRender: vi.fn(),
    renderMarkdown: vi.fn(),
    setHeaderSubtitle: vi.fn(),
    setHeaderTitle: vi.fn(),
    setMetricsMode: vi.fn(),
    setPhase: vi.fn(),
    slidesQueueRender: vi.fn(),
    slidesSeedPlannedRun: vi.fn(() => true),
    slidesSetTranscriptTimedText: vi.fn(),
    slidesStart: vi.fn(),
    slidesStop: vi.fn(),
    slidesUpdateTextState: vi.fn(),
    summaryStart: vi.fn(async () => {}),
    viewReset: vi.fn(),
  };
  const runtime = createSummaryRunRuntime({
    panelState,
    dispatchPanelState: options.dispatch
      ? (action) => applyPanelStateAction(panelState, action)
      : undefined,
    getActiveTabId: () => panelState.navigation.activeTabId,
    cancelAutoSummarize: calls.cancelAutoSummarize,
    summaryStream: {
      isStreaming: () => options.streaming ?? false,
      start: calls.summaryStart,
    },
    slides: {
      queueRender: calls.slidesQueueRender,
      seedPlannedRun: calls.slidesSeedPlannedRun,
      setTranscriptTimedText: calls.slidesSetTranscriptTimedText,
      start: calls.slidesStart,
      stop: calls.slidesStop,
      updateTextState: calls.slidesUpdateTextState,
    },
    chat: {
      clearHistory: calls.chatClearHistory,
      finishStreamingMessage: calls.chatFinishStreamingMessage,
      reset: calls.chatReset,
      shouldPreserveForRun: () => options.preserveChat ?? false,
    },
    view: {
      queueEmptyRender: calls.queueEmptyRender,
      renderMarkdown: calls.renderMarkdown,
      reset: calls.viewReset,
      setHeaderSubtitle: calls.setHeaderSubtitle,
      setHeaderTitle: calls.setHeaderTitle,
      setMetricsMode: calls.setMetricsMode,
      setPhase: calls.setPhase,
    },
    browserAi: {
      cancel: calls.browserAiCancel,
      enhance: calls.browserAiEnhance,
    },
  });
  return { calls, panelState, runtime };
}

describe("summary run runtime", () => {
  it("attaches a summary-only run and resets unrelated chat and slides", () => {
    const harness = createHarness();
    harness.panelState.chat.streaming = true;
    harness.panelState.slidesSession.slidesEnabled = false;
    harness.panelState.ui = {
      settings: { model: "fallback/model" },
    } as PanelState["ui"];
    const run = createRun({ slides: false, title: null });

    harness.runtime.attachRun(run);

    expect(harness.calls.slidesStop).toHaveBeenCalledOnce();
    expect(harness.calls.browserAiCancel).toHaveBeenCalledOnce();
    expect(harness.calls.chatFinishStreamingMessage).toHaveBeenCalledOnce();
    expect(harness.calls.chatClearHistory).toHaveBeenCalledOnce();
    expect(harness.calls.chatReset).toHaveBeenCalledOnce();
    expect(harness.calls.cancelAutoSummarize).toHaveBeenCalledOnce();
    expect(harness.calls.setMetricsMode).toHaveBeenCalledWith("summary");
    expect(harness.calls.setHeaderTitle).toHaveBeenCalledWith(run.url);
    expect(harness.calls.queueEmptyRender).toHaveBeenCalledOnce();
    expect(harness.calls.summaryStart).toHaveBeenCalledWith(run);
    expect(harness.calls.slidesStart).not.toHaveBeenCalled();
    expect(harness.panelState).toMatchObject({
      runId: run.id,
      slidesRunId: null,
      currentSource: { url: run.url, title: null },
      lastMeta: {
        inputSummary: null,
        model: "fallback/model",
        modelLabel: "fallback/model",
      },
      panelSession: { lastAction: "summarize" },
    });
  });

  it("preserves chat and starts explicitly requested slides", () => {
    const panelState = createInitialPanelState();
    const run = createRun({ slides: true });
    panelState.slidesLifecycle.activeRun = {
      runId: "local-slides",
      url: `${run.url}#chapter`,
      local: true,
    };
    const harness = createHarness({ panelState, preserveChat: true });

    harness.runtime.attachRun(run);

    expect(harness.calls.slidesStop).not.toHaveBeenCalled();
    expect(harness.calls.chatClearHistory).not.toHaveBeenCalled();
    expect(harness.calls.chatReset).not.toHaveBeenCalled();
    expect(harness.calls.slidesStart).toHaveBeenCalledWith(run);
    expect(harness.calls.slidesSeedPlannedRun).toHaveBeenCalledWith(run);
    expect(harness.panelState.slidesRunId).toBe(run.id);
    expect(harness.panelState.slidesLifecycle.plannedRun).toBe(run);
  });

  it("keeps a matching local slides run when the new run explicitly disables slides", () => {
    const panelState = createInitialPanelState();
    const run = createRun({ slides: false });
    panelState.summaryMarkdown = "Existing summary";
    panelState.slidesLifecycle.activeRun = {
      runId: "local-slides",
      url: run.url,
      local: true,
    };
    const harness = createHarness({ panelState });

    harness.runtime.attachRun(run);

    expect(harness.calls.slidesStop).not.toHaveBeenCalled();
    expect(harness.calls.slidesStart).not.toHaveBeenCalled();
    expect(harness.calls.queueEmptyRender).not.toHaveBeenCalled();
    expect(harness.panelState.slidesRunId).toBe("local-slides");
  });

  it("requests slides from canonical session mode when the run has no override", () => {
    const harness = createHarness();
    harness.panelState.slidesSession.slidesEnabled = true;
    harness.panelState.slidesSession.inputMode = "page";
    harness.panelState.slidesSession.mediaAvailable = true;
    const run = createRun();

    harness.runtime.attachRun(run);

    expect(harness.calls.slidesStart).toHaveBeenCalledWith(run);
    expect(harness.panelState.slidesRunId).toBe(run.id);
  });

  it("restores a matching slides snapshot without stopping its local run", () => {
    const panelState = createInitialPanelState();
    const run = createRun({ slides: true });
    panelState.slidesLifecycle.activeRun = {
      runId: "local-slides",
      url: run.url,
      local: true,
    };
    panelState.slides = {
      sourceUrl: `${run.url}#chapter`,
      sourceId: "youtube-1",
      sourceKind: "youtube",
      ocrAvailable: true,
      transcriptTimedText: "00:00 Intro",
      slides: [{ index: 1, timestamp: 0, imageUrl: "https://example.com/1.png" }],
    };
    const slides = panelState.slides;
    const harness = createHarness({ panelState });

    harness.runtime.applySnapshot({ run, markdown: "Cached summary" });

    expect(harness.calls.viewReset).toHaveBeenCalledWith({
      clearRunId: false,
      stopSlides: false,
    });
    expect(harness.calls.chatClearHistory).not.toHaveBeenCalled();
    expect(harness.calls.chatReset).toHaveBeenCalledOnce();
    expect(harness.panelState.slides).toBe(slides);
    expect(harness.panelState.slidesRunId).toBe("youtube-1");
    expect(harness.calls.slidesSetTranscriptTimedText).toHaveBeenCalledWith("00:00 Intro");
    expect(harness.calls.slidesUpdateTextState).toHaveBeenCalledOnce();
    expect(harness.calls.slidesQueueRender).toHaveBeenCalledOnce();
    expect(harness.calls.renderMarkdown).toHaveBeenCalledWith("Cached summary");
    expect(harness.calls.setPhase).toHaveBeenCalledWith("idle");
    expect(harness.calls.browserAiEnhance).toHaveBeenCalledWith({
      type: "run:snapshot",
      run,
      markdown: "Cached summary",
    });
  });

  it("preserves a matching active slides run", () => {
    const run = createRun({ slides: true });
    const panelState = createInitialPanelState();
    panelState.slidesLifecycle.activeRun = {
      runId: run.id,
      url: run.url,
      local: false,
    };
    const harness = createHarness({ panelState });

    harness.runtime.applySnapshot({ run, markdown: "Cached summary" });

    expect(harness.calls.viewReset).toHaveBeenCalledWith({
      clearRunId: false,
      stopSlides: false,
    });
    expect(harness.panelState.slidesRunId).toBe(run.id);
  });

  it("restores summary-only snapshots without carrying unrelated slides", () => {
    const panelState = createInitialPanelState();
    panelState.slides = {
      sourceUrl: "https://example.com/other",
      sourceId: "other",
      sourceKind: "direct",
      ocrAvailable: false,
      slides: [{ index: 1, timestamp: 0, imageUrl: "" }],
    };
    const harness = createHarness({ activeTabId: 11, panelState });
    const run = createRun({ slides: false, title: null });

    harness.runtime.applySnapshot({ run, markdown: "Cached summary" });

    expect(harness.calls.viewReset).toHaveBeenCalledWith({
      clearRunId: false,
      stopSlides: true,
    });
    expect(harness.panelState).toMatchObject({
      activeRun: { tabId: 11 },
      runId: run.id,
      slidesRunId: null,
      lastMeta: {
        inputSummary: null,
        model: run.model,
        modelLabel: run.model,
      },
    });
    expect(harness.calls.slidesSetTranscriptTimedText).not.toHaveBeenCalled();
    expect(harness.calls.slidesQueueRender).not.toHaveBeenCalled();
  });

  it("normalizes, starts, and consumes pending runs", () => {
    const run = createRun({ url: "https://example.com/watch?v=1#chapter", slides: false });
    const harness = createHarness();

    harness.runtime.rememberPendingRun(run);
    expect(Object.keys(harness.panelState.pendingRuns.summaryByUrl)).toEqual([
      "https://example.com/watch?v=1",
    ]);

    expect(harness.runtime.maybeStartPendingForUrl("https://example.com/watch?v=1")).toBe(true);
    expect(harness.panelState.pendingRuns.summaryByUrl).toEqual({});
    expect(harness.calls.summaryStart).toHaveBeenCalledWith(run);
  });

  it("normalizes, restores, and consumes pending snapshots", () => {
    const run = createRun({ url: "https://example.com/watch?v=1#chapter", slides: false });
    const harness = createHarness();
    const browserAi = {
      text: "Browser source",
      length: "medium" as const,
      keyMoments: [],
    };

    harness.runtime.rememberPendingSnapshot({ run, markdown: "Cached", browserAi });

    expect(harness.runtime.maybeStartPendingForUrl("https://example.com/watch?v=1")).toBe(true);
    expect(harness.calls.renderMarkdown).toHaveBeenCalledWith("Cached");
    expect(harness.calls.browserAiEnhance).toHaveBeenCalledWith({
      type: "run:snapshot",
      run,
      markdown: "Cached",
      browserAi,
    });
    expect(harness.calls.summaryStart).not.toHaveBeenCalled();
  });

  it("leaves missing or streaming pending work untouched", () => {
    const run = createRun();
    const harness = createHarness({ streaming: true });
    harness.runtime.rememberPendingRun(run);

    expect(harness.runtime.maybeStartPendingForUrl(null)).toBe(false);
    expect(harness.runtime.maybeStartPendingForUrl("https://example.com/other")).toBe(false);
    expect(harness.runtime.maybeStartPendingForUrl(run.url)).toBe(false);
    expect(harness.panelState.pendingRuns.summaryByUrl).not.toEqual({});
    expect(harness.calls.summaryStart).not.toHaveBeenCalled();
  });
});
