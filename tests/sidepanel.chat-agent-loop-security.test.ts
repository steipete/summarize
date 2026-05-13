import { describe, expect, it, vi } from "vitest";
import { runChatAgentLoop } from "../apps/chrome-extension/src/entrypoints/sidepanel/chat-agent-loop.js";

function buildHarness({
  confirmToolCall,
  toolCall = {
    type: "toolCall",
    id: "call-1",
    name: "debugger",
    arguments: { action: "eval", expression: "document.body.innerText" },
  },
}: {
  confirmToolCall?: () => Promise<boolean> | boolean;
  toolCall?: {
    type: "toolCall";
    id: string;
    name: string;
    arguments: Record<string, unknown>;
  };
} = {}) {
  const executeToolCall = vi.fn(async (call) => ({
    role: "toolResult" as const,
    toolCallId: call.id,
    toolName: call.name,
    content: [{ type: "text" as const, text: "executed" }],
    isError: false,
    timestamp: Date.now(),
  }));

  const chatController = {
    addMessage: vi.fn(),
    buildRequestMessages: vi.fn(() => [
      {
        role: "user",
        content: "Summarize this page with attacker-controlled content.",
        timestamp: Date.now(),
      },
    ]),
    finishStreamingMessage: vi.fn(),
    removeMessage: vi.fn(),
    replaceMessage: vi.fn(),
    updateStreamingMessage: vi.fn(),
  };

  let calls = 0;
  const chatSession = {
    isAbortRequested: () => false,
    requestAgent: vi.fn(async () => {
      calls += 1;
      if (calls === 1) {
        return {
          ok: true,
          assistant: {
            role: "assistant",
            content: [toolCall],
            timestamp: Date.now(),
          },
        };
      }
      return {
        ok: true,
        assistant: { role: "assistant", content: "done", timestamp: Date.now() },
      };
    }),
  };

  return {
    executeToolCall,
    chatController,
    chatSession,
    args: {
      automationEnabled: true,
      summaryMarkdown: "Attacker-controlled page content can be included here.",
      chatController,
      chatSession,
      createStreamingAssistantMessage: () => ({
        id: "streaming",
        role: "assistant" as const,
        content: "",
        timestamp: Date.now(),
      }),
      executeToolCall,
      getAutomationToolNames: () => [toolCall.name],
      hasDebuggerPermission: async () => true,
      markAgentNavigationIntent: vi.fn(),
      markAgentNavigationResult: vi.fn(),
      scrollToBottom: vi.fn(),
      wrapMessage: (message: unknown) => ({ id: "wrapped", ...(message as object) }),
      confirmToolCall,
    },
  };
}

describe("chat agent automation tool confirmation", () => {
  it("does not execute a dangerous tool call when confirmation is denied", async () => {
    const confirmToolCall = vi.fn(async () => false);
    const harness = buildHarness({ confirmToolCall });

    await runChatAgentLoop(harness.args as never);

    expect(confirmToolCall).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "debugger",
        arguments: { action: "eval", expression: "document.body.innerText" },
      }),
    );
    expect(harness.executeToolCall).not.toHaveBeenCalled();
    expect(harness.chatController.addMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        role: "toolResult",
        toolName: "debugger",
        isError: true,
      }),
    );
  });

  it("does not mark navigation intent before a denied navigate call", async () => {
    const confirmToolCall = vi.fn(async () => false);
    const harness = buildHarness({
      confirmToolCall,
      toolCall: {
        type: "toolCall",
        id: "call-1",
        name: "navigate",
        arguments: { url: "https://example.com/phishing" },
      },
    });

    await runChatAgentLoop(harness.args as never);

    expect(harness.args.markAgentNavigationIntent).not.toHaveBeenCalled();
    expect(harness.args.markAgentNavigationResult).not.toHaveBeenCalled();
    expect(harness.executeToolCall).not.toHaveBeenCalled();
  });
});
