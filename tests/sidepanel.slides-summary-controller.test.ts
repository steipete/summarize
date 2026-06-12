import { beforeEach, describe, expect, it, vi } from "vitest";
import { createSlidesSummaryController } from "../apps/chrome-extension/src/entrypoints/sidepanel/slides-summary-controller";
import type { StreamControllerOptions } from "../apps/chrome-extension/src/entrypoints/sidepanel/stream-controller";
import type { PanelState, UiState } from "../apps/chrome-extension/src/entrypoints/sidepanel/types";

let streamOptions: StreamControllerOptions | null = null;
let streamOptionsList: StreamControllerOptions[] = [];
let streamStartSpy: ReturnType<typeof vi.fn> | null = null;
let streamAbortSpy: ReturnType<typeof vi.fn> | null = null;
let streamAbortSpies: Array<ReturnType<typeof vi.fn>> = [];

vi.mock("../apps/chrome-extension/src/entrypoints/sidepanel/stream-controller", () => ({
  createStreamController: (options: StreamControllerOptions) => {
    streamOptions = options;
    streamOptionsList.push(options);
    streamStartSpy = vi.fn(async () => {});
    streamAbortSpy = vi.fn();
    streamAbortSpies.push(streamAbortSpy);
    return {
      start: streamStartSpy,
      abort: streamAbortSpy,
      isStreaming: vi.fn(() => false),
    };
  },
}));

function buildUiState(): UiState {
  return {
    panelOpen: true,
    daemon: { ok: true, authed: true },
    tab: { id: 1, url: "https://example.com/video", title: "Video" },
    media: { hasVideo: true, hasAudio: true, hasCaptions: true },
    stats: { pageWords: null, videoDurationSeconds: 120 },
    settings: {
      autoSummarize: false,
      hoverSummaries: false,
      chatEnabled: true,
      automationEnabled: false,
      slidesEnabled: true,
      slidesParallel: true,
      slidesOcrEnabled: true,
      slidesLayout: "gallery",
      model: "auto",
      length: "medium",
      tokenPresent: true,
    },
    status: "",
  };
}

function buildPanelState(): PanelState {
  return {
    ui: buildUiState(),
    runId: null,
    slidesRunId: null,
    currentSource: { url: "https://example.com/video", title: "Video" },
    lastMeta: { inputSummary: null, model: "auto", modelLabel: "auto" },
    summaryMarkdown: null,
    summaryFromCache: null,
    slides: null,
    phase: "idle",
    error: null,
    chat: { messages: [], streaming: false },
  };
}

function addSlides(panelState: PanelState): void {
  panelState.slides = {
    sourceUrl: panelState.currentSource?.url ?? "https://example.com/video",
    sourceId: "slides-1",
    sourceKind: "youtube",
    ocrAvailable: true,
    slides: [{ index: 1, timestamp: 0, imageUrl: "", ocrText: "" }],
  };
}

describe("slides summary controller", () => {
  beforeEach(() => {
    streamOptions = null;
    streamOptionsList = [];
    streamStartSpy = null;
    streamAbortSpy = null;
    streamAbortSpies = [];
  });

  it("defers markdown while slides are disabled and applies it later", () => {
    const panelState = buildPanelState();
    addSlides(panelState);
    let slidesEnabled = false;
    const updateSlideSummaryFromMarkdown = vi.fn();
    const renderMarkdown = vi.fn();
    const clearSummarySource = vi.fn();

    const controller = createSlidesSummaryController({
      getToken: async () => "token",
      friendlyFetchError: (_error, fallback) => fallback,
      panelUrlsMatch: (left, right) => left === right,
      getPanelState: () => panelState,
      getUiState: () => panelState.ui,
      getActiveTabUrl: () => panelState.currentSource?.url ?? null,
      getInputMode: () => "video",
      getInputModeOverride: () => "video",
      getSlidesEnabled: () => slidesEnabled,
      getLengthValue: () => "medium",
      getTranscriptTimedText: () => null,
      clearSummarySource,
      updateSlideSummaryFromMarkdown,
      renderMarkdown,
      renderInlineSlidesFallback: vi.fn(),
    });

    controller.applyMarkdown("[slide:1]\nSlide summary.");
    expect(updateSlideSummaryFromMarkdown).not.toHaveBeenCalled();

    slidesEnabled = true;
    controller.maybeApplyPending();

    expect(updateSlideSummaryFromMarkdown).toHaveBeenCalledWith("[slide:1]\nSlide summary.", {
      preserveIfEmpty: false,
      source: "slides",
    });
    expect(renderMarkdown).toHaveBeenCalledWith("[slide:1]\nSlide summary.");
    expect(clearSummarySource).not.toHaveBeenCalled();
  });

  it("defers markdown while the panel is in page mode", () => {
    const panelState = buildPanelState();
    addSlides(panelState);
    const updateSlideSummaryFromMarkdown = vi.fn();
    const renderMarkdown = vi.fn();
    let inputModeOverride: "page" | "video" | null = "page";

    const controller = createSlidesSummaryController({
      getToken: async () => "token",
      friendlyFetchError: (_error, fallback) => fallback,
      panelUrlsMatch: (left, right) => left === right,
      getPanelState: () => panelState,
      getUiState: () => panelState.ui,
      getActiveTabUrl: () => panelState.currentSource?.url ?? null,
      getInputMode: () => "video",
      getInputModeOverride: () => inputModeOverride,
      getSlidesEnabled: () => true,
      getLengthValue: () => "medium",
      getTranscriptTimedText: () => null,
      clearSummarySource: vi.fn(),
      updateSlideSummaryFromMarkdown,
      renderMarkdown,
      renderInlineSlidesFallback: vi.fn(),
    });

    controller.applyMarkdown("Pending summary");
    expect(updateSlideSummaryFromMarkdown).not.toHaveBeenCalled();

    inputModeOverride = "video";
    controller.maybeApplyPending();

    expect(updateSlideSummaryFromMarkdown).toHaveBeenCalledTimes(1);
    expect(renderMarkdown).toHaveBeenCalledTimes(1);
  });

  it("does not render markdown when a primary summary already exists", () => {
    const panelState = buildPanelState();
    addSlides(panelState);
    panelState.summaryMarkdown = "Primary summary";
    const updateSlideSummaryFromMarkdown = vi.fn();
    const renderMarkdown = vi.fn();

    const controller = createSlidesSummaryController({
      getToken: async () => "token",
      friendlyFetchError: (_error, fallback) => fallback,
      panelUrlsMatch: (left, right) => left === right,
      getPanelState: () => panelState,
      getUiState: () => panelState.ui,
      getActiveTabUrl: () => panelState.currentSource?.url ?? null,
      getInputMode: () => "video",
      getInputModeOverride: () => "video",
      getSlidesEnabled: () => true,
      getLengthValue: () => "medium",
      getTranscriptTimedText: () => null,
      clearSummarySource: vi.fn(),
      updateSlideSummaryFromMarkdown,
      renderMarkdown,
      renderInlineSlidesFallback: vi.fn(),
    });

    controller.applyMarkdown("[slide:1]\nSlides-only summary.");

    expect(updateSlideSummaryFromMarkdown).toHaveBeenCalledOnce();
    expect(renderMarkdown).not.toHaveBeenCalled();
  });

  it("ignores stale markdown for a different url and clears summary source on stop", () => {
    const panelState = buildPanelState();
    const updateSlideSummaryFromMarkdown = vi.fn();
    const renderMarkdown = vi.fn();
    const clearSummarySource = vi.fn();

    const controller = createSlidesSummaryController({
      getToken: async () => "token",
      friendlyFetchError: (_error, fallback) => fallback,
      panelUrlsMatch: (left, right) => left === right,
      getPanelState: () => panelState,
      getUiState: () => panelState.ui,
      getActiveTabUrl: () => panelState.currentSource?.url ?? null,
      getInputMode: () => "video",
      getInputModeOverride: () => "video",
      getSlidesEnabled: () => true,
      getLengthValue: () => "medium",
      getTranscriptTimedText: () => null,
      clearSummarySource,
      updateSlideSummaryFromMarkdown,
      renderMarkdown,
      renderInlineSlidesFallback: vi.fn(),
    });

    controller.setUrl("https://example.com/other");
    controller.applyMarkdown("Stale summary");
    expect(updateSlideSummaryFromMarkdown).not.toHaveBeenCalled();

    controller.setRunId("slides-run");
    controller.setSnapshot({ markdown: "Persisted", complete: true, model: "test-model" });
    expect(controller.getSnapshot()).toEqual({
      runId: "slides-run",
      markdown: "Persisted",
      complete: true,
      model: "test-model",
    });

    controller.stop();
    expect(clearSummarySource).toHaveBeenCalledOnce();
    expect(controller.getSnapshot()).toEqual({
      runId: null,
      markdown: "",
      complete: false,
      model: null,
    });
  });

  it("handles stream lifecycle callbacks for render, meta, error, reset, and done", () => {
    const panelState = buildPanelState();
    panelState.summaryMarkdown = "Primary summary";
    panelState.slides = {
      sourceUrl: panelState.currentSource?.url ?? "",
      sourceId: "slides-1",
      sourceKind: "youtube",
      ocrAvailable: true,
      slides: [{ index: 1, timestamp: 12, imageUrl: "", ocrText: "Hello world from slide one." }],
    };
    const updateSlideSummaryFromMarkdown = vi.fn();
    const renderMarkdown = vi.fn();
    const renderInlineSlidesFallback = vi.fn();

    const controller = createSlidesSummaryController({
      getToken: async () => "token",
      friendlyFetchError: (_error, fallback) => fallback,
      panelUrlsMatch: (left, right) => left === right,
      getPanelState: () => panelState,
      getUiState: () => panelState.ui,
      getActiveTabUrl: () => panelState.currentSource?.url ?? null,
      getInputMode: () => "video",
      getInputModeOverride: () => "video",
      getSlidesEnabled: () => true,
      getLengthValue: () => "medium",
      getTranscriptTimedText: () => "[0:12] Transcript fallback text.",
      clearSummarySource: vi.fn(),
      updateSlideSummaryFromMarkdown,
      renderMarkdown,
      renderInlineSlidesFallback,
    });

    expect(streamOptions).not.toBeNull();
    streamOptions?.onMeta({ model: "gpt-test" });
    expect(controller.getModel()).toBe("gpt-test");

    streamOptions?.onRender?.("Rendered summary");
    expect(controller.getMarkdown()).toBe("Rendered summary");
    expect(updateSlideSummaryFromMarkdown).toHaveBeenCalledWith("Rendered summary", {
      preserveIfEmpty: true,
      source: "slides-partial",
    });
    expect(renderInlineSlidesFallback).toHaveBeenCalledOnce();

    const message = streamOptions?.onError?.(new Error("boom"));
    expect(message).toBe("Slides summary failed");

    streamOptions?.onDone?.();
    expect(controller.getComplete()).toBe(false);

    streamOptions?.onReset?.();
    expect(controller.getSnapshot()).toEqual({
      runId: null,
      markdown: "",
      complete: false,
      model: "auto",
    });

    streamOptions?.onRender?.("Final summary");
    panelState.phase = "streaming";
    streamOptions?.onDone?.();
    expect(controller.getComplete()).toBe(true);

    panelState.phase = "idle";
    controller.maybeApplyPending();
    expect(updateSlideSummaryFromMarkdown).toHaveBeenLastCalledWith(expect.any(String), {
      preserveIfEmpty: false,
      source: "slides",
    });
    expect(renderMarkdown).not.toHaveBeenCalled();
  });

  it("ignores stale callbacks after switching to a newer slides summary run", async () => {
    const panelState = buildPanelState();
    addSlides(panelState);
    const updateSlideSummaryFromMarkdown = vi.fn();
    const renderMarkdown = vi.fn();

    const controller = createSlidesSummaryController({
      getToken: async () => "token",
      friendlyFetchError: (_error, fallback) => fallback,
      panelUrlsMatch: (left, right) => left === right,
      getPanelState: () => panelState,
      getUiState: () => panelState.ui,
      getActiveTabUrl: () => panelState.currentSource?.url ?? null,
      getInputMode: () => "video",
      getInputModeOverride: () => "video",
      getSlidesEnabled: () => true,
      getLengthValue: () => "medium",
      getTranscriptTimedText: () => null,
      clearSummarySource: vi.fn(),
      updateSlideSummaryFromMarkdown,
      renderMarkdown,
      renderInlineSlidesFallback: vi.fn(),
    });

    await controller.start({ runId: "slides-a", url: "https://example.com/alpha" });
    const alphaStream = streamOptionsList.at(-1);
    expect(alphaStream).toBeTruthy();

    panelState.currentSource = { url: "https://example.com/bravo", title: "Bravo" };
    await controller.start({ runId: "slides-b", url: "https://example.com/bravo" });
    const bravoStream = streamOptionsList.at(-1);
    expect(bravoStream).toBeTruthy();
    expect(bravoStream).not.toBe(alphaStream);

    alphaStream?.onRender?.("[slide:1]\nAlpha stale summary.");
    alphaStream?.onDone?.();
    expect(updateSlideSummaryFromMarkdown).not.toHaveBeenCalledWith(
      "[slide:1]\nAlpha stale summary.",
      {
        preserveIfEmpty: true,
        source: "slides-partial",
      },
    );

    bravoStream?.onRender?.("[slide:1]\nBravo fresh summary.");
    bravoStream?.onDone?.();

    expect(updateSlideSummaryFromMarkdown).toHaveBeenCalledWith("[slide:1]\nBravo fresh summary.", {
      preserveIfEmpty: true,
      source: "slides-partial",
    });
    expect(updateSlideSummaryFromMarkdown).toHaveBeenLastCalledWith(
      "[slide:1]\nBravo fresh summary.",
      {
        preserveIfEmpty: false,
        source: "slides",
      },
    );
    expect(controller.getMarkdown()).toBe("[slide:1]\nBravo fresh summary.");
    expect(controller.getComplete()).toBe(true);
  });

  it("covers empty, pending, and reset branches", async () => {
    const panelState = buildPanelState();
    panelState.lastMeta.model = null;
    panelState.ui.settings.model = "ui-model";
    let slidesEnabled = false;
    let activeTabUrl: string | null = null;
    const updateSlideSummaryFromMarkdown = vi.fn();
    const renderMarkdown = vi.fn();

    const controller = createSlidesSummaryController({
      getToken: async () => "token",
      friendlyFetchError: (_error, fallback) => fallback,
      panelUrlsMatch: (left, right) => left === right,
      getPanelState: () => panelState,
      getUiState: () => panelState.ui,
      getActiveTabUrl: () => activeTabUrl,
      getInputMode: () => "video",
      getInputModeOverride: () => null,
      getSlidesEnabled: () => slidesEnabled,
      getLengthValue: () => "short",
      getTranscriptTimedText: () => null,
      clearSummarySource: vi.fn(),
      updateSlideSummaryFromMarkdown,
      renderMarkdown,
      renderInlineSlidesFallback: vi.fn(),
    });

    controller.applyMarkdown("   ");
    expect(updateSlideSummaryFromMarkdown).not.toHaveBeenCalled();

    await controller.start({ runId: "run-1", url: "https://example.com/video" });
    expect(streamStartSpy).toHaveBeenCalledWith({
      runId: "run-1",
      url: "https://example.com/video",
    });

    controller.applyMarkdown("Pending summary");
    controller.clearPending();
    slidesEnabled = true;
    controller.maybeApplyPending();
    expect(updateSlideSummaryFromMarkdown).not.toHaveBeenCalled();

    streamOptions?.onMeta({});
    expect(controller.getModel()).toBeNull();

    streamOptions?.onRender?.("");
    streamOptions?.onDone?.();
    expect(controller.getComplete()).toBe(true);
    expect(updateSlideSummaryFromMarkdown).toHaveBeenCalledWith("", {
      preserveIfEmpty: true,
      source: "slides-partial",
    });

    streamOptions?.onError?.(new Error("boom"));
    controller.clearError();
    streamOptions?.onReset?.();
    expect(controller.getModel()).toBe("ui-model");

    controller.setModel("override-model");
    controller.resetSummaryState();
    expect(controller.getSnapshot()).toEqual({
      runId: null,
      markdown: "",
      complete: false,
      model: "override-model",
    });

    controller.stop();
    expect(streamAbortSpies.some((spy) => spy.mock.calls.length === 1)).toBe(true);
  });
});
