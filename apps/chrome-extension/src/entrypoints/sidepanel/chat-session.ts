import type { MessageDescriptor } from "@steipete/summarize-core/localization";
import type {
  AgentAssistantMessage as AssistantMessage,
  AgentMessage as Message,
} from "@steipete/summarize-core/runtime";
import { LocalizedError, message } from "../../lib/i18n";

export type AgentResponse = {
  ok: boolean;
  assistant?: AssistantMessage;
  error?: string;
  localized?: MessageDescriptor;
};
export type ChatHistoryResponse = {
  ok: boolean;
  messages?: Message[];
  error?: string;
  localized?: MessageDescriptor;
};

type PendingAgentRequest = {
  resolve: (response: AgentResponse) => void;
  reject: (error: Error) => void;
  onChunk?: (text: string) => void;
};

type PendingChatHistoryRequest = {
  resolve: (response: ChatHistoryResponse) => void;
  reject: (error: Error) => void;
};

export function createChatSession({
  send,
  setStatus,
  hideReplOverlay,
  agentTimeoutMs = 60_000,
  historyTimeoutMs = 20_000,
}: {
  send: (
    message:
      | {
          type: "panel:agent";
          requestId: string;
          messages: Message[];
          tools: string[];
          summary?: string | null;
        }
      | {
          type: "panel:chat-history";
          requestId: string;
          summary?: string | null;
        },
  ) => Promise<void>;
  setStatus?: ((text: string) => void) | null;
  hideReplOverlay?: (() => Promise<void>) | null;
  agentTimeoutMs?: number;
  historyTimeoutMs?: number;
}) {
  const pendingAgentRequests = new Map<string, PendingAgentRequest>();
  const pendingChatHistoryRequests = new Map<string, PendingChatHistoryRequest>();
  let abortRequested = false;

  const abortPendingAgentRequests = (reason: string) => {
    for (const pending of pendingAgentRequests.values()) {
      pending.reject(new Error(reason));
    }
    pendingAgentRequests.clear();
  };

  return {
    isAbortRequested() {
      return abortRequested;
    },
    reset() {
      abortRequested = false;
      pendingAgentRequests.clear();
      pendingChatHistoryRequests.clear();
    },
    resetAbort() {
      abortRequested = false;
    },
    requestAbort(reason: string) {
      abortRequested = true;
      abortPendingAgentRequests(reason);
      setStatus?.(reason);
      void hideReplOverlay?.();
    },
    handleAgentResponse(msg: {
      requestId: string;
      ok: boolean;
      assistant?: AssistantMessage;
      error?: string;
      localized?: MessageDescriptor;
    }) {
      const pending = pendingAgentRequests.get(msg.requestId);
      if (!pending) return;
      pendingAgentRequests.delete(msg.requestId);
      pending.resolve({
        ok: msg.ok,
        assistant: msg.assistant,
        error: msg.error,
        ...(msg.localized ? { localized: msg.localized } : {}),
      });
    },
    handleAgentChunk(msg: { requestId: string; text: string }) {
      const pending = pendingAgentRequests.get(msg.requestId);
      if (!pending?.onChunk) return;
      pending.onChunk(msg.text);
    },
    handleChatHistoryResponse(msg: {
      requestId: string;
      ok: boolean;
      messages?: Message[];
      error?: string;
      localized?: MessageDescriptor;
    }) {
      const pending = pendingChatHistoryRequests.get(msg.requestId);
      if (!pending) return;
      pendingChatHistoryRequests.delete(msg.requestId);
      pending.resolve({
        ok: msg.ok,
        messages: msg.messages,
        error: msg.error,
        ...(msg.localized ? { localized: msg.localized } : {}),
      });
    },
    requestAgent(
      messages: Message[],
      tools: string[],
      summary?: string | null,
      opts?: { onChunk?: (text: string) => void },
    ) {
      const requestId = crypto.randomUUID();
      return new Promise<AgentResponse>((resolve, reject) => {
        const timeout = globalThis.setTimeout(() => {
          pendingAgentRequests.delete(requestId);
          reject(new LocalizedError(message("error.agentTimeout")));
        }, agentTimeoutMs);
        pendingAgentRequests.set(requestId, {
          resolve: (result) => {
            globalThis.clearTimeout(timeout);
            resolve(result);
          },
          reject: (error) => {
            globalThis.clearTimeout(timeout);
            reject(error);
          },
          onChunk: opts?.onChunk,
        });
        void send({ type: "panel:agent", requestId, messages, tools, summary });
      });
    },
    requestChatHistory(summary?: string | null) {
      const requestId = crypto.randomUUID();
      return new Promise<ChatHistoryResponse>((resolve, reject) => {
        const timeout = globalThis.setTimeout(() => {
          pendingChatHistoryRequests.delete(requestId);
          reject(new LocalizedError(message("error.chatHistoryTimeout")));
        }, historyTimeoutMs);
        pendingChatHistoryRequests.set(requestId, {
          resolve: (result) => {
            globalThis.clearTimeout(timeout);
            resolve(result);
          },
          reject: (error) => {
            globalThis.clearTimeout(timeout);
            reject(error);
          },
        });
        void send({ type: "panel:chat-history", requestId, summary });
      });
    },
  };
}
