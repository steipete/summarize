import { compactChatHistory, type ChatHistoryLimits } from "./chat-state";
import type { ChatMessage } from "./types";

export function createChatHistoryRuntime({
  chatController,
  chatHistoryStore,
  chatLimits,
  normalizeStoredMessage,
  requestChatHistory,
  getActiveUrl,
}: {
  chatController: {
    getMessages: () => ChatMessage[];
    setMessages: (messages: ChatMessage[], opts?: { scroll?: boolean }) => void;
  };
  chatHistoryStore: {
    clear: (tabId: number | null, url?: string | null) => Promise<void>;
    load: (tabId: number, url?: string | null) => Promise<ChatMessage[] | null>;
    persist: (
      tabId: number | null,
      messages: ChatMessage[],
      chatEnabled: boolean,
      url?: string | null,
    ) => Promise<ChatMessage[]>;
  };
  chatLimits: ChatHistoryLimits;
  normalizeStoredMessage: (raw: Record<string, unknown>) => ChatMessage | null;
  requestChatHistory: (
    summary?: string | null,
  ) => Promise<{ ok: boolean; messages?: unknown[]; error?: string }>;
  getActiveUrl: () => string | null;
}) {
  let loadId = 0;

  return {
    clear(tabId: number | null) {
      return chatHistoryStore.clear(tabId, getActiveUrl());
    },
    load(tabId: number) {
      return chatHistoryStore.load(tabId, getActiveUrl());
    },
    async persist(tabId: number | null, chatEnabled: boolean) {
      if (!chatEnabled || !tabId) return;
      const messages = chatController.getMessages();
      const compacted = compactChatHistory(messages, chatLimits);
      if (compacted.length !== messages.length) {
        chatController.setMessages(compacted, { scroll: false });
      }
      await chatHistoryStore.persist(tabId, compacted, chatEnabled, getActiveUrl());
    },
    async restore(tabId: number | null, summaryMarkdown?: string | null) {
      if (!tabId) return;
      loadId += 1;
      const currentLoadId = loadId;
      const history = await chatHistoryStore.load(tabId, getActiveUrl());
      if (currentLoadId !== loadId) return;
      if (history?.length) {
        const compacted = compactChatHistory(history, chatLimits);
        chatController.setMessages(compacted, { scroll: false });
        return;
      }

      try {
        const response = await requestChatHistory(summaryMarkdown);
        if (currentLoadId !== loadId || !response.ok || !Array.isArray(response.messages)) {
          return;
        }
        const parsed = response.messages
          .filter((msg) => msg && typeof msg === "object")
          .map((msg) => normalizeStoredMessage(msg as Record<string, unknown>))
          .filter((msg): msg is ChatMessage => Boolean(msg));
        if (!parsed.length) return;
        const compacted = await chatHistoryStore.persist(tabId, parsed, true, getActiveUrl());
        chatController.setMessages(compacted, { scroll: false });
      } catch {
        // ignore
      }
    },
  };
}
