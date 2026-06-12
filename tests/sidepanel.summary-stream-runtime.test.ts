import { beforeEach, describe, expect, it, vi } from "vitest";
import { createSummaryStreamRuntime } from "../apps/chrome-extension/src/entrypoints/sidepanel/summary-stream-runtime";
import type { PanelState } from "../apps/chrome-extension/src/entrypoints/sidepanel/types";

type StreamControllerOptions = {
  onStatus?: (text: string) => void;
  onMeta?: (data: { model?: string; modelLabel?: string; inputSummary?: string }) => void;
  onSummaryFromCache?: (value: boolean | null) => void;
  onPhaseChange?: (phase: "idle" | "connecting" | "streaming" | "error") => void;
  onError?: (error: unknown) => string;
  onReset?: () => void;
};

let capturedOptions: StreamControllerOptions | null = null;

vi.mock("../apps/chrome-extension/src/entrypoints/sidepanel/stream-controller", () => ({
  createStreamController: vi.fn((options: StreamControllerOptions) => {
    capturedOptions = options;
    return {
      start: vi.fn(),
      abort: vi.fn(),
      isStreaming: vi.fn(() => false),
    };
  }),
}));

function createPanelState(): PanelState {
  return {
    ui: null,
    runId: null,
    slidesRunId: null,
    currentSource: { url: "https://example.com/video", title: "Video" },
    lastMeta: { inputSummary: null, model: null, modelLabel: null },
    summaryMarkdown: null,
    summaryFromCache: null,
    slides: null,
    phase: "idle",
    error: null,
    chat: { messages: [], streaming: false },
  };
}

function buildRuntime() {
  capturedOptions = null;
  const panelState = createPanelState();
  const calls = {
    handleSummaryFromCache: vi.fn(),
    headerArmProgress: vi.fn(),
    headerSetBaseSubtitle: vi.fn(),
    headerSetBaseTitle: vi.fn(),
    headerSetStatus: vi.fn(),
    headerStopProgress: vi.fn(),
    queueSlidesRender: vi.fn(),
    rebuildSlideDescriptions: vi.fn(),
    refreshSummaryMetrics: vi.fn(),
    rememberUrl: vi.fn(),
    renderMarkdown: vi.fn(),
    resetSummaryView: vi.fn(),
    schedulePanelCacheSync: vi.fn(),
    seedPlannedSlidesForPendingRun: vi.fn(),
    setSlidesBusy: vi.fn(),
    setPhase: vi.fn(),
    syncWithActiveTab: vi.fn(async () => {}),
    handleSlides: vi.fn(),
  };

  const runtime = createSummaryStreamRuntime({
    friendlyFetchError: vi.fn((_error, fallback) => fallback),
    getFallbackModel: vi.fn(() => "openai/gpt-5.4"),
    getToken: vi.fn(async () => "token"),
    handleSlides: calls.handleSlides,
    handleSummaryFromCache: calls.handleSummaryFromCache,
    headerArmProgress: calls.headerArmProgress,
    headerSetBaseSubtitle: calls.headerSetBaseSubtitle,
    headerSetBaseTitle: calls.headerSetBaseTitle,
    headerSetStatus: calls.headerSetStatus,
    headerStopProgress: calls.headerStopProgress,
    isStreaming: vi.fn(() => true),
    maybeApplyPendingSlidesSummary: vi.fn(),
    panelState,
    queueSlidesRender: calls.queueSlidesRender,
    rebuildSlideDescriptions: calls.rebuildSlideDescriptions,
    refreshSummaryMetrics: calls.refreshSummaryMetrics,
    rememberUrl: calls.rememberUrl,
    renderMarkdown: calls.renderMarkdown,
    resetSummaryView: calls.resetSummaryView,
    schedulePanelCacheSync: calls.schedulePanelCacheSync,
    seedPlannedSlidesForPendingRun: calls.seedPlannedSlidesForPendingRun,
    setSlidesBusy: calls.setSlidesBusy,
    setPhase: calls.setPhase,
    shouldRebuildSlideDescriptions: vi.fn(() => true),
    syncWithActiveTab: calls.syncWithActiveTab,
  });

  return { calls, panelState, runtime };
}

describe("sidepanel summary stream runtime", () => {
  beforeEach(() => {
    capturedOptions = null;
    vi.clearAllMocks();
  });

  it("marks slides busy for slide-prefixed status updates", () => {
    const { calls } = buildRuntime();

    capturedOptions?.onStatus?.("Slides: extracting");

    expect(calls.headerSetStatus).toHaveBeenCalledWith("Slides: extracting");
    expect(calls.setSlidesBusy).toHaveBeenCalledWith(true);
  });

  it("does not mark slides busy for non-slide status updates", () => {
    const { calls } = buildRuntime();

    capturedOptions?.onStatus?.("Summarizing this page");

    expect(calls.headerSetStatus).toHaveBeenCalledWith("Summarizing this page");
    expect(calls.setSlidesBusy).not.toHaveBeenCalled();
  });

  it("updates idle subtitle metadata and schedules cache sync", () => {
    const { calls, panelState } = buildRuntime();

    capturedOptions?.onMeta?.({
      model: "openai/gpt-5.4",
      modelLabel: "GPT-5.4",
      inputSummary: "19m 33s YouTube",
    });

    expect(panelState.lastMeta).toEqual({
      inputSummary: "19m 33s YouTube",
      model: "openai/gpt-5.4",
      modelLabel: "GPT-5.4",
    });
    expect(calls.headerSetBaseSubtitle).toHaveBeenCalledTimes(1);
    expect(calls.schedulePanelCacheSync).toHaveBeenCalledOnce();
  });

  it("forwards base title and subtitle updates", () => {
    const { calls } = buildRuntime();

    capturedOptions?.onBaseTitle?.("New title");
    capturedOptions?.onBaseSubtitle?.("New subtitle");

    expect(calls.headerSetBaseTitle).toHaveBeenCalledWith("New title");
    expect(calls.headerSetBaseSubtitle).toHaveBeenCalledWith("New subtitle");
  });

  it("arms progress only for uncached streaming summaries", () => {
    const { calls, panelState } = buildRuntime();

    capturedOptions?.onSummaryFromCache?.(false);
    capturedOptions?.onSummaryFromCache?.(true);

    expect(panelState.summaryFromCache).toBe(true);
    expect(calls.handleSummaryFromCache).toHaveBeenNthCalledWith(1, false);
    expect(calls.handleSummaryFromCache).toHaveBeenNthCalledWith(2, true);
    expect(calls.headerArmProgress).toHaveBeenCalledOnce();
    expect(calls.headerStopProgress).toHaveBeenCalledOnce();
    expect(calls.schedulePanelCacheSync).toHaveBeenCalledTimes(2);
  });

  it("tracks preserve-chat on reset and clears it after use", () => {
    const { calls, panelState, runtime } = buildRuntime();

    runtime.setPreserveChatOnNextReset(true);
    capturedOptions?.onReset?.();

    expect(calls.resetSummaryView).toHaveBeenCalledWith({
      preserveChat: true,
      clearRunId: false,
      stopSlides: false,
    });
    expect(runtime.preserveChatOnNextReset()).toBe(false);
    expect(panelState.lastMeta).toEqual({
      inputSummary: null,
      model: "openai/gpt-5.4",
      modelLabel: "openai/gpt-5.4",
    });
    expect(calls.seedPlannedSlidesForPendingRun).toHaveBeenCalledOnce();
  });

  it("returns friendly errors and reuses them on error phase", () => {
    const setPhase = vi.fn();
    capturedOptions = null;
    createSummaryStreamRuntime({
      friendlyFetchError: vi.fn(() => "friendly stream error"),
      getFallbackModel: vi.fn(() => null),
      getToken: vi.fn(async () => "token"),
      handleSlides: vi.fn(),
      handleSummaryFromCache: vi.fn(),
      headerArmProgress: vi.fn(),
      headerSetBaseSubtitle: vi.fn(),
      headerSetBaseTitle: vi.fn(),
      headerSetStatus: vi.fn(),
      headerStopProgress: vi.fn(),
      isStreaming: vi.fn(() => false),
      maybeApplyPendingSlidesSummary: vi.fn(),
      panelState: createPanelState(),
      queueSlidesRender: vi.fn(),
      rebuildSlideDescriptions: vi.fn(),
      refreshSummaryMetrics: vi.fn(),
      rememberUrl: vi.fn(),
      renderMarkdown: vi.fn(),
      resetSummaryView: vi.fn(),
      schedulePanelCacheSync: vi.fn(),
      seedPlannedSlidesForPendingRun: vi.fn(),
      setSlidesBusy: vi.fn(),
      setPhase,
      shouldRebuildSlideDescriptions: vi.fn(() => false),
      syncWithActiveTab: vi.fn(async () => {}),
    });

    const message = capturedOptions?.onError?.(new Error("boom"));
    capturedOptions?.onPhaseChange?.("error");

    expect(message).toBe("friendly stream error");
    expect(setPhase).toHaveBeenCalledWith("error", { error: "friendly stream error" });
  });

  it("uses existing panel error when phase changes to error without a stream error", () => {
    const { panelState } = buildRuntime();
    panelState.error = "existing panel error";

    capturedOptions?.onPhaseChange?.("error");

    expect(panelState.error).toBe("existing panel error");
  });

  it("rebuilds slide descriptions on idle when slide titles are still missing", () => {
    const { calls, panelState } = buildRuntime();
    panelState.slides = { slides: [] } as unknown as PanelState["slides"];

    capturedOptions?.onPhaseChange?.("idle");

    expect(calls.setPhase).toHaveBeenCalledWith("idle");
    expect(calls.rebuildSlideDescriptions).toHaveBeenCalledOnce();
    expect(calls.queueSlidesRender).toHaveBeenCalledOnce();
  });

  it("does not rebuild slide descriptions on idle when there are no slides", () => {
    const { calls } = buildRuntime();

    capturedOptions?.onPhaseChange?.("idle");

    expect(calls.setPhase).toHaveBeenCalledWith("idle");
    expect(calls.rebuildSlideDescriptions).not.toHaveBeenCalled();
    expect(calls.queueSlidesRender).not.toHaveBeenCalled();
  });

  it("skips progress changes for null summary cache signals and forwards rememberUrl", () => {
    const { calls } = buildRuntime();

    capturedOptions?.onRememberUrl?.("https://example.com/remember");
    capturedOptions?.onSummaryFromCache?.(null);
    capturedOptions?.onMetrics?.("summary");

    expect(calls.rememberUrl).toHaveBeenCalledWith("https://example.com/remember");
    expect(calls.handleSummaryFromCache).toHaveBeenCalledWith(null);
    expect(calls.headerArmProgress).not.toHaveBeenCalled();
    expect(calls.headerStopProgress).not.toHaveBeenCalled();
    expect(calls.refreshSummaryMetrics).toHaveBeenCalledWith("summary");
  });

  it("keeps prior meta fields when partial metadata arrives", () => {
    const { calls, panelState } = buildRuntime();
    panelState.lastMeta = {
      inputSummary: "old input",
      model: "old-model",
      modelLabel: "Old Model",
    };

    capturedOptions?.onMeta?.({ model: "new-model" });

    expect(panelState.lastMeta).toEqual({
      inputSummary: "old input",
      model: "new-model",
      modelLabel: "Old Model",
    });
    expect(calls.schedulePanelCacheSync).toHaveBeenCalledOnce();
  });
});
