import { describe, expect, it, vi } from "vitest";
import { runChatAgentLoop } from "../apps/chrome-extension/src/entrypoints/sidepanel/chat-agent-loop.js";

function createController() {
  return {
    addMessage: vi.fn(),
    buildRequestMessages: vi.fn(() => [{ role: "user", content: "hi" }]),
    finishStreamingMessage: vi.fn(),
    removeMessage: vi.fn(),
    replaceMessage: vi.fn(),
    updateStreamingMessage: vi.fn(),
  };
}

describe("sidepanel chat agent loop", () => {
  it("streams assistant content and stops when no tool calls remain", async () => {
    const controller = createController();
    const chatSession = {
      isAbortRequested: vi.fn(() => false),
      requestAgent: vi.fn(async (_messages, _tools, _summary, opts) => {
        opts?.onChunk?.("Hello");
        return {
          ok: true,
          assistant: {
            role: "assistant",
            content: [{ type: "text", text: "Hello" }],
          },
        };
      }),
    };

    await runChatAgentLoop({
      automationEnabled: true,
      summaryMarkdown: "summary",
      chatController: controller as never,
      chatSession,
      createStreamingAssistantMessage: () =>
        ({ id: "stream", role: "assistant", content: [] }) as never,
      executeToolCall: vi.fn(),
      getAutomationToolNames: () => ["debugger", "navigate"],
      hasDebuggerPermission: async () => false,
      markAgentNavigationIntent: vi.fn(),
      markAgentNavigationResult: vi.fn(),
      scrollToBottom: vi.fn(),
      wrapMessage: vi.fn((message) => ({ ...message, id: "wrapped" }) as never),
    });

    expect(chatSession.requestAgent).toHaveBeenCalledWith(
      [{ role: "user", content: "hi" }],
      ["navigate"],
      "summary",
      expect.objectContaining({ onChunk: expect.any(Function) }),
    );
    expect(controller.updateStreamingMessage).toHaveBeenCalledWith("Hello");
    expect(controller.replaceMessage).toHaveBeenCalled();
    expect(controller.finishStreamingMessage).toHaveBeenCalled();
  });

  it("executes tool calls and appends tool results", async () => {
    const controller = createController();
    const toolCall = {
      type: "toolCall",
      toolCallId: "1",
      name: "navigate",
      arguments: { url: "https://example.com" },
    };
    const requestAgent = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        assistant: { role: "assistant", content: [toolCall] },
      })
      .mockResolvedValueOnce({
        ok: true,
        assistant: { role: "assistant", content: [{ type: "text", text: "done" }] },
      });
    const executeToolCall = vi.fn(async () => ({
      role: "toolResult",
      toolName: "navigate",
      isError: false,
      details: { ok: true },
      content: [{ type: "text", text: "navigated" }],
    }));
    const markIntent = vi.fn();
    const markResult = vi.fn();
    const wrapMessage = vi.fn((message) => ({ ...message, id: "tool-message" }) as never);

    await runChatAgentLoop({
      automationEnabled: true,
      summaryMarkdown: null,
      chatController: controller as never,
      chatSession: { isAbortRequested: vi.fn(() => false), requestAgent },
      createStreamingAssistantMessage: () =>
        ({ id: crypto.randomUUID(), role: "assistant", content: [] }) as never,
      executeToolCall,
      getAutomationToolNames: () => ["navigate"],
      hasDebuggerPermission: async () => true,
      markAgentNavigationIntent: markIntent,
      markAgentNavigationResult: markResult,
      scrollToBottom: vi.fn(),
      wrapMessage,
    });

    expect(executeToolCall).toHaveBeenCalledWith(toolCall);
    expect(markIntent).toHaveBeenCalledWith("https://example.com");
    expect(markResult).toHaveBeenCalledWith({ ok: true });
    expect(wrapMessage).toHaveBeenCalled();
    expect(controller.addMessage).toHaveBeenCalledWith(
      expect.objectContaining({ id: "tool-message" }),
    );
  });

  it("removes the placeholder message on request failure", async () => {
    const controller = createController();
    const chatSession = {
      isAbortRequested: vi.fn(() => false),
      requestAgent: vi.fn(async () => {
        throw new Error("boom");
      }),
    };

    await expect(
      runChatAgentLoop({
        automationEnabled: false,
        summaryMarkdown: null,
        chatController: controller as never,
        chatSession,
        createStreamingAssistantMessage: () =>
          ({ id: "stream", role: "assistant", content: [] }) as never,
        executeToolCall: vi.fn(),
        getAutomationToolNames: () => [],
        hasDebuggerPermission: async () => true,
        markAgentNavigationIntent: vi.fn(),
        markAgentNavigationResult: vi.fn(),
        scrollToBottom: vi.fn(),
        wrapMessage: vi.fn((message) => ({ ...message, id: "wrapped" }) as never),
      }),
    ).rejects.toThrow("boom");

    expect(controller.removeMessage).toHaveBeenCalledWith("stream");
  });
});
