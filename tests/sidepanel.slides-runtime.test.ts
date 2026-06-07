import { beforeEach, describe, expect, it, vi } from "vitest";
import { createSidepanelSlidesRuntime } from "../apps/chrome-extension/src/entrypoints/sidepanel/slides-runtime";

let capturedHydratorOptions: Record<string, Function> | null = null;
let capturedRunOptions: Record<string, Function> | null = null;
let summaryController: {
  applyMarkdown: ReturnType<typeof vi.fn>;
  maybeApplyPending: ReturnType<typeof vi.fn>;
  start: ReturnType<typeof vi.fn>;
  getRunId: ReturnType<typeof vi.fn>;
  setRunId: ReturnType<typeof vi.fn>;
  setUrl: ReturnType<typeof vi.fn>;
  resetSummaryState: ReturnType<typeof vi.fn>;
  setModel: ReturnType<typeof vi.fn>;
} | null = null;
let hydrator: {
  hydrateSnapshot: ReturnType<typeof vi.fn>;
  start: ReturnType<typeof vi.fn>;
  handlePayload: ReturnType<typeof vi.fn>;
  handleSummaryFromCache: ReturnType<typeof vi.fn>;
  isStreaming: ReturnType<typeof vi.fn>;
  stop: ReturnType<typeof vi.fn>;
  syncFromCache: ReturnType<typeof vi.fn>;
} | null = null;

vi.mock("../apps/chrome-extension/src/entrypoints/sidepanel/slides-summary-controller", () => ({
  createSlidesSummaryController: vi.fn(() => {
    summaryController = {
      applyMarkdown: vi.fn(),
      maybeApplyPending: vi.fn(),
      start: vi.fn(),
      getRunId: vi.fn(() => null),
      setRunId: vi.fn(),
      setUrl: vi.fn(),
      resetSummaryState: vi.fn(),
      setModel: vi.fn(),
    };
    return summaryController;
  }),
}));

vi.mock("../apps/chrome-extension/src/entrypoints/sidepanel/slides-hydrator", () => ({
  createSlidesHydrator: vi.fn((options) => {
    capturedHydratorOptions = options;
    hydrator = {
      hydrateSnapshot: vi.fn(async () => {}),
      start: vi.fn(async () => {}),
      handlePayload: vi.fn(),
      handleSummaryFromCache: vi.fn(),
      getActiveRunId: vi.fn(() => null),
      isStreaming: vi.fn(() => false),
      stop: vi.fn(),
      syncFromCache: vi.fn(),
    };
    return hydrator;
  }),
}));

vi.mock("../apps/chrome-extension/src/entrypoints/sidepanel/slides-run-runtime", () => ({
  createSlidesRunRuntime: vi.fn((options) => {
    capturedRunOptions = options;
    return {
      handleSlidesStatus: vi.fn(),
      startSlidesStreamForRunId: vi.fn(),
      startSlidesStream: vi.fn(),
      startSlidesSummaryStreamForRunId: vi.fn(),
    };
  }),
}));

describe("sidepanel slides runtime", () => {
  beforeEach(() => {
    capturedHydratorOptions = null;
    capturedRunOptions = null;
    summaryController = null;
    hydrator = null;
    vi.clearAllMocks();
  });

  it("delegates summary helpers to the summary controller", () => {
    const runtime = createSidepanelSlidesRuntime({
      applySlidesPayload: vi.fn(),
      clearSummarySource: vi.fn(),
      friendlyFetchError: vi.fn((_error, fallback) => fallback),
      getActiveTabUrl: vi.fn(() => "https://example.com"),
      getInputMode: vi.fn(() => "video"),
      getInputModeOverride: vi.fn(() => "video"),
      getLengthValue: vi.fn(() => "medium"),
      getPanelPhase: vi.fn(() => "idle"),
      getPanelState: vi.fn(() => ({ phase: "idle" })),
      getSlidesEnabled: vi.fn(() => true),
      getToken: vi.fn(async () => "token"),
      getTranscriptTimedText: vi.fn(() => null),
      getUiState: vi.fn(() => null),
      headerSetStatus: vi.fn(),
      hideSlideNotice: vi.fn(),
      isStreaming: vi.fn(() => false),
      panelUrlsMatch: vi.fn((left, right) => left === right),
      refreshSummarizeControl: vi.fn(),
      renderInlineSlidesFallback: vi.fn(),
      renderMarkdown: vi.fn(),
      schedulePanelCacheSync: vi.fn(),
      setInputMode: vi.fn(),
      setInputModeOverride: vi.fn(),
      setSlidesBusy: vi.fn(),
      setSlidesRunId: vi.fn(),
      showSlideNotice: vi.fn(),
      stopSlidesStream: vi.fn(),
      stopSlidesSummaryStream: vi.fn(),
      updateSlideSummaryFromMarkdown: vi.fn(),
    });

    runtime.applySlidesSummaryMarkdown("slides");
    runtime.maybeApplyPendingSlidesSummary();

    expect(summaryController?.applyMarkdown).toHaveBeenCalledWith("slides");
    expect(summaryController?.maybeApplyPending).toHaveBeenCalledOnce();
  });

  it("hydrates snapshot and surfaces retryable errors through the hydrator callback", async () => {
    const showSlideNotice = vi.fn();
    const setSlidesBusy = vi.fn();
    const headerSetStatus = vi.fn();
    createSidepanelSlidesRuntime({
      applySlidesPayload: vi.fn(),
      clearSummarySource: vi.fn(),
      friendlyFetchError: vi.fn(() => "friendly slides error"),
      getActiveTabUrl: vi.fn(() => "https://example.com"),
      getInputMode: vi.fn(() => "video"),
      getInputModeOverride: vi.fn(() => "video"),
      getLengthValue: vi.fn(() => "medium"),
      getPanelPhase: vi.fn(() => "idle"),
      getPanelState: vi.fn(() => ({ phase: "idle" })),
      getSlidesEnabled: vi.fn(() => true),
      getToken: vi.fn(async () => "token"),
      getTranscriptTimedText: vi.fn(() => null),
      getUiState: vi.fn(() => null),
      headerSetStatus,
      hideSlideNotice: vi.fn(),
      isStreaming: vi.fn(() => false),
      panelUrlsMatch: vi.fn((left, right) => left === right),
      refreshSummarizeControl: vi.fn(),
      renderInlineSlidesFallback: vi.fn(),
      renderMarkdown: vi.fn(),
      schedulePanelCacheSync: vi.fn(),
      setInputMode: vi.fn(),
      setInputModeOverride: vi.fn(),
      setSlidesBusy,
      setSlidesRunId: vi.fn(),
      showSlideNotice,
      stopSlidesStream: vi.fn(),
      stopSlidesSummaryStream: vi.fn(),
      updateSlideSummaryFromMarkdown: vi.fn(),
    });

    const message = capturedHydratorOptions?.onError?.(new Error("boom"));
    await Promise.resolve();

    expect(message).toBe("friendly slides error");
    expect(showSlideNotice).toHaveBeenCalledWith("friendly slides error", { allowRetry: true });
    expect(setSlidesBusy).toHaveBeenCalledWith(false);
    expect(headerSetStatus).toHaveBeenCalledWith("");
    expect(hydrator?.hydrateSnapshot).toHaveBeenCalledWith("timeout");
    expect(capturedRunOptions?.startSlidesHydrator).toBeTypeOf("function");
  });

  it("keeps the header text when summary streaming is still active", async () => {
    const headerSetStatus = vi.fn();
    const setSlidesBusy = vi.fn();
    createSidepanelSlidesRuntime({
      applySlidesPayload: vi.fn(),
      clearSummarySource: vi.fn(),
      friendlyFetchError: vi.fn(() => "friendly slides error"),
      getActiveTabUrl: vi.fn(() => "https://example.com"),
      getInputMode: vi.fn(() => "video"),
      getInputModeOverride: vi.fn(() => "video"),
      getLengthValue: vi.fn(() => "medium"),
      getPanelPhase: vi.fn(() => "streaming"),
      getPanelState: vi.fn(() => ({ phase: "streaming" })),
      getSlidesEnabled: vi.fn(() => true),
      getToken: vi.fn(async () => "token"),
      getTranscriptTimedText: vi.fn(() => null),
      getUiState: vi.fn(() => null),
      headerSetStatus,
      hideSlideNotice: vi.fn(),
      isStreaming: vi.fn(() => true),
      panelUrlsMatch: vi.fn((left, right) => left === right),
      refreshSummarizeControl: vi.fn(),
      renderInlineSlidesFallback: vi.fn(),
      renderMarkdown: vi.fn(),
      schedulePanelCacheSync: vi.fn(),
      setInputMode: vi.fn(),
      setInputModeOverride: vi.fn(),
      setSlidesBusy,
      setSlidesRunId: vi.fn(),
      showSlideNotice: vi.fn(),
      stopSlidesStream: vi.fn(),
      stopSlidesSummaryStream: vi.fn(),
      updateSlideSummaryFromMarkdown: vi.fn(),
    });

    const message = capturedHydratorOptions?.onError?.(new Error("boom"));
    capturedHydratorOptions?.onDone?.();
    await Promise.resolve();

    expect(message).toBe("friendly slides error");
    expect(headerSetStatus).not.toHaveBeenCalledWith("");
    expect(setSlidesBusy).toHaveBeenCalledWith(false);
  });

  it("clears the header when slide streaming finishes in idle phase", () => {
    const headerSetStatus = vi.fn();
    const setSlidesBusy = vi.fn();
    createSidepanelSlidesRuntime({
      applySlidesPayload: vi.fn(),
      clearSummarySource: vi.fn(),
      friendlyFetchError: vi.fn((_error, fallback) => fallback),
      getActiveTabUrl: vi.fn(() => "https://example.com"),
      getInputMode: vi.fn(() => "video"),
      getInputModeOverride: vi.fn(() => "video"),
      getLengthValue: vi.fn(() => "medium"),
      getPanelPhase: vi.fn(() => "idle"),
      getPanelState: vi.fn(() => ({ phase: "idle" })),
      getSlidesEnabled: vi.fn(() => true),
      getToken: vi.fn(async () => "token"),
      getTranscriptTimedText: vi.fn(() => null),
      getUiState: vi.fn(() => null),
      headerSetStatus,
      hideSlideNotice: vi.fn(),
      isStreaming: vi.fn(() => false),
      panelUrlsMatch: vi.fn((left, right) => left === right),
      refreshSummarizeControl: vi.fn(),
      renderInlineSlidesFallback: vi.fn(),
      renderMarkdown: vi.fn(),
      schedulePanelCacheSync: vi.fn(),
      setInputMode: vi.fn(),
      setInputModeOverride: vi.fn(),
      setSlidesBusy,
      setSlidesRunId: vi.fn(),
      showSlideNotice: vi.fn(),
      stopSlidesStream: vi.fn(),
      stopSlidesSummaryStream: vi.fn(),
      updateSlideSummaryFromMarkdown: vi.fn(),
    });

    capturedHydratorOptions?.onDone?.();

    expect(setSlidesBusy).toHaveBeenCalledWith(false);
    expect(headerSetStatus).toHaveBeenCalledWith("");
  });

  it("exposes run runtime helpers for slide starts and status handling", () => {
    const runtime = createSidepanelSlidesRuntime({
      applySlidesPayload: vi.fn(),
      clearSummarySource: vi.fn(),
      friendlyFetchError: vi.fn((_error, fallback) => fallback),
      getActiveTabUrl: vi.fn(() => "https://example.com"),
      getInputMode: vi.fn(() => "video"),
      getInputModeOverride: vi.fn(() => "video"),
      getLengthValue: vi.fn(() => "medium"),
      getPanelPhase: vi.fn(() => "idle"),
      getPanelState: vi.fn(() => ({ phase: "idle" })),
      getSlidesEnabled: vi.fn(() => true),
      getToken: vi.fn(async () => "token"),
      getTranscriptTimedText: vi.fn(() => null),
      getUiState: vi.fn(() => null),
      headerSetStatus: vi.fn(),
      hideSlideNotice: vi.fn(),
      isStreaming: vi.fn(() => false),
      panelUrlsMatch: vi.fn((left, right) => left === right),
      refreshSummarizeControl: vi.fn(),
      renderInlineSlidesFallback: vi.fn(),
      renderMarkdown: vi.fn(),
      schedulePanelCacheSync: vi.fn(),
      setInputMode: vi.fn(),
      setInputModeOverride: vi.fn(),
      setSlidesBusy: vi.fn(),
      setSlidesRunId: vi.fn(),
      showSlideNotice: vi.fn(),
      stopSlidesStream: vi.fn(),
      stopSlidesSummaryStream: vi.fn(),
      updateSlideSummaryFromMarkdown: vi.fn(),
    });

    expect(typeof runtime.handleSlidesStatus).toBe("function");
    expect(typeof runtime.startSlidesStream).toBe("function");
    expect(typeof runtime.startSlidesStreamForRunId).toBe("function");
    expect(typeof runtime.startSlidesSummaryStreamForRunId).toBe("function");
  });
});
