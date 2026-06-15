// @vitest-environment happy-dom

import type { Message } from "@earendil-works/pi-ai";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createSidepanelChatRuntime } from "../apps/chrome-extension/src/entrypoints/sidepanel/chat-runtime";
import {
  createInitialPanelState,
  createPanelStateStore,
} from "../apps/chrome-extension/src/entrypoints/sidepanel/panel-state-store";

const agentLoopMock = vi.hoisted(() => ({
  options: null as Record<string, unknown> | null,
  run: vi.fn(async (options: Record<string, unknown>) => {
    agentLoopMock.options = options;
  }),
}));

vi.mock("../apps/chrome-extension/src/entrypoints/sidepanel/chat-agent-loop", () => ({
  runChatAgentLoop: agentLoopMock.run,
}));

vi.mock("../apps/chrome-extension/src/automation/tools", () => ({
  executeToolCall: vi.fn(),
  getAutomationToolNames: vi.fn(() => []),
}));

class MockResizeObserver {
  observe() {}
  disconnect() {}
}

function setScrollMetrics(element: HTMLElement) {
  Object.defineProperties(element, {
    scrollHeight: { configurable: true, value: 500 },
    clientHeight: { configurable: true, value: 100 },
    scrollTop: { configurable: true, writable: true, value: 400 },
  });
}

function createHarness(options: { chatEnabled?: boolean } = {}) {
  const store = createPanelStateStore(createInitialPanelState());
  store.state.panelSession.chatEnabled = options.chatEnabled ?? true;
  store.state.panelSession.automationEnabled = true;
  store.state.panelSession.daemonFeaturesAvailable = true;
  store.state.navigation.activeTabId = 7;
  store.state.navigation.activeTabUrl = "https://example.com/current";
  store.state.summaryMarkdown = "Current summary";

  const mainEl = document.createElement("main");
  setScrollMetrics(mainEl);
  const renderEl = document.createElement("div");
  const chatContainerEl = document.createElement("section");
  const chatContextStatusEl = document.createElement("div");
  const chatDockEl = document.createElement("div");
  chatDockEl.getBoundingClientRect = () => ({ height: 48 }) as DOMRect;
  const chatInputEl = document.createElement("textarea");
  const chatJumpBtn = document.createElement("button");
  const chatMessagesEl = document.createElement("div");
  const chatQueueEl = document.createElement("div");
  const chatSendBtn = document.createElement("button");
  const automationNoticeActionBtn = document.createElement("button");
  const automationNoticeEl = document.createElement("div");
  const automationNoticeMessageEl = document.createElement("div");
  const automationNoticeTitleEl = document.createElement("div");
  document.body.append(
    mainEl,
    renderEl,
    chatContainerEl,
    chatContextStatusEl,
    chatDockEl,
    chatInputEl,
    chatJumpBtn,
    chatMessagesEl,
    chatQueueEl,
    chatSendBtn,
    automationNoticeEl,
  );

  const storageValues = new Map<string, unknown>();
  const storage = {
    get: vi.fn(async (key: string) => ({ [key]: storageValues.get(key) })),
    remove: vi.fn(async (key: string) => {
      storageValues.delete(key);
    }),
    set: vi.fn(async (values: Record<string, unknown>) => {
      for (const [key, value] of Object.entries(values)) storageValues.set(key, value);
    }),
  };
  let runtimeMessageListener:
    | ((
        raw: unknown,
        sender: unknown,
        sendResponse?: (response: unknown) => void,
      ) => boolean | void)
    | null = null;
  vi.stubGlobal("chrome", {
    permissions: { contains: vi.fn(async () => true) },
    runtime: {
      id: "extension-id",
      onMessage: {
        addListener: vi.fn((listener) => {
          runtimeMessageListener = listener;
        }),
      },
      openOptionsPage: vi.fn(async () => {}),
    },
    storage: { session: storage },
    tabs: {
      create: vi.fn(async () => {}),
      sendMessage: vi.fn(async () => {}),
    },
  });

  const send = vi.fn(async () => {});
  const setStatus = vi.fn();
  const clearErrors = vi.fn();
  const showInlineError = vi.fn();
  const clearChatMetrics = vi.fn();
  const setChatMetricsMode = vi.fn();
  const setLastActionChat = vi.fn();
  const renderInlineSlides = vi.fn();
  const seekToTimestamp = vi.fn();
  const navigationRuntime = {
    markAgentNavigationIntent: vi.fn(),
    markAgentNavigationResult: vi.fn(),
  };
  const runtime = createSidepanelChatRuntime({
    panelState: store.state,
    dispatchPanelState: store.dispatch,
    markdown: { render: (value: string) => value } as never,
    mainEl,
    renderEl,
    chatContainerEl,
    chatContextStatusEl,
    chatDockEl,
    chatInputEl,
    chatJumpBtn,
    chatMessagesEl,
    chatQueueEl,
    chatSendBtn,
    automationNoticeActionBtn,
    automationNoticeEl,
    automationNoticeMessageEl,
    automationNoticeTitleEl,
    getActiveTabId: () => store.state.navigation.activeTabId,
    getActiveTabUrl: () => store.state.navigation.activeTabUrl,
    navigationRuntime,
    send,
    setStatus,
    clearErrors,
    showInlineError,
    clearChatMetrics,
    setChatMetricsMode,
    setLastActionChat,
    renderInlineSlides,
    seekToTimestamp,
  });

  return {
    chatContainerEl,
    chatMessagesEl,
    chatQueueEl,
    clearChatMetrics,
    clearErrors,
    navigationRuntime,
    renderInlineSlides,
    runtime,
    runtimeMessageListener: () => runtimeMessageListener,
    seekToTimestamp,
    send,
    setChatMetricsMode,
    setLastActionChat,
    setStatus,
    showInlineError,
    storage,
    storageValues,
    store,
  };
}

describe("sidepanel chat runtime", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
    document.documentElement.style.removeProperty("--chat-dock-height");
    agentLoopMock.options = null;
    vi.clearAllMocks();
    vi.stubGlobal("ResizeObserver", MockResizeObserver);
  });

  it("owns chat start, streaming completion, and agent-loop wiring", async () => {
    const harness = createHarness();

    harness.runtime.startMessage("  hello  ");

    await vi.waitFor(() => expect(agentLoopMock.run).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(harness.store.state.chat.streaming).toBe(false));

    expect(harness.store.state.chat.messages).toMatchObject([{ role: "user", content: "hello" }]);
    expect(harness.clearErrors).toHaveBeenCalledOnce();
    expect(harness.setChatMetricsMode).toHaveBeenCalledOnce();
    expect(harness.setLastActionChat).toHaveBeenCalledOnce();
    expect(harness.renderInlineSlides).toHaveBeenCalled();
    expect(agentLoopMock.options).toMatchObject({
      automationEnabled: true,
      summaryMarkdown: "Current summary",
      markAgentNavigationIntent: harness.navigationRuntime.markAgentNavigationIntent,
      markAgentNavigationResult: harness.navigationRuntime.markAgentNavigationResult,
    });

    harness.runtime.retry();
    await vi.waitFor(() => expect(agentLoopMock.run).toHaveBeenCalledTimes(2));
  });

  it("queues normalized messages while streaming and drains them afterward", async () => {
    const harness = createHarness();
    harness.store.dispatch({ type: "chat-streaming", value: true });

    expect(harness.runtime.enqueueMessage("  queued \n message  ")).toBe(true);
    harness.runtime.maybeSendQueuedMessage();
    expect(harness.runtime.getQueueLength()).toBe(1);
    expect(harness.store.state.chat.queue).toMatchObject([{ text: "queued message" }]);

    harness.store.dispatch({ type: "chat-streaming", value: false });
    harness.runtime.maybeSendQueuedMessage();

    await vi.waitFor(() => expect(harness.runtime.getQueueLength()).toBe(0));
    expect(harness.store.state.chat.queue).toEqual([]);
    await vi.waitFor(() => expect(harness.store.state.chat.streaming).toBe(false));
    expect(harness.store.state.chat.messages).toMatchObject([
      { role: "user", content: "queued message" },
    ]);
    expect(harness.chatQueueEl.classList.contains("isHidden")).toBe(true);
  });

  it("restores daemon history through background message handlers", async () => {
    const harness = createHarness();
    const restore = harness.runtime.restoreHistory();

    await vi.waitFor(() =>
      expect(harness.send).toHaveBeenCalledWith(
        expect.objectContaining({ type: "panel:chat-history" }),
      ),
    );
    const request = harness.send.mock.calls.find(
      ([message]) => message.type === "panel:chat-history",
    )?.[0] as { requestId: string };
    harness.runtime.handleHistory({
      type: "chat:history",
      requestId: request.requestId,
      ok: true,
      messages: [{ role: "user", content: "restored", timestamp: 1 }],
    });
    await restore;

    expect(harness.store.state.chat.messages).toMatchObject([
      { role: "user", content: "restored" },
    ]);
    expect(harness.storage.set).toHaveBeenCalled();
  });

  it("forwards agent chunks and responses to the active request", async () => {
    const harness = createHarness();
    harness.runtime.startMessage("start");
    await vi.waitFor(() => expect(agentLoopMock.options).not.toBeNull());
    const chatSession = agentLoopMock.options?.chatSession as {
      requestAgent: (
        messages: Message[],
        tools: string[],
        summary: string | null,
        options: { onChunk: (text: string) => void },
      ) => Promise<{ ok: boolean }>;
    };
    const onChunk = vi.fn();
    const pending = chatSession.requestAgent([], [], null, { onChunk });

    await vi.waitFor(() =>
      expect(harness.send).toHaveBeenCalledWith(expect.objectContaining({ type: "panel:agent" })),
    );
    const request = harness.send.mock.calls.find(
      ([message]) => message.type === "panel:agent",
    )?.[0] as {
      requestId: string;
    };
    harness.runtime.handleAgentChunk({
      type: "agent:chunk",
      requestId: request.requestId,
      text: "partial",
    });
    harness.runtime.handleAgentResponse({
      type: "agent:response",
      requestId: request.requestId,
      ok: true,
    });

    await expect(pending).resolves.toEqual({ ok: true, assistant: undefined, error: undefined });
    expect(onChunk).toHaveBeenCalledWith("partial");
  });

  it("migrates non-empty history to the destination tab URL", async () => {
    const harness = createHarness();
    harness.store.dispatch({
      type: "chat-message-add",
      message: { id: "1", role: "user", content: "keep", timestamp: 1 },
    });

    await harness.runtime.migrateHistory(7, 8, "https://example.com/next");

    expect(harness.storage.set).toHaveBeenCalledWith({
      "chat:tab:8:https://example.com/next": [
        { id: "1", role: "user", content: "keep", timestamp: 1 },
      ],
    });
  });

  it("owns timestamp seeking, disabled-state reset, and abort handling", async () => {
    const harness = createHarness();
    harness.chatMessagesEl.click();
    const invalidLink = document.createElement("a");
    invalidLink.className = "chatTimestamp";
    invalidLink.href = "timestamp:not-a-time";
    harness.chatMessagesEl.append(invalidLink);
    const invalidClick = new MouseEvent("click", { bubbles: true, cancelable: true });
    invalidLink.dispatchEvent(invalidClick);
    expect(invalidClick.defaultPrevented).toBe(true);
    expect(harness.seekToTimestamp).not.toHaveBeenCalled();

    const link = document.createElement("a");
    link.className = "chatTimestamp";
    link.href = "timestamp:42";
    harness.chatMessagesEl.append(link);

    link.click();
    expect(harness.seekToTimestamp).toHaveBeenCalledWith(42);

    harness.runtime.startMessage("temporary");
    await vi.waitFor(() => expect(harness.store.state.chat.messages.length).toBe(1));
    harness.store.state.panelSession.chatEnabled = false;
    harness.runtime.applyEnabled();
    expect(harness.store.state.chat.messages).toEqual([]);
    expect(harness.chatContainerEl.hasAttribute("hidden")).toBe(true);
    expect(harness.clearChatMetrics).toHaveBeenCalledOnce();

    harness.runtime.requestAbort("Stopped");
    expect(harness.setStatus).toHaveBeenCalledWith("Stopped");
    const sendResponse = vi.fn();
    expect(
      harness.runtimeMessageListener()?.({ type: "automation:abort-agent" }, {}, sendResponse),
    ).toBe(true);
    expect(harness.setStatus).toHaveBeenCalledWith("Agent aborted");
    expect(sendResponse).toHaveBeenCalledWith({ ok: true });
  });

  it("skips history migration without distinct tabs or messages", async () => {
    const harness = createHarness();

    await harness.runtime.migrateHistory(null, 8, "https://example.com/next");
    await harness.runtime.migrateHistory(7, null, "https://example.com/next");
    await harness.runtime.migrateHistory(7, 7, "https://example.com/next");
    await harness.runtime.migrateHistory(7, 8, "https://example.com/next");

    expect(harness.storage.set).not.toHaveBeenCalled();
  });
});
