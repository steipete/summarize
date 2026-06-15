// @vitest-environment happy-dom
import type { Message } from "@earendil-works/pi-ai";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createAutomationRuntime } from "../apps/chrome-extension/src/entrypoints/sidepanel/automation-runtime";
import { createInitialPanelState } from "../apps/chrome-extension/src/entrypoints/sidepanel/panel-state-store";

let capturedAgentLoopOptions: Record<string, unknown> | null = null;
const automationMocks = vi.hoisted(() => ({
  executeToolCall: vi.fn(async () => ({
    role: "toolResult",
    toolCallId: "tool-1",
    toolName: "navigate",
    content: [{ type: "text", text: "done" }],
    isError: false,
    timestamp: 1,
  })),
}));

vi.mock("../apps/chrome-extension/src/entrypoints/sidepanel/chat-agent-loop", () => ({
  runChatAgentLoop: vi.fn(async (options) => {
    capturedAgentLoopOptions = options;
  }),
}));

vi.mock("../apps/chrome-extension/src/automation/tools", () => ({
  executeToolCall: automationMocks.executeToolCall,
  getAutomationToolNames: vi.fn(() => ["navigate", "debugger"]),
}));

function createHarness(
  options: { activeTabId?: number | null; daemonFeaturesAvailable?: boolean } = {},
) {
  const panelState = createInitialPanelState();
  panelState.panelSession.automationEnabled = true;
  panelState.panelSession.daemonFeaturesAvailable = options.daemonFeaturesAvailable ?? true;
  panelState.summaryMarkdown = "Summary";
  const automationNoticeActionBtn = document.createElement("button");
  const automationNoticeEl = document.createElement("div");
  automationNoticeEl.className = "hidden";
  const automationNoticeMessageEl = document.createElement("div");
  const automationNoticeTitleEl = document.createElement("div");
  let permissionListener: EventListener | null = null;
  let runtimeListener:
    | ((
        raw: unknown,
        sender: unknown,
        sendResponse?: (response: unknown) => void,
      ) => boolean | void)
    | null = null;
  const chatSession = {
    isAbortRequested: vi.fn(() => false),
    requestAbort: vi.fn(),
    requestAgent: vi.fn(async () => ({ ok: false, error: "unused" })),
  };
  const navigationRuntime = {
    markAgentNavigationIntent: vi.fn(),
    markAgentNavigationResult: vi.fn(),
  };
  const chatController = {
    addMessage: vi.fn(),
    buildRequestMessages: vi.fn(() => []),
    finishStreamingMessage: vi.fn(),
    removeMessage: vi.fn(),
    replaceMessage: vi.fn(),
    updateStreamingMessage: vi.fn(),
  };
  const runtime = createAutomationRuntime({
    panelState,
    automationNoticeActionBtn,
    automationNoticeEl,
    automationNoticeMessageEl,
    automationNoticeTitleEl,
    chatController,
    getActiveTabId: () => options.activeTabId ?? null,
    getChatSession: () => chatSession,
    navigationRuntime,
    scrollToBottom: vi.fn(),
    wrapMessage: (message: Message) => ({ ...message, id: "wrapped" }),
    eventTarget: {
      addEventListener: (_type, listener) => {
        permissionListener = listener;
      },
    },
    addRuntimeMessageListener: (listener) => {
      runtimeListener = listener;
    },
  });
  return {
    automationNoticeActionBtn,
    automationNoticeEl,
    automationNoticeMessageEl,
    automationNoticeTitleEl,
    chatController,
    chatSession,
    navigationRuntime,
    panelState,
    permissionListener: () => permissionListener,
    runtime,
    runtimeListener: () => runtimeListener,
  };
}

describe("automation runtime", () => {
  const openOptionsPage = vi.fn(async () => {});
  const createTab = vi.fn(async () => {});
  const sendMessage = vi.fn(async () => {});
  const containsPermission = vi.fn(async () => true);

  beforeEach(() => {
    capturedAgentLoopOptions = null;
    vi.clearAllMocks();
    vi.stubGlobal("chrome", {
      permissions: { contains: containsPermission },
      runtime: {
        id: "extension-id",
        openOptionsPage,
        onMessage: { addListener: vi.fn() },
      },
      tabs: {
        create: createTab,
        sendMessage,
      },
    });
  });

  it("shows sticky permission guidance and opens extension details", () => {
    const harness = createHarness();
    const listener = harness.permissionListener();

    listener?.(
      new CustomEvent("summarize:automation-permissions", {
        detail: { message: "Grant debugger access" },
      }),
    );

    expect(harness.automationNoticeTitleEl.textContent).toBe("Automation permission required");
    expect(harness.automationNoticeMessageEl.textContent).toBe("Grant debugger access");
    expect(harness.automationNoticeActionBtn.textContent).toBe("Open extension details");
    expect(harness.automationNoticeEl.classList.contains("hidden")).toBe(false);
    expect(harness.panelState.panelSession.automationNoticeSticky).toBe(true);

    harness.runtime.hideNotice();
    expect(harness.automationNoticeEl.classList.contains("hidden")).toBe(false);
    harness.runtime.hideNotice({ force: true });
    expect(harness.automationNoticeEl.classList.contains("hidden")).toBe(true);

    harness.automationNoticeActionBtn.click();
    expect(createTab).toHaveBeenCalledWith({
      url: "chrome://extensions/?id=extension-id",
    });
  });

  it("supports custom options guidance and ignores empty permission events", () => {
    const harness = createHarness();
    const listener = harness.permissionListener();

    listener?.(
      new CustomEvent("summarize:automation-permissions", {
        detail: {},
      }),
    );
    expect(harness.automationNoticeEl.classList.contains("hidden")).toBe(true);

    listener?.(
      new CustomEvent("summarize:automation-permissions", {
        detail: {
          title: "Custom",
          message: "Open settings",
          ctaLabel: "Settings",
          ctaAction: "options",
        },
      }),
    );
    harness.automationNoticeActionBtn.click();

    expect(harness.automationNoticeTitleEl.textContent).toBe("Custom");
    expect(harness.automationNoticeActionBtn.textContent).toBe("Settings");
    expect(openOptionsPage).toHaveBeenCalledOnce();
    expect(createTab).not.toHaveBeenCalled();
  });

  it("handles only automation abort runtime messages", () => {
    const harness = createHarness();
    const sendResponse = vi.fn();
    const listener = harness.runtimeListener();

    expect(listener?.(null, {}, sendResponse)).toBeUndefined();
    expect(listener?.({ type: "other" }, {}, sendResponse)).toBeUndefined();
    expect(listener?.({ type: "automation:abort-agent" }, {}, sendResponse)).toBe(true);

    expect(harness.chatSession.requestAbort).toHaveBeenCalledWith("Agent aborted");
    expect(sendResponse).toHaveBeenCalledWith({ ok: true });
  });

  it("hides the REPL overlay only for an active tab and ignores send failures", async () => {
    const absent = createHarness();
    await absent.runtime.hideReplOverlayForActiveTab();
    expect(sendMessage).not.toHaveBeenCalled();

    const active = createHarness({ activeTabId: 9 });
    await active.runtime.hideReplOverlayForActiveTab();
    expect(sendMessage).toHaveBeenCalledWith(9, {
      type: "automation:repl-overlay",
      action: "hide",
      message: null,
    });

    sendMessage.mockRejectedValueOnce(new Error("missing receiver"));
    await expect(active.runtime.hideReplOverlayForActiveTab()).resolves.toBeUndefined();
  });

  it("wires canonical state and browser capabilities into the agent loop", async () => {
    const harness = createHarness();

    await harness.runtime.runAgentLoop();

    expect(capturedAgentLoopOptions).toMatchObject({
      automationEnabled: true,
      summaryMarkdown: "Summary",
      chatController: harness.chatController,
      chatSession: harness.chatSession,
      markAgentNavigationIntent: harness.navigationRuntime.markAgentNavigationIntent,
      markAgentNavigationResult: harness.navigationRuntime.markAgentNavigationResult,
    });
    const options = capturedAgentLoopOptions as {
      createStreamingAssistantMessage: () => { role: string; model: string };
      executeToolCall: (call: unknown) => Promise<unknown>;
      getAutomationToolNames: () => string[];
      hasDebuggerPermission: () => Promise<boolean>;
    };
    expect(options.createStreamingAssistantMessage()).toMatchObject({
      role: "assistant",
      model: "streaming",
    });
    expect(options.getAutomationToolNames()).toEqual(["navigate", "debugger"]);
    await expect(options.hasDebuggerPermission()).resolves.toBe(true);
    await options.executeToolCall({ name: "navigate" });
    expect(automationMocks.executeToolCall).toHaveBeenCalledOnce();
  });

  it("disables automation tools when daemon features are unavailable", async () => {
    const harness = createHarness({ daemonFeaturesAvailable: false });

    await harness.runtime.runAgentLoop();

    expect(capturedAgentLoopOptions).toMatchObject({ automationEnabled: false });
  });
});
