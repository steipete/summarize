import type { Message, ToolCall, ToolResultMessage } from "@mariozechner/pi-ai";
import type { ChatController } from "./chat-controller";
import type { ChatMessage } from "./types";

export async function runChatAgentLoop({
  automationEnabled,
  summaryMarkdown,
  chatController,
  chatSession,
  createStreamingAssistantMessage,
  executeToolCall,
  getAutomationToolNames,
  hasDebuggerPermission,
  markAgentNavigationIntent,
  markAgentNavigationResult,
  scrollToBottom,
  wrapMessage,
}: {
  automationEnabled: boolean;
  summaryMarkdown: string | null;
  chatController: Pick<
    ChatController,
    | "addMessage"
    | "buildRequestMessages"
    | "finishStreamingMessage"
    | "removeMessage"
    | "replaceMessage"
    | "updateStreamingMessage"
  >;
  chatSession: {
    isAbortRequested: () => boolean;
    requestAgent: (
      messages: Message[],
      tools: string[],
      summary?: string | null,
      opts?: { onChunk?: (text: string) => void },
    ) => Promise<{ ok: boolean; assistant?: Message; error?: string }>;
  };
  createStreamingAssistantMessage: () => ChatMessage;
  executeToolCall: (call: ToolCall) => Promise<ToolResultMessage>;
  getAutomationToolNames: () => string[];
  hasDebuggerPermission: () => Promise<boolean>;
  markAgentNavigationIntent: (url: string | null | undefined) => void;
  markAgentNavigationResult: (details: unknown) => void;
  scrollToBottom: (force?: boolean) => void;
  wrapMessage: (message: Message) => ChatMessage;
}) {
  let tools = automationEnabled ? getAutomationToolNames() : [];
  if (tools.includes("debugger")) {
    const hasDebugger = await hasDebuggerPermission();
    if (!hasDebugger) {
      tools = tools.filter((tool) => tool !== "debugger");
    }
  }

  while (true) {
    if (chatSession.isAbortRequested()) return;
    const messages = chatController.buildRequestMessages() as Message[];
    const streamingMessage = createStreamingAssistantMessage();
    let streamedContent = "";
    chatController.addMessage(streamingMessage);
    scrollToBottom(true);

    let response;
    try {
      response = await chatSession.requestAgent(messages, tools, summaryMarkdown, {
        onChunk: (text) => {
          streamedContent += text;
          chatController.updateStreamingMessage(streamedContent);
        },
      });
    } catch (error) {
      chatController.removeMessage(streamingMessage.id);
      if (chatSession.isAbortRequested()) return;
      throw error;
    }

    if (!response.ok || !response.assistant) {
      chatController.removeMessage(streamingMessage.id);
      throw new Error(response.error || "Agent failed");
    }

    const assistant = { ...response.assistant, id: streamingMessage.id } as ChatMessage;
    if (chatSession.isAbortRequested()) {
      chatController.removeMessage(streamingMessage.id);
      return;
    }
    chatController.replaceMessage(assistant);
    chatController.finishStreamingMessage();
    scrollToBottom(true);

    const toolCalls = assistant.content.filter((part) => part.type === "toolCall") as ToolCall[];
    if (toolCalls.length === 0) break;

    for (const call of toolCalls) {
      if (chatSession.isAbortRequested()) return;
      if (call.name === "navigate") {
        const args = call.arguments as { url?: string };
        markAgentNavigationIntent(args?.url);
      }
      const result = await executeToolCall(call);
      if (call.name === "navigate" && !result.isError) {
        markAgentNavigationResult(result.details);
      }
      chatController.addMessage(wrapMessage(result));
      scrollToBottom(true);
    }
  }
}
