import { describe, expect, it } from "vitest";
import {
  createPanelStateStore,
  reducePanelState,
} from "../apps/chrome-extension/src/entrypoints/sidepanel/panel-state-store";

describe("sidepanel panel state store", () => {
  it("updates active tab identity as one navigation transition", () => {
    const store = createPanelStateStore();
    store.dispatch({
      type: "active-tab",
      tabId: 42,
      url: "https://example.com",
    });

    expect(store.state.navigation).toEqual({
      activeTabId: 42,
      activeTabUrl: "https://example.com",
    });

    store.dispatch({ type: "active-tab-url", url: "https://example.com/next" });
    expect(store.state.navigation).toEqual({
      activeTabId: 42,
      activeTabUrl: "https://example.com/next",
    });
  });

  it("attaches runs as one transition", () => {
    const store = createPanelStateStore();
    store.dispatch({
      type: "attach-run",
      tabId: 42,
      runId: "run-1",
      slidesRunId: "run-1",
      plannedSlidesRun: null,
      source: { url: "https://example.com", title: "Example" },
      meta: { inputSummary: null, model: "auto", modelLabel: "auto" },
    });

    expect(store.state).toMatchObject({
      runId: "run-1",
      activeRun: { tabId: 42 },
      slidesRunId: "run-1",
      slidesLifecycle: { activeRun: null, plannedRun: null },
      currentSource: { url: "https://example.com", title: "Example" },
      lastMeta: { inputSummary: null, model: "auto", modelLabel: "auto" },
    });
  });

  it("queues and consumes deferred runs by normalized URL key", () => {
    const store = createPanelStateStore();
    const urlKey = "https://example.com/video";
    const run = {
      id: "run-1",
      url: urlKey,
      title: null,
      model: "auto",
      reason: "tab-activated",
    } as const;

    store.dispatch({
      type: "pending-summary-run",
      urlKey,
      value: { type: "run", run },
    });
    store.dispatch({
      type: "pending-slides-run",
      urlKey,
      value: { runId: "slides-1", url: urlKey, local: true },
    });

    expect(store.state.pendingRuns).toEqual({
      summaryByUrl: { [urlKey]: { type: "run", run } },
      slidesByUrl: {
        [urlKey]: { runId: "slides-1", url: urlKey, local: true },
      },
    });

    store.dispatch({ type: "pending-summary-run", urlKey, value: null });
    store.dispatch({ type: "pending-slides-run", urlKey, value: null });
    expect(store.state.pendingRuns).toEqual({ summaryByUrl: {}, slidesByUrl: {} });
  });

  it("owns active and planned slides lifecycle state", () => {
    const store = createPanelStateStore();
    const plannedRun = {
      id: "run-1",
      url: "https://example.com/video",
      title: null,
      model: "auto",
      reason: "tab-activated",
    } as const;

    store.dispatch({
      type: "active-slides-run",
      value: { runId: "slides-1", url: plannedRun.url, local: true },
    });
    store.dispatch({ type: "planned-slides-run", value: plannedRun });

    expect(store.state.slidesLifecycle).toEqual({
      activeRun: { runId: "slides-1", url: plannedRun.url, local: true },
      plannedRun,
    });

    store.dispatch({ type: "active-slides-run", value: null });
    store.dispatch({ type: "planned-slides-run", value: null });
    expect(store.state.slidesLifecycle).toEqual({ activeRun: null, plannedRun: null });
  });

  it("updates slides session state and advances request identity", () => {
    const store = createPanelStateStore();

    store.dispatch({
      type: "slides-session-update",
      value: { inputMode: "video", slidesBusy: true },
    });
    store.dispatch({ type: "slides-context-request-next" });
    store.dispatch({ type: "slides-context-request-next" });

    expect(store.state.slidesSession).toMatchObject({
      inputMode: "video",
      slidesBusy: true,
      slidesContextRequestId: 2,
    });
  });

  it("owns local panel session state", () => {
    const store = createPanelStateStore();

    store.dispatch({
      type: "panel-session-update",
      value: {
        autoSummarize: true,
        settingsHydrated: true,
        lastAction: "summarize",
      },
    });

    expect(store.state.panelSession).toMatchObject({
      autoSummarize: true,
      settingsHydrated: true,
      lastAction: "summarize",
      chatEnabled: true,
    });
  });

  it("owns chat messages and streaming state", () => {
    const store = createPanelStateStore();
    const userMessage = {
      id: "user-1",
      role: "user" as const,
      content: "Hello",
      timestamp: 1,
    };
    const assistantMessage = {
      id: "assistant-1",
      role: "assistant" as const,
      content: "Hi",
      timestamp: 2,
    };

    store.dispatch({ type: "chat-message-add", message: userMessage });
    store.dispatch({ type: "chat-message-add", message: assistantMessage });
    store.dispatch({ type: "chat-streaming", value: true });
    store.dispatch({
      type: "chat-message-replace",
      message: { ...assistantMessage, content: "Updated" },
    });
    store.dispatch({ type: "chat-message-remove", id: userMessage.id });

    expect(store.state.chat).toEqual({
      messages: [{ ...assistantMessage, content: "Updated" }],
      streaming: true,
    });

    store.dispatch({ type: "chat-messages", messages: [userMessage] });
    expect(store.state.chat.messages).toEqual([userMessage]);

    store.dispatch({ type: "chat-reset" });
    expect(store.state.chat).toEqual({ messages: [], streaming: false });
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
      tabId: 42,
      runId: "run-1",
      slidesRunId: null,
      source: { url: "https://example.com", title: null },
      meta: { inputSummary: "input", model: "model", modelLabel: "Model" },
      summaryFromCache: true,
    });

    expect(store.state.summaryFromCache).toBe(true);
    expect(store.state.activeRun.tabId).toBe(42);
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
      tabId: 42,
      runId: "run-1",
      slidesRunId: "run-1",
      plannedSlidesRun: null,
      source: { url: "https://example.com", title: null },
      meta: { inputSummary: null, model: null, modelLabel: null },
    });
    store.dispatch({ type: "summary", markdown: "Summary" });
    store.dispatch({ type: "summary-cache", value: true });
    store.dispatch({
      type: "retained-slide-summary",
      value: { markdown: "Retained", url: "https://example.com" },
    });
    store.dispatch({ type: "reset-summary", clearRunId: true, clearSlides: true });

    expect(store.state).toMatchObject({
      runId: null,
      activeRun: { tabId: null },
      slidesRunId: null,
      summaryMarkdown: null,
      summaryFromCache: null,
      slides: null,
    });
    expect(store.state.retainedSlideSummary).toEqual({
      markdown: "Retained",
      url: "https://example.com",
    });

    store.dispatch({ type: "retained-slide-summary", value: null });
    expect(store.state.retainedSlideSummary).toBeNull();
  });
});
