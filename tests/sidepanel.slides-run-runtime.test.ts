import { describe, expect, it, vi } from "vitest";
import { createInitialPanelState } from "../apps/chrome-extension/src/entrypoints/sidepanel/panel-state-store";
import { createSlidesRunRuntime } from "../apps/chrome-extension/src/entrypoints/sidepanel/slides-run-runtime";
import type {
  PanelState,
  RunStart,
} from "../apps/chrome-extension/src/entrypoints/sidepanel/types";

function createRun(overrides: Partial<RunStart> = {}): RunStart {
  return {
    id: "slides-run",
    url: "https://example.com/watch?v=1",
    title: "Example",
    model: "auto",
    reason: "manual",
    slides: true,
    ...overrides,
  };
}

function createHarness(
  options: {
    dispatch?: boolean;
    hydratorStreaming?: boolean;
    panelState?: PanelState;
    summaryRunId?: string | null;
    useBrowserAiSlides?: boolean;
  } = {},
) {
  const panelState = options.panelState ?? createInitialPanelState();
  panelState.slidesSession.slidesEnabled = true;
  panelState.navigation.activeTabUrl = "https://example.com/active";
  let summaryRunId = options.summaryRunId ?? null;
  const calls = {
    headerSetStatus: vi.fn(),
    hideSlideNotice: vi.fn(),
    refreshSummarizeControl: vi.fn(),
    resetSlidesSummaryState: vi.fn(),
    schedulePanelCacheSync: vi.fn(),
    setSlidesBusy: vi.fn(),
    setSlidesSummaryModel: vi.fn(),
    setSlidesSummaryRunId: vi.fn((value: string | null) => {
      summaryRunId = value;
    }),
    setSlidesSummaryUrl: vi.fn(),
    startSlidesHydrator: vi.fn(),
    startSlidesSummaryController: vi.fn(),
    stopSlidesHydrator: vi.fn(),
    stopSlidesSummaryController: vi.fn(),
  };
  const runtime = createSlidesRunRuntime({
    panelState,

    refreshSummarizeControl: calls.refreshSummarizeControl,
    hideSlideNotice: calls.hideSlideNotice,
    setSlidesBusy: calls.setSlidesBusy,
    schedulePanelCacheSync: calls.schedulePanelCacheSync,
    isSlidesHydratorStreaming: () => options.hydratorStreaming ?? false,
    startSlidesHydrator: calls.startSlidesHydrator,
    stopSlidesHydrator: calls.stopSlidesHydrator,
    startSlidesSummaryController: calls.startSlidesSummaryController,
    stopSlidesSummaryController: calls.stopSlidesSummaryController,
    getSlidesSummaryRunId: () => summaryRunId,
    setSlidesSummaryRunId: calls.setSlidesSummaryRunId,
    setSlidesSummaryUrl: calls.setSlidesSummaryUrl,
    resetSlidesSummaryState: calls.resetSlidesSummaryState,
    setSlidesSummaryModel: calls.setSlidesSummaryModel,
    shouldUseBrowserAiSlides: () => options.useBrowserAiSlides ?? false,
    headerSetStatus: calls.headerSetStatus,
  });
  return { calls, panelState, runtime };
}

describe("slides run runtime", () => {
  it("surfaces slide status only outside active summary phases", () => {
    const harness = createHarness();

    harness.runtime.handleSlidesStatus("");
    harness.runtime.handleSlidesStatus("Summarizing");
    harness.runtime.handleSlidesStatus("Slides: extracting");

    expect(harness.calls.setSlidesBusy).toHaveBeenCalledOnce();
    expect(harness.calls.headerSetStatus).toHaveBeenCalledWith("Slides: extracting");

    harness.panelState.phase = "streaming";
    harness.runtime.handleSlidesStatus("Slides: rendering");
    expect(harness.calls.setSlidesBusy).toHaveBeenCalledTimes(2);
    expect(harness.calls.headerSetStatus).toHaveBeenCalledTimes(1);
  });

  it("stops hydrator, summary, busy state, and canonical run identities together", () => {
    const panelState = createInitialPanelState();
    panelState.slidesRunId = "slides-run";
    panelState.slidesLifecycle.activeRun = {
      runId: "slides-run",
      url: "https://example.com",
      local: false,
    };
    const harness = createHarness({ dispatch: true, panelState });

    harness.runtime.stopSlidesStream();

    expect(harness.panelState.slidesRunId).toBeNull();
    expect(harness.panelState.slidesLifecycle.activeRun).toBeNull();
    expect(harness.calls.stopSlidesHydrator).toHaveBeenCalledOnce();
    expect(harness.calls.stopSlidesSummaryController).toHaveBeenCalledOnce();
    expect(harness.calls.setSlidesBusy).toHaveBeenCalledWith(false);
  });

  it("starts identified local runs and forces canonical video mode", () => {
    const harness = createHarness();
    harness.panelState.slidesSession.inputMode = "page";
    harness.panelState.currentSource = {
      url: "https://example.com/source",
      title: "Source",
    };

    harness.runtime.startSlidesStreamForRunId("local-run", { local: true });

    expect(harness.panelState.slidesLifecycle.activeRun).toEqual({
      runId: "local-run",
      url: "https://example.com/source",
      local: true,
    });
    expect(harness.panelState.slidesRunId).toBe("local-run");
    expect(harness.panelState.slidesSession).toMatchObject({
      inputMode: "video",
      inputModeOverride: "video",
    });
    expect(harness.calls.refreshSummarizeControl).toHaveBeenCalledOnce();
    expect(harness.calls.hideSlideNotice).toHaveBeenCalledOnce();
    expect(harness.calls.setSlidesBusy).toHaveBeenCalledWith(true);
    expect(harness.calls.schedulePanelCacheSync).toHaveBeenCalledOnce();
    expect(harness.calls.startSlidesHydrator).toHaveBeenCalledWith("local-run", { local: true });
  });

  it("reuses existing active-run metadata when restarting the same run", () => {
    const panelState = createInitialPanelState();
    panelState.slidesLifecycle.activeRun = {
      runId: "slides-run",
      url: "https://example.com/original",
      local: true,
    };
    const harness = createHarness({ panelState });

    harness.runtime.startSlidesStreamForRunId("slides-run");

    expect(harness.panelState.slidesLifecycle.activeRun).toEqual({
      runId: "slides-run",
      url: "https://example.com/original",
      local: true,
    });
    expect(harness.calls.startSlidesHydrator).toHaveBeenCalledWith("slides-run", { local: true });
  });

  it("records ordinary run starts in canonical active-run state", () => {
    const harness = createHarness();
    const run = createRun();

    harness.runtime.startSlidesStream(run);

    expect(harness.panelState.slidesRunId).toBe(run.id);
    expect(harness.panelState.slidesLifecycle.activeRun).toEqual({
      runId: run.id,
      url: run.url,
      local: false,
    });
    expect(harness.calls.startSlidesHydrator).toHaveBeenCalledWith(run.id, { local: false });
  });

  it("stops all slide work when neither canonical nor UI settings allow slides", () => {
    const harness = createHarness();
    harness.panelState.slidesSession.slidesEnabled = false;

    harness.runtime.startSlidesStreamForRunId("blocked");

    expect(harness.panelState.slidesLifecycle.activeRun).toBeNull();
    expect(harness.panelState.slidesRunId).toBeNull();
    expect(harness.calls.startSlidesHydrator).not.toHaveBeenCalled();
    expect(harness.calls.stopSlidesHydrator).toHaveBeenCalledOnce();
    expect(harness.calls.stopSlidesSummaryController).toHaveBeenCalledOnce();
  });

  it("allows slide streams from the latest UI settings snapshot", () => {
    const harness = createHarness();
    harness.panelState.slidesSession.slidesEnabled = false;
    harness.panelState.ui = {
      settings: { slidesEnabled: true },
    } as PanelState["ui"];

    harness.runtime.startSlidesStreamForRunId("ui-enabled");

    expect(harness.calls.startSlidesHydrator).toHaveBeenCalledWith("ui-enabled", { local: false });
  });

  it("skips daemon summary streaming for active local slide runs", () => {
    const panelState = createInitialPanelState();
    panelState.slidesLifecycle.activeRun = {
      runId: "local-run",
      url: "https://example.com",
      local: true,
    };
    const harness = createHarness({ panelState });

    harness.runtime.startSlidesSummaryStreamForRunId("local-run", "https://example.com");

    expect(harness.calls.stopSlidesSummaryController).not.toHaveBeenCalled();
    expect(harness.calls.startSlidesSummaryController).not.toHaveBeenCalled();
  });

  it("starts one remote slides summary with canonical source and model state", () => {
    const harness = createHarness();
    harness.panelState.currentSource = {
      url: "https://example.com/source",
      title: "Source",
    };
    harness.panelState.lastMeta.model = "openai/gpt-5.4";

    harness.runtime.startSlidesSummaryStreamForRunId("remote-run");
    harness.runtime.startSlidesSummaryStreamForRunId("remote-run");

    expect(harness.calls.stopSlidesSummaryController).toHaveBeenCalledOnce();
    expect(harness.calls.setSlidesSummaryRunId).toHaveBeenCalledWith("remote-run");
    expect(harness.calls.setSlidesSummaryUrl).toHaveBeenCalledWith(null);
    expect(harness.calls.resetSlidesSummaryState).toHaveBeenCalledOnce();
    expect(harness.calls.setSlidesSummaryModel).toHaveBeenCalledWith("openai/gpt-5.4");
    expect(harness.calls.startSlidesSummaryController).toHaveBeenCalledWith({
      id: "remote-run",
      url: "https://example.com/source",
      title: "Source",
      model: "openai/gpt-5.4",
      reason: "slides-summary",
    });
    expect(harness.calls.startSlidesSummaryController).toHaveBeenCalledOnce();
  });

  it("skips daemon summary streaming when browser AI owns slide summaries", () => {
    const harness = createHarness({ useBrowserAiSlides: true });

    harness.runtime.startSlidesSummaryStreamForRunId("remote-run");

    expect(harness.calls.stopSlidesSummaryController).toHaveBeenCalledOnce();
    expect(harness.calls.startSlidesSummaryController).not.toHaveBeenCalled();
  });

  it("stops summary-only work when slides become disabled", () => {
    const harness = createHarness();
    harness.panelState.slidesSession.slidesEnabled = false;

    harness.runtime.startSlidesSummaryStreamForRunId("blocked");

    expect(harness.calls.stopSlidesSummaryController).toHaveBeenCalledOnce();
    expect(harness.calls.startSlidesSummaryController).not.toHaveBeenCalled();
  });

  it("resolves active run identity and local ownership from canonical state", () => {
    const harness = createHarness();

    expect(harness.runtime.resolveActiveSlidesRunId()).toBeNull();
    harness.panelState.runId = "summary-run";
    harness.panelState.slides = { slides: [] } as unknown as PanelState["slides"];
    expect(harness.runtime.resolveActiveSlidesRunId()).toBe("summary-run");
    harness.panelState.slidesRunId = "slides-run";
    harness.panelState.slidesLifecycle.activeRun = {
      runId: "slides-run",
      url: null,
      local: true,
    };
    expect(harness.runtime.resolveActiveSlidesRunId()).toBe("slides-run");
    expect(harness.runtime.isActiveSlidesRunLocal("slides-run")).toBe(true);
    expect(harness.runtime.isActiveSlidesRunLocal("other")).toBe(false);
  });

  it("normalizes and remembers only addressable pending slide runs", () => {
    const harness = createHarness();
    harness.runtime.rememberPendingSlidesRun({ runId: "missing-url", url: null });
    harness.runtime.rememberPendingSlidesRun({
      runId: "pending",
      url: "https://example.com/watch?v=1#chapter",
      local: true,
    });

    expect(harness.panelState.pendingRuns.slidesByUrl).toEqual({
      "https://example.com/watch?v=1": {
        runId: "pending",
        url: "https://example.com/watch?v=1#chapter",
        local: true,
      },
    });
  });

  it("starts and consumes a current remote pending run", () => {
    const harness = createHarness({ dispatch: true });
    harness.panelState.slidesSession.inputMode = "video";
    harness.runtime.rememberPendingSlidesRun({
      runId: "pending",
      url: "https://example.com/watch?v=1",
    });

    harness.runtime.maybeStartPendingSlidesForUrl("https://example.com/watch?v=1");

    expect(harness.panelState.pendingRuns.slidesByUrl).toEqual({});
    expect(harness.calls.startSlidesHydrator).toHaveBeenCalledWith("pending", { local: false });
    expect(harness.calls.startSlidesSummaryController).toHaveBeenCalledOnce();
  });

  it("does not start pending work while disabled, in page mode, or already streaming", () => {
    const disabled = createHarness();
    disabled.panelState.slidesSession.slidesEnabled = false;
    disabled.runtime.rememberPendingSlidesRun({
      runId: "pending",
      url: "https://example.com/watch?v=1",
    });
    disabled.runtime.maybeStartPendingSlidesForUrl("https://example.com/watch?v=1");
    expect(disabled.calls.startSlidesHydrator).not.toHaveBeenCalled();

    const page = createHarness();
    page.panelState.slidesSession.inputMode = "page";
    page.runtime.rememberPendingSlidesRun({
      runId: "pending",
      url: "https://example.com/watch?v=1",
    });
    page.runtime.maybeStartPendingSlidesForUrl("https://example.com/watch?v=1");
    expect(page.calls.startSlidesHydrator).not.toHaveBeenCalled();

    const streaming = createHarness({ hydratorStreaming: true });
    streaming.panelState.slidesSession.inputMode = "video";
    streaming.runtime.rememberPendingSlidesRun({
      runId: "pending",
      url: "https://example.com/watch?v=1",
    });
    streaming.runtime.maybeStartPendingSlidesForUrl(null);
    streaming.runtime.maybeStartPendingSlidesForUrl("https://example.com/other");
    streaming.runtime.maybeStartPendingSlidesForUrl("https://example.com/watch?v=1");
    expect(streaming.calls.startSlidesHydrator).not.toHaveBeenCalled();
  });

  it("consumes pending work without restarting when resolved slide images already exist", () => {
    const harness = createHarness();
    harness.panelState.slidesSession.inputMode = "video";
    harness.panelState.slidesSession.slidesSeededSourceId = "youtube-1";
    harness.panelState.slides = {
      sourceId: "youtube-1",
      sourceKind: "youtube",
      ocrAvailable: false,
      slides: [{ index: 1, timestamp: 0, imageUrl: "https://example.com/1.png" }],
    };
    harness.runtime.rememberPendingSlidesRun({
      runId: "pending",
      url: "https://example.com/watch?v=1",
    });

    harness.runtime.maybeStartPendingSlidesForUrl("https://example.com/watch?v=1");

    expect(harness.panelState.pendingRuns.slidesByUrl).toEqual({});
    expect(harness.calls.startSlidesHydrator).not.toHaveBeenCalled();
    expect(harness.calls.startSlidesSummaryController).not.toHaveBeenCalled();
  });
});
