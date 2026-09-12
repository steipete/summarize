import { describe, expect, it, vi } from "vitest";
import { createInitialPanelState } from "../apps/chrome-extension/src/entrypoints/sidepanel/panel-state-store";
import { createPlannedSlidesRuntime } from "../apps/chrome-extension/src/entrypoints/sidepanel/planned-slides-runtime";
import type {
  PanelState,
  RunStart,
} from "../apps/chrome-extension/src/entrypoints/sidepanel/types";

function createRun(overrides: Partial<RunStart> = {}): RunStart {
  return {
    id: "run-1",
    url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
    title: "Video",
    model: "auto",
    reason: "manual",
    slides: true,
    ...overrides,
  };
}

function createHarness(
  options: {
    activeTabUrl?: string | null;
    dispatch?: boolean;
    length?: string;
    panelState?: PanelState;
  } = {},
) {
  const panelState = options.panelState ?? createInitialPanelState();
  const updateSlidesTextState = vi.fn();
  const queueSlidesRender = vi.fn();
  const schedulePanelCacheSync = vi.fn();
  const runtime = createPlannedSlidesRuntime({
    panelState,

    getActiveTabUrl: () => options.activeTabUrl ?? null,
    getLengthValue: () => options.length ?? "medium",
    updateSlidesTextState,
    queueSlidesRender,
    schedulePanelCacheSync,
  });
  return {
    panelState,
    queueSlidesRender,
    runtime,
    schedulePanelCacheSync,
    updateSlidesTextState,
  };
}

function enableSlides(panelState: PanelState, durationSeconds: number | null = null) {
  panelState.slidesSession.slidesEnabled = true;
  panelState.slidesSession.inputMode = "video";
  panelState.slidesSession.summarizeVideoDurationSeconds = durationSeconds;
}

describe("planned slides runtime", () => {
  it("does not seed when slides are disabled", () => {
    const harness = createHarness();
    harness.panelState.slidesSession.slidesEnabled = false;

    expect(harness.runtime.seedForRun(createRun())).toBe(false);
    expect(harness.panelState.slides).toBeNull();
    expect(harness.updateSlidesTextState).not.toHaveBeenCalled();
  });

  it("seeds bounded YouTube placeholders from duration and length", () => {
    const harness = createHarness({ length: "medium" });
    enableSlides(harness.panelState, 1_800);

    expect(harness.runtime.seedForRun(createRun())).toBe(true);

    expect(harness.panelState.slides).toMatchObject({
      sourceId: "youtube-dQw4w9WgXcQ",
      sourceKind: "youtube",
      sourceUrl: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
    });
    expect(harness.panelState.slides?.slides).toHaveLength(4);
    expect(harness.panelState.slides?.slides[0]?.timestamp).toBe(0);
    expect(harness.panelState.slides?.slides.at(-1)?.timestamp).toBeCloseTo(1_799.9);
    expect(harness.panelState.slidesSession.slidesSeededSourceId).toBe("youtube-dQw4w9WgXcQ");
    expect(harness.updateSlidesTextState).toHaveBeenCalledOnce();
    expect(harness.queueSlidesRender).toHaveBeenCalledOnce();
    expect(harness.schedulePanelCacheSync).toHaveBeenCalledWith(0);
  });

  it("uses six untimed direct placeholders without known duration", () => {
    const harness = createHarness({ dispatch: true, length: "unknown" });
    enableSlides(harness.panelState);
    const run = createRun({ id: "direct-run", url: "https://example.com/video" });

    expect(harness.runtime.seedForRun(run)).toBe(true);

    expect(harness.panelState.slides).toMatchObject({
      sourceId: "planned-direct-run",
      sourceKind: "direct",
    });
    expect(harness.panelState.slides?.slides).toHaveLength(6);
    expect(Number.isNaN(harness.panelState.slides?.slides[0]?.timestamp)).toBe(true);
  });

  it.each([
    ["short", 6],
    ["long", 12],
    ["xl", 20],
    ["xxl", 30],
  ])("maps %s length to its planned slide interval", (length, expectedCount) => {
    const harness = createHarness({ length });
    enableSlides(harness.panelState, 3_600);

    harness.runtime.seedForRun(createRun());

    expect(harness.panelState.slides?.slides).toHaveLength(expectedCount);
  });

  it("preserves resolved slides for the active run", () => {
    const panelState = createInitialPanelState();
    enableSlides(panelState, 600);
    panelState.runId = "run-1";
    panelState.slides = {
      sourceUrl: "https://example.com/other",
      sourceId: "resolved",
      sourceKind: "direct",
      ocrAvailable: false,
      slides: [{ index: 1, timestamp: 0, imageUrl: "https://example.com/1.png" }],
    };
    const existing = panelState.slides;
    const harness = createHarness({ panelState });

    expect(harness.runtime.seedForRun(createRun())).toBe(true);
    expect(harness.panelState.slides).toBe(existing);
    expect(harness.queueSlidesRender).not.toHaveBeenCalled();
  });

  it("preserves resolved slides when their URL matches a different run identity", () => {
    const panelState = createInitialPanelState();
    enableSlides(panelState, 600);
    const run = createRun();
    panelState.runId = "other-run";
    panelState.slides = {
      sourceUrl: run.url,
      sourceId: "resolved",
      sourceKind: "youtube",
      ocrAvailable: false,
      slides: [{ index: 1, timestamp: 0, imageUrl: "https://example.com/1.png" }],
    };
    const existing = panelState.slides;
    const harness = createHarness({ panelState });

    expect(harness.runtime.seedForRun(run)).toBe(true);
    expect(harness.panelState.slides).toBe(existing);
  });

  it("reuses existing matching placeholders when duration is unknown", () => {
    const panelState = createInitialPanelState();
    enableSlides(panelState);
    panelState.slides = {
      sourceUrl: "https://example.com/video",
      sourceId: "planned-direct-run",
      sourceKind: "direct",
      ocrAvailable: false,
      slides: [{ index: 1, timestamp: Number.NaN, imageUrl: "" }],
    };
    const existing = panelState.slides;
    const harness = createHarness({ panelState });

    expect(
      harness.runtime.seedForRun(createRun({ id: "direct-run", url: "https://example.com/video" })),
    ).toBe(true);
    expect(harness.panelState.slides).toBe(existing);
  });

  it("seeds and consumes a current pending run once timing is usable", () => {
    const panelState = createInitialPanelState();
    enableSlides(panelState, 900);
    const run = createRun();
    panelState.runId = run.id;
    panelState.currentSource = { url: run.url, title: run.title };
    panelState.slidesLifecycle.plannedRun = run;
    const harness = createHarness({ panelState });

    expect(harness.runtime.maybeSeedPendingRun()).toBe(true);

    expect(harness.panelState.slidesLifecycle.plannedRun).toBeNull();
    expect(
      harness.panelState.slides?.slides.some((slide) => Number.isFinite(slide.timestamp)),
    ).toBe(true);
  });

  it("keeps mismatched pending runs untouched", () => {
    const panelState = createInitialPanelState();
    enableSlides(panelState, 900);
    const run = createRun();
    panelState.runId = run.id;
    panelState.currentSource = { url: "https://example.com/other", title: null };
    panelState.slidesLifecycle.plannedRun = run;
    const harness = createHarness({ panelState });

    expect(harness.runtime.maybeSeedPendingRun()).toBe(false);
    expect(harness.panelState.slidesLifecycle.plannedRun).toBe(run);
    expect(harness.panelState.slides).toBeNull();
  });

  it("ignores absent and detached pending runs", () => {
    const panelState = createInitialPanelState();
    enableSlides(panelState, 900);
    const harness = createHarness({ panelState });

    expect(harness.runtime.maybeSeedPendingRun()).toBe(false);

    panelState.slidesLifecycle.plannedRun = createRun();
    expect(harness.runtime.maybeSeedPendingRun()).toBe(false);
    harness.runtime.seedPendingRunAndConsumeWhenReady();
    expect(harness.panelState.slides).toBeNull();
  });

  it("consumes an untimed pending run after resolved images arrive", () => {
    const panelState = createInitialPanelState();
    enableSlides(panelState);
    const run = createRun({ id: "direct-run", url: "https://example.com/video" });
    panelState.slidesRunId = run.id;
    panelState.currentSource = { url: run.url, title: run.title };
    panelState.slidesLifecycle.plannedRun = run;
    const harness = createHarness({ panelState });

    harness.runtime.seedPendingRunAndConsumeWhenReady();
    expect(harness.panelState.slidesLifecycle.plannedRun).toBe(run);

    const firstSlide = harness.panelState.slides?.slides[0];
    if (firstSlide) firstSlide.imageUrl = "https://example.com/1.png";
    harness.runtime.seedPendingRunAndConsumeWhenReady();

    expect(harness.panelState.slidesLifecycle.plannedRun).toBeNull();
  });
});
