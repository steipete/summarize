// @vitest-environment happy-dom
import { describe, expect, it, vi } from "vitest";
import type { PanelCachePayload } from "../apps/chrome-extension/src/entrypoints/sidepanel/panel-cache";
import { createInitialPanelState } from "../apps/chrome-extension/src/entrypoints/sidepanel/panel-state-store";
import { createSummaryViewRuntime } from "../apps/chrome-extension/src/entrypoints/sidepanel/summary-view-runtime";
import type { PanelState } from "../apps/chrome-extension/src/entrypoints/sidepanel/types";

function createPanelState(): PanelState {
  const state = createInitialPanelState();
  state.navigation.activeTabId = 1;
  state.navigation.activeTabUrl = "https://example.com/watch?v=abc123";
  state.slidesSession.slidesParallel = true;
  return state;
}

function createCachePayload(overrides: Partial<PanelCachePayload> = {}): PanelCachePayload {
  return {
    tabId: 1,
    url: "https://example.com/watch?v=abc123",
    title: "Example",
    runId: "run-1",
    slidesRunId: "slides-1",
    summaryMarkdown: null,
    summaryFromCache: true,
    slidesSummaryMarkdown: null,
    slidesSummaryComplete: null,
    slidesSummaryModel: null,
    lastMeta: { inputSummary: null, model: null, modelLabel: null },
    slides: null,
    transcriptTimedText: null,
    ...overrides,
  };
}

describe("summary view runtime", () => {
  it("rehydrates cache snapshots when every cached slide entry is invalid", () => {
    const panelState = createPanelState();
    const syncFromCache = vi.fn();
    const renderEl = document.createElement("div");
    const renderSlidesHostEl = document.createElement("div");
    const renderMarkdownHostEl = document.createElement("div");
    const runtime = createSummaryViewRuntime({
      panelState,
      renderEl,
      renderSlidesHostEl,
      renderMarkdownHostEl,
      summaryCopyBtn: document.createElement("button"),
      getSlidesRenderer: () => ({ clear: vi.fn() }),
      metricsController: { clearForMode: vi.fn() },
      headerController: { setBaseTitle: vi.fn(), setBaseSubtitle: vi.fn() },
      slidesTextController: {
        reset: vi.fn(),
        getTranscriptTimedText: vi.fn(() => null),
        getTranscriptAvailable: vi.fn(() => false),
      },
      getSlidesHydrator: () => ({ syncFromCache }),
      stopSlidesStream: vi.fn(),
      refreshSummarizeControl: vi.fn(),
      resetChatState: vi.fn(),
      setSlidesTranscriptTimedText: vi.fn(),
      getSlidesSummaryState: vi.fn(() => ({
        runId: null,
        markdown: "",
        complete: false,
        model: null,
      })),
      setSlidesSummaryState: vi.fn(),
      clearSlidesSummaryPending: vi.fn(),
      clearSlidesSummaryError: vi.fn(),
      updateSlidesTextState: vi.fn(),
      requestSlidesContext: vi.fn(),
      requestSlidesCapture: vi.fn(),
      updateSlideSummaryFromMarkdown: vi.fn(),
      renderMarkdown: vi.fn(),
      renderMarkdownDisplay: vi.fn(),
      queueSlidesRender: vi.fn(),
      setPhase: vi.fn(),
    });

    runtime.applyPanelCache(
      createCachePayload({
        slides: {
          sourceUrl: "https://example.com/watch?v=abc123",
          sourceId: "youtube-abc123",
          sourceKind: "youtube",
          ocrAvailable: false,
          slides: [{ index: 0, timestamp: 0, imageUrl: "" }],
        },
      }),
    );

    expect(panelState.slides).toBeNull();
    expect(panelState.activeRun.tabId).toBe(1);
    expect(syncFromCache).toHaveBeenCalledWith({
      runId: "slides-1",
      summaryFromCache: true,
      hasSlides: false,
    });
  });

  it("does not request transcript context when cached slides lack timed transcript text", () => {
    const panelState = createPanelState();
    panelState.slidesSession.slidesContextUrl = "https://example.com/stale";
    const requestSlidesContext = vi.fn();
    const youtubeUrl = "https://www.youtube.com/watch?v=abc123";
    panelState.navigation.activeTabUrl = youtubeUrl;
    const runtime = createSummaryViewRuntime({
      panelState,
      renderEl: document.createElement("div"),
      renderSlidesHostEl: document.createElement("div"),
      renderMarkdownHostEl: document.createElement("div"),
      summaryCopyBtn: document.createElement("button"),
      getSlidesRenderer: () => ({ clear: vi.fn() }),
      metricsController: { clearForMode: vi.fn() },
      headerController: { setBaseTitle: vi.fn(), setBaseSubtitle: vi.fn() },
      slidesTextController: {
        reset: vi.fn(),
        getTranscriptTimedText: vi.fn(() => null),
        getTranscriptAvailable: vi.fn(() => false),
      },
      getSlidesHydrator: () => ({ syncFromCache: vi.fn() }),
      stopSlidesStream: vi.fn(),
      refreshSummarizeControl: vi.fn(),
      resetChatState: vi.fn(),
      setSlidesTranscriptTimedText: vi.fn(),
      getSlidesSummaryState: vi.fn(() => ({
        runId: null,
        markdown: "",
        complete: false,
        model: null,
      })),
      setSlidesSummaryState: vi.fn(),
      clearSlidesSummaryPending: vi.fn(),
      clearSlidesSummaryError: vi.fn(),
      updateSlidesTextState: vi.fn(),
      requestSlidesContext,
      requestSlidesCapture: vi.fn(),
      updateSlideSummaryFromMarkdown: vi.fn(),
      renderMarkdown: vi.fn(),
      renderMarkdownDisplay: vi.fn(),
      queueSlidesRender: vi.fn(),
      setPhase: vi.fn(),
    });

    runtime.applyPanelCache(
      createCachePayload({
        url: youtubeUrl,
        slides: {
          sourceUrl: youtubeUrl,
          sourceId: "youtube-abc123",
          sourceKind: "youtube",
          ocrAvailable: true,
          slides: [
            {
              index: 1,
              timestamp: 0,
              imageUrl: "http://127.0.0.1:8787/v1/slides/youtube-abc123/1",
            },
          ],
        },
      }),
    );

    expect(panelState.slidesSession.slidesContextUrl).toBeNull();
    expect(requestSlidesContext).not.toHaveBeenCalled();
  });

  it("does not request browser slide capture for cached non-YouTube URL-mode pages", () => {
    const panelState = createPanelState();
    const requestSlidesCapture = vi.fn();
    panelState.navigation.activeTabUrl = "https://x.com/example/status/123";
    const runtime = createSummaryViewRuntime({
      panelState,
      renderEl: document.createElement("div"),
      renderSlidesHostEl: document.createElement("div"),
      renderMarkdownHostEl: document.createElement("div"),
      summaryCopyBtn: document.createElement("button"),
      getSlidesRenderer: () => ({ clear: vi.fn() }),
      metricsController: { clearForMode: vi.fn() },
      headerController: { setBaseTitle: vi.fn(), setBaseSubtitle: vi.fn() },
      slidesTextController: {
        reset: vi.fn(),
        getTranscriptTimedText: vi.fn(() => null),
        getTranscriptAvailable: vi.fn(() => false),
      },
      getSlidesHydrator: () => ({ syncFromCache: vi.fn() }),
      stopSlidesStream: vi.fn(),
      refreshSummarizeControl: vi.fn(),
      resetChatState: vi.fn(),
      setSlidesTranscriptTimedText: vi.fn(),
      getSlidesSummaryState: vi.fn(() => ({
        runId: null,
        markdown: "",
        complete: false,
        model: null,
      })),
      setSlidesSummaryState: vi.fn(),
      clearSlidesSummaryPending: vi.fn(),
      clearSlidesSummaryError: vi.fn(),
      updateSlidesTextState: vi.fn(),
      requestSlidesContext: vi.fn(),
      requestSlidesCapture,
      updateSlideSummaryFromMarkdown: vi.fn(),
      renderMarkdown: vi.fn(),
      renderMarkdownDisplay: vi.fn(),
      queueSlidesRender: vi.fn(),
      setPhase: vi.fn(),
    });

    runtime.applyPanelCache(
      createCachePayload({
        url: "https://x.com/example/status/123",
        summaryMarkdown: "Cached summary",
        slides: null,
      }),
    );

    expect(requestSlidesCapture).not.toHaveBeenCalled();
  });

  it("hides the persistent header copy action when resetting the summary view", () => {
    const panelState = createPanelState();
    panelState.activeRun.tabId = 1;
    const summaryCopyBtn = document.createElement("button");
    summaryCopyBtn.className = "summaryCopy";
    summaryCopyBtn.disabled = false;
    summaryCopyBtn.onclick = vi.fn();

    const runtime = createSummaryViewRuntime({
      panelState,
      renderEl: document.createElement("div"),
      renderSlidesHostEl: document.createElement("div"),
      renderMarkdownHostEl: document.createElement("div"),
      summaryCopyBtn,
      getSlidesRenderer: () => ({ clear: vi.fn() }),
      metricsController: { clearForMode: vi.fn() },
      headerController: { setBaseTitle: vi.fn(), setBaseSubtitle: vi.fn() },
      slidesTextController: {
        reset: vi.fn(),
        getTranscriptTimedText: vi.fn(() => null),
        getTranscriptAvailable: vi.fn(() => false),
      },
      getSlidesHydrator: () => ({ syncFromCache: vi.fn() }),
      stopSlidesStream: vi.fn(),
      refreshSummarizeControl: vi.fn(),
      resetChatState: vi.fn(),
      setSlidesTranscriptTimedText: vi.fn(),
      getSlidesSummaryState: vi.fn(() => ({
        runId: null,
        markdown: "",
        complete: false,
        model: null,
      })),
      setSlidesSummaryState: vi.fn(),
      clearSlidesSummaryPending: vi.fn(),
      clearSlidesSummaryError: vi.fn(),
      updateSlidesTextState: vi.fn(),
      requestSlidesContext: vi.fn(),
      requestSlidesCapture: vi.fn(),
      updateSlideSummaryFromMarkdown: vi.fn(),
      renderMarkdown: vi.fn(),
      renderMarkdownDisplay: vi.fn(),
      queueSlidesRender: vi.fn(),
      setPhase: vi.fn(),
    });

    runtime.resetSummaryView();

    expect(summaryCopyBtn.classList.contains("hidden")).toBe(true);
    expect(summaryCopyBtn.disabled).toBe(true);
    expect(summaryCopyBtn.onclick).toBeNull();
    expect(panelState.activeRun.tabId).toBeNull();
    expect(panelState.slidesSession).toMatchObject({
      slidesExpanded: true,
      slidesContextPending: false,
      slidesContextUrl: null,
      slidesSeededSourceId: null,
      slidesAppliedRunId: null,
    });
  });
});
