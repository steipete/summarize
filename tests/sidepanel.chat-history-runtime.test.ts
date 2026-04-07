import { describe, expect, it, vi } from "vitest";
import { createChatHistoryRuntime } from "../apps/chrome-extension/src/entrypoints/sidepanel/chat-history-runtime.js";

describe("sidepanel chat history runtime", () => {
  it("persists compacted messages", async () => {
    const chatController = {
      getMessages: vi.fn(() => [{ id: "1", role: "user", content: "hello", timestamp: 1 }]),
      setMessages: vi.fn(),
    };
    const chatHistoryStore = {
      clear: vi.fn(async () => {}),
      load: vi.fn(async () => null),
      persist: vi.fn(async (_tabId, messages) => messages),
    };
    const runtime = createChatHistoryRuntime({
      chatController,
      chatHistoryStore,
      chatLimits: { maxMessages: 10, maxChars: 100 },
      normalizeStoredMessage: vi.fn(),
      requestChatHistory: vi.fn(),
      getActiveUrl: vi.fn(() => "https://example.com"),
    });

    await runtime.persist(7, true);

    expect(chatHistoryStore.persist).toHaveBeenCalledWith(
      7,
      [{ id: "1", role: "user", content: "hello", timestamp: 1 }],
      true,
      "https://example.com",
    );
    expect(chatController.setMessages).not.toHaveBeenCalled();
  });

  it("restores local history before requesting the daemon", async () => {
    const history = [{ id: "1", role: "user", content: "cached", timestamp: 1 }];
    const chatController = {
      getMessages: vi.fn(() => []),
      setMessages: vi.fn(),
    };
    const chatHistoryStore = {
      clear: vi.fn(async () => {}),
      load: vi.fn(async () => history as never),
      persist: vi.fn(async (_tabId, messages) => messages),
    };
    const requestChatHistory = vi.fn();
    const runtime = createChatHistoryRuntime({
      chatController,
      chatHistoryStore,
      chatLimits: { maxMessages: 10, maxChars: 100 },
      normalizeStoredMessage: vi.fn(),
      requestChatHistory,
      getActiveUrl: vi.fn(() => "https://example.com"),
    });

    await runtime.restore(7, "summary");

    expect(chatController.setMessages).toHaveBeenCalledWith(history, { scroll: false });
    expect(requestChatHistory).not.toHaveBeenCalled();
  });

  it("falls back to daemon history and ignores invalid payloads", async () => {
    const chatController = {
      getMessages: vi.fn(() => []),
      setMessages: vi.fn(),
    };
    const chatHistoryStore = {
      clear: vi.fn(async () => {}),
      load: vi.fn(async () => null),
      persist: vi.fn(async (_tabId, messages) => messages),
    };
    const requestChatHistory = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        messages: [{ role: "user", content: "remote", timestamp: 1 }],
      })
      .mockResolvedValueOnce({
        ok: true,
        messages: ["bad"],
      });
    const runtime = createChatHistoryRuntime({
      chatController,
      chatHistoryStore,
      chatLimits: { maxMessages: 10, maxChars: 100 },
      normalizeStoredMessage: vi.fn((raw) => (raw.role === "user" ? (raw as never) : null)),
      requestChatHistory,
      getActiveUrl: vi.fn(() => "https://example.com"),
    });

    await runtime.restore(7, "summary");
    expect(chatHistoryStore.persist).toHaveBeenCalledWith(
      7,
      [{ role: "user", content: "remote", timestamp: 1 }],
      true,
      "https://example.com",
    );
    expect(chatController.setMessages).toHaveBeenCalledWith(
      [{ role: "user", content: "remote", timestamp: 1 }],
      { scroll: false },
    );

    chatController.setMessages.mockClear();
    await runtime.restore(7, "summary");
    expect(chatController.setMessages).not.toHaveBeenCalled();
  });
});
