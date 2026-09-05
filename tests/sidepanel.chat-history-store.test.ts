import { describe, expect, it } from "vitest";
import {
  buildEmptyUsage,
  createChatHistoryStore,
  normalizeStoredMessage,
} from "../apps/chrome-extension/src/entrypoints/sidepanel/chat-history-store.js";
import type { ChatMessage } from "../apps/chrome-extension/src/entrypoints/sidepanel/types.js";

function createMemoryStorage(): chrome.storage.StorageArea {
  const values = new Map<string, unknown>();
  return {
    get: async (keys?: string | string[] | Record<string, unknown> | null) => {
      if (typeof keys === "string") return { [keys]: values.get(keys) };
      if (Array.isArray(keys)) {
        return Object.fromEntries(keys.map((key) => [key, values.get(key)]));
      }
      return Object.fromEntries(values.entries());
    },
    set: async (items: Record<string, unknown>) => {
      for (const [key, value] of Object.entries(items)) values.set(key, value);
    },
    remove: async (keys: string | string[]) => {
      for (const key of Array.isArray(keys) ? keys : [keys]) values.delete(key);
    },
    clear: async () => values.clear(),
  } as chrome.storage.StorageArea;
}

describe("sidepanel chat history store", () => {
  it("restores partial usage with numeric defaults and preserves unknown metadata", () => {
    const message = normalizeStoredMessage({
      role: "assistant",
      content: "Saved reply",
      stopReason: "unknown-reason",
      usage: {
        input: 12,
        output: "invalid",
        totalTokens: Number.NaN,
        providerDetail: "retained",
        cost: { total: 0.25, input: null, providerDetail: "retained" },
      },
    });
    expect(message).toMatchObject({
      role: "assistant",
      content: [{ type: "text", text: "Saved reply" }],
      stopReason: "stop",
      usage: {
        ...buildEmptyUsage(),
        input: 12,
        providerDetail: "retained",
        cost: { ...buildEmptyUsage().cost, total: 0.25, providerDetail: "retained" },
      },
    });
  });

  it.each(["stop", "length", "toolUse", "error", "aborted"])(
    "preserves valid saved usage and %s stop reason",
    (stopReason) => {
      const usage = {
        ...buildEmptyUsage(),
        input: 12,
        output: 5,
        totalTokens: 17,
        cost: { ...buildEmptyUsage().cost, total: 0.2 },
      };
      expect(
        normalizeStoredMessage({ role: "assistant", content: [], usage, stopReason }),
      ).toMatchObject({ usage, stopReason });
    },
  );

  it("isolates cached history by tab and normalized URL", async () => {
    const storage = createMemoryStorage();
    const store = createChatHistoryStore({
      chatLimits: { maxMessages: 10, maxChars: 1_000 },
      getStorage: () => storage,
    });
    const pageA: ChatMessage = { id: "a", role: "user", content: "page a", timestamp: 1 };
    const pageB: ChatMessage = { id: "b", role: "user", content: "page b", timestamp: 2 };

    await store.persist(7, [pageA], true, "https://example.com/a#first");
    await store.persist(7, [pageB], true, "https://example.com/b");

    await expect(store.load(7, "https://example.com/a#second")).resolves.toEqual([pageA]);
    await expect(store.load(7, "https://example.com/b")).resolves.toEqual([pageB]);
  });

  it("clears only the current URL history for a tab", async () => {
    const storage = createMemoryStorage();
    const store = createChatHistoryStore({
      chatLimits: { maxMessages: 10, maxChars: 1_000 },
      getStorage: () => storage,
    });
    const pageA: ChatMessage = { id: "a", role: "user", content: "page a", timestamp: 1 };
    const pageB: ChatMessage = { id: "b", role: "user", content: "page b", timestamp: 2 };

    await store.persist(7, [pageA], true, "https://example.com/a");
    await store.persist(7, [pageB], true, "https://example.com/b");
    await store.clear(7, "https://example.com/a");

    await expect(store.load(7, "https://example.com/a")).resolves.toBeNull();
    await expect(store.load(7, "https://example.com/b")).resolves.toEqual([pageB]);
  });
});
