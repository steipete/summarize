import { describe, expect, it } from "vitest";
import {
  createPanelStateStore,
  reducePanelState,
} from "../apps/chrome-extension/src/entrypoints/sidepanel/panel-state-store";

describe("sidepanel panel state store", () => {
  it("attaches runs as one transition", () => {
    const store = createPanelStateStore();
    store.dispatch({
      type: "attach-run",
      runId: "run-1",
      slidesRunId: "run-1",
      source: { url: "https://example.com", title: "Example" },
      meta: { inputSummary: null, model: "auto", modelLabel: "auto" },
    });

    expect(store.state).toMatchObject({
      runId: "run-1",
      slidesRunId: "run-1",
      currentSource: { url: "https://example.com", title: "Example" },
      lastMeta: { inputSummary: null, model: "auto", modelLabel: "auto" },
    });
  });

  it("restores cached sessions without replacing omitted slides", () => {
    const store = createPanelStateStore();
    store.dispatch({
      type: "slides",
      slides: {
        sourceUrl: "https://example.com",
        sourceId: "slides-1",
        sourceKind: "youtube",
        ocrAvailable: false,
        slides: [],
      },
    });
    const existingSlides = store.state.slides;

    store.dispatch({
      type: "restore-session",
      runId: "run-1",
      slidesRunId: null,
      source: { url: "https://example.com", title: null },
      meta: { inputSummary: "input", model: "model", modelLabel: "Model" },
      summaryFromCache: true,
    });

    expect(store.state.summaryFromCache).toBe(true);
    expect(store.state.slides).toBe(existingSlides);
  });

  it("keeps phase and error invariants together", () => {
    const failed = reducePanelState(createPanelStateStore().state, {
      type: "phase",
      phase: "error",
      error: "failed",
    });
    expect(failed).toMatchObject({ phase: "error", error: "failed" });

    const recovered = reducePanelState(failed, { type: "phase", phase: "idle" });
    expect(recovered).toMatchObject({ phase: "idle", error: null });
  });

  it("resets summary and run-owned slides together", () => {
    const store = createPanelStateStore();
    store.dispatch({
      type: "attach-run",
      runId: "run-1",
      slidesRunId: "run-1",
      source: { url: "https://example.com", title: null },
      meta: { inputSummary: null, model: null, modelLabel: null },
    });
    store.dispatch({ type: "summary", markdown: "Summary" });
    store.dispatch({ type: "summary-cache", value: true });
    store.dispatch({ type: "reset-summary", clearRunId: true, clearSlides: true });

    expect(store.state).toMatchObject({
      runId: null,
      slidesRunId: null,
      summaryMarkdown: null,
      summaryFromCache: null,
      slides: null,
    });
  });
});
