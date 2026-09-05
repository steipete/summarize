import { describe, expect, it } from "vitest";
import {
  attachPanelRun,
  createInitialPanelState,
  createInitialSlidesSummaryState,
  createInitialSlidesTextState,
  patchPanelState,
  setPanelPhase,
  replacePanelChatMessage,
  resetPanelSummary,
  restorePanelSession,
  setPendingSlidesRun,
  setPendingSummaryRun,
} from "../apps/chrome-extension/src/entrypoints/sidepanel/panel-state-store";

describe("sidepanel panel state store", () => {
  it("updates active tab identity as one navigation transition", () => {
    const store = createInitialPanelState();
    patchPanelState(store, "navigation", { activeTabId: 42, activeTabUrl: "https://example.com" });

    expect(store.navigation).toEqual({
      activeTabId: 42,
      activeTabUrl: "https://example.com",
      lastAgentNavigation: null,
      pendingPreserveChatForUrl: null,
    });

    patchPanelState(store, "navigation", { activeTabUrl: "https://example.com/next" });
    expect(store.navigation).toEqual({
      activeTabId: 42,
      activeTabUrl: "https://example.com/next",
      lastAgentNavigation: null,
      pendingPreserveChatForUrl: null,
    });
  });

  it("owns navigation policy markers without losing active tab identity", () => {
    const store = createInitialPanelState();
    patchPanelState(store, "navigation", { activeTabId: 42, activeTabUrl: "https://example.com" });
    patchPanelState(store, "navigation", {
      lastAgentNavigation: {
        url: "https://example.com/next",
        tabId: 43,
        at: 100,
      },
      pendingPreserveChatForUrl: {
        url: "https://example.com/next",
        at: 101,
      },
    });

    expect(store.navigation).toEqual({
      activeTabId: 42,
      activeTabUrl: "https://example.com",
      lastAgentNavigation: {
        url: "https://example.com/next",
        tabId: 43,
        at: 100,
      },
      pendingPreserveChatForUrl: {
        url: "https://example.com/next",
        at: 101,
      },
    });

    patchPanelState(store, "navigation", {
      activeTabId: 44,
      activeTabUrl: "https://example.com/final",
    });
    expect(store.navigation.lastAgentNavigation?.tabId).toBe(43);
  });

  it("attaches runs as one transition", () => {
    const store = createInitialPanelState();
    attachPanelRun(store, {
      tabId: 42,
      runId: "run-1",
      slidesRunId: "run-1",
      plannedSlidesRun: null,
      source: { url: "https://example.com", title: "Example" },
      meta: { inputSummary: null, model: "auto", modelLabel: "auto" },
    });

    expect(store).toMatchObject({
      runId: "run-1",
      activeRun: { tabId: 42 },
      slidesRunId: "run-1",
      slidesLifecycle: { activeRun: null, plannedRun: null },
      currentSource: { url: "https://example.com", title: "Example" },
      lastMeta: { inputSummary: null, model: "auto", modelLabel: "auto" },
    });
  });

  it("queues and consumes deferred runs by normalized URL key", () => {
    const store = createInitialPanelState();
    const urlKey = "https://example.com/video";
    const run = {
      id: "run-1",
      url: urlKey,
      title: null,
      model: "auto",
      reason: "tab-activated",
    } as const;

    setPendingSummaryRun(store, urlKey, { type: "run", run });
    setPendingSlidesRun(store, urlKey, { runId: "slides-1", url: urlKey, local: true });

    expect(store.pendingRuns).toEqual({
      summaryByUrl: { [urlKey]: { type: "run", run } },
      slidesByUrl: {
        [urlKey]: { runId: "slides-1", url: urlKey, local: true },
      },
    });

    setPendingSummaryRun(store, urlKey, null);
    setPendingSlidesRun(store, urlKey, null);
    expect(store.pendingRuns).toEqual({ summaryByUrl: {}, slidesByUrl: {} });
  });

  it("owns active and planned slides lifecycle state", () => {
    const store = createInitialPanelState();
    const plannedRun = {
      id: "run-1",
      url: "https://example.com/video",
      title: null,
      model: "auto",
      reason: "tab-activated",
    } as const;

    patchPanelState(store, "slidesLifecycle", {
      activeRun: { runId: "slides-1", url: plannedRun.url, local: true },
    });
    patchPanelState(store, "slidesLifecycle", { plannedRun: plannedRun });

    expect(store.slidesLifecycle).toEqual({
      activeRun: { runId: "slides-1", url: plannedRun.url, local: true },
      plannedRun,
    });

    patchPanelState(store, "slidesLifecycle", { activeRun: null });
    patchPanelState(store, "slidesLifecycle", { plannedRun: null });
    expect(store.slidesLifecycle).toEqual({ activeRun: null, plannedRun: null });
  });

  it("owns slides summary lifecycle state", () => {
    const store = createInitialPanelState();

    patchPanelState(store, "slidesSummary", {
      runId: "slides-1",
      url: "https://example.com/video",
      markdown: "Summary",
      complete: true,
      model: "test-model",
    });

    expect(store.slidesSummary).toMatchObject({
      runId: "slides-1",
      url: "https://example.com/video",
      markdown: "Summary",
      complete: true,
      model: "test-model",
    });

    store.slidesSummary = createInitialSlidesSummaryState();
    expect(store.slidesSummary).toEqual({
      runId: null,
      url: null,
      markdown: "",
      pending: null,
      hadError: false,
      complete: false,
      model: null,
    });
  });

  it("updates slides session state and advances request identity", () => {
    const store = createInitialPanelState();

    patchPanelState(store, "slidesSession", { inputMode: "video", slidesBusy: true });
    patchPanelState(store, "slidesSession", {
      slidesContextRequestId: store.slidesSession.slidesContextRequestId + 1,
    });
    patchPanelState(store, "slidesSession", {
      slidesContextRequestId: store.slidesSession.slidesContextRequestId + 1,
    });

    expect(store.slidesSession).toMatchObject({
      inputMode: "video",
      slidesBusy: true,
      slidesContextRequestId: 2,
    });
  });

  it("owns serializable slides text state", () => {
    const store = createInitialPanelState();

    patchPanelState(store, "slidesText", {
      mode: "ocr",
      toggleVisible: true,
      transcriptTimedText: "[00:00] Intro",
      transcriptAvailable: true,
      ocrAvailable: true,
      descriptionsByIndex: { 1: "Description" },
      summariesByIndex: { 1: "Summary" },
      titlesByIndex: { 1: "Title" },
      summarySource: "slides",
    });

    expect(store.slidesText).toMatchObject({
      mode: "ocr",
      toggleVisible: true,
      descriptionsByIndex: { 1: "Description" },
      titlesByIndex: { 1: "Title" },
      summarySource: "slides",
    });

    store.slidesText = createInitialSlidesTextState();
    expect(store.slidesText).toEqual({
      mode: "transcript",
      toggleVisible: false,
      transcriptTimedText: null,
      transcriptAvailable: false,
      ocrAvailable: false,
      descriptionsByIndex: {},
      summariesByIndex: {},
      titlesByIndex: {},
      summarySource: null,
    });
  });

  it("owns local panel session state", () => {
    const store = createInitialPanelState();

    patchPanelState(store, "panelSession", {
      autoSummarize: true,
      settingsHydrated: true,
      lastAction: "summarize",
    });

    expect(store.panelSession).toMatchObject({
      autoSummarize: true,
      settingsHydrated: true,
      lastAction: "summarize",
      chatEnabled: true,
    });
  });

  it("owns chat messages and streaming state", () => {
    const store = createInitialPanelState();
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

    patchPanelState(store, "chat", { messages: [...store.chat.messages, userMessage] });
    patchPanelState(store, "chat", { messages: [...store.chat.messages, assistantMessage] });
    patchPanelState(store, "chat", { streaming: true });
    replacePanelChatMessage(store, { ...assistantMessage, content: "Updated" });
    patchPanelState(store, "chat", {
      messages: store.chat.messages.filter((message) => message.id !== userMessage.id),
    });

    expect(store.chat).toEqual({
      messages: [{ ...assistantMessage, content: "Updated" }],
      streaming: true,
      queue: [],
    });

    patchPanelState(store, "chat", { messages: [userMessage] });
    expect(store.chat.messages).toEqual([userMessage]);

    store.chat = { messages: [], streaming: false, queue: [] };
    expect(store.chat).toEqual({ messages: [], streaming: false, queue: [] });
  });

  it("owns queued chat messages", () => {
    const store = createInitialPanelState();
    const first = { id: "queue-1", text: "First", createdAt: 1 };
    const second = { id: "queue-2", text: "Second", createdAt: 2 };

    patchPanelState(store, "chat", { queue: [...store.chat.queue, first] });
    patchPanelState(store, "chat", { queue: [...store.chat.queue, second] });
    expect(store.chat.queue).toEqual([first, second]);

    patchPanelState(store, "chat", {
      queue: store.chat.queue.filter((item) => item.id !== first.id),
    });
    expect(store.chat.queue).toEqual([second]);

    patchPanelState(store, "chat", { queue: [] });
    expect(store.chat.queue).toEqual([]);
  });

  it("restores cached sessions without replacing omitted slides", () => {
    const store = createInitialPanelState();
    store.slides = {
      sourceUrl: "https://example.com",
      sourceId: "slides-1",
      sourceKind: "youtube",
      ocrAvailable: false,
      slides: [],
    };
    const existingSlides = store.slides;

    restorePanelSession(store, {
      tabId: 42,
      runId: "run-1",
      slidesRunId: null,
      source: { url: "https://example.com", title: null },
      meta: { inputSummary: "input", model: "model", modelLabel: "Model" },
      summaryFromCache: true,
    });

    expect(store.summaryFromCache).toBe(true);
    expect(store.activeRun.tabId).toBe(42);
    expect(store.slides).toBe(existingSlides);
  });

  it("keeps phase and error invariants together", () => {
    const state = createInitialPanelState();
    setPanelPhase(state, "error", "failed");
    expect(state).toMatchObject({ phase: "error", error: "failed" });
    setPanelPhase(state, "error");
    expect(state.error).toBe("failed");
    setPanelPhase(state, "idle");
    expect(state).toMatchObject({ phase: "idle", error: null });
  });

  it("keeps the root identity and replaces nested slices without mutating snapshots", () => {
    const state = createInitialPanelState();
    const original = state;
    const navigation = state.navigation;
    const chat = state.chat;
    patchPanelState(state, "navigation", { activeTabId: 42 });
    patchPanelState(state, "chat", { streaming: true });
    expect(state).toBe(original);
    expect(state.navigation).not.toBe(navigation);
    expect(navigation.activeTabId).toBeNull();
    expect(state.chat).not.toBe(chat);
    expect(chat.streaming).toBe(false);
  });

  it("resets summary and run-owned slides together", () => {
    const store = createInitialPanelState();
    attachPanelRun(store, {
      tabId: 42,
      runId: "run-1",
      slidesRunId: "run-1",
      plannedSlidesRun: null,
      source: { url: "https://example.com", title: null },
      meta: { inputSummary: null, model: null, modelLabel: null },
    });
    store.summaryMarkdown = "Summary";
    store.summaryFromCache = true;
    store.retainedSlideSummary = { markdown: "Retained", url: "https://example.com" };
    resetPanelSummary(store, { clearRunId: true, clearSlides: true });

    expect(store).toMatchObject({
      runId: null,
      activeRun: { tabId: null },
      slidesRunId: null,
      summaryMarkdown: null,
      summaryFromCache: null,
      slides: null,
    });
    expect(store.retainedSlideSummary).toEqual({
      markdown: "Retained",
      url: "https://example.com",
    });

    store.retainedSlideSummary = null;
    expect(store.retainedSlideSummary).toBeNull();
  });
});
