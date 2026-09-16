import { beforeEach, describe, expect, it, vi } from "vitest";
import { createChatSession } from "../apps/chrome-extension/src/entrypoints/sidepanel/chat-session.js";
import {
  LocalizedError,
  localizedErrorText,
  message,
  resolveText,
} from "../apps/chrome-extension/src/lib/i18n";

describe("sidepanel chat session", () => {
  it("keeps timeout errors translatable after the timeout", async () => {
    vi.useFakeTimers();
    try {
      const session = createChatSession({
        send: async () => {},
        agentTimeoutMs: 10,
        historyTimeoutMs: 10,
      });
      const requests = [session.requestAgent([], []), session.requestChatHistory()].map((request) =>
        request.catch((error) => error),
      );
      await vi.advanceTimersByTimeAsync(10);
      for (const error of await Promise.all(requests)) {
        expect(error).toBeInstanceOf(LocalizedError);
        const value = localizedErrorText(error);
        expect(resolveText(value, "en")).toContain("timed out");
        expect(resolveText(value, "tr")).toContain("zaman aşımına");
      }
    } finally {
      vi.useRealTimers();
    }
  });
  it("preserves localization metadata in agent and history responses", async () => {
    const send = vi.fn(async () => {});
    const session = createChatSession({ send });
    const localized = message("error.daemonTimeout");
    const agent = session.requestAgent([], []);
    session.handleAgentResponse({
      requestId: send.mock.calls[0][0].requestId,
      ok: false,
      error: "legacy",
      localized,
    });
    await expect(agent).resolves.toMatchObject({ localized });
    const history = session.requestChatHistory();
    session.handleChatHistoryResponse({
      requestId: send.mock.calls[1][0].requestId,
      ok: false,
      error: "legacy",
      localized,
    });
    await expect(history).resolves.toMatchObject({ localized });
  });
  beforeEach(() => {
    vi.useRealTimers();
  });

  it("routes agent responses and chunks to the matching pending request", async () => {
    const send = vi.fn(async () => {});
    const chunks: string[] = [];
    const session = createChatSession({ send });
    const request = session.requestAgent([], ["navigate"], "summary", {
      onChunk: (text) => chunks.push(text),
    });

    const requestId = vi.mocked(send).mock.calls[0]?.[0]?.requestId;
    session.handleAgentChunk({ requestId, text: "Hello" });
    session.handleAgentResponse({
      requestId,
      ok: true,
      assistant: {
        role: "assistant",
        content: [{ type: "text", text: "Done" }],
      } as never,
    });

    await expect(request).resolves.toEqual({
      ok: true,
      assistant: {
        role: "assistant",
        content: [{ type: "text", text: "Done" }],
      },
      error: undefined,
    });
    expect(chunks).toEqual(["Hello"]);
  });

  it("times out requests and aborts active agent work", async () => {
    vi.useFakeTimers();
    const setStatus = vi.fn();
    const hideReplOverlay = vi.fn(async () => {});
    const send = vi.fn(async () => {});
    const session = createChatSession({
      send,
      setStatus,
      hideReplOverlay,
      agentTimeoutMs: 10,
    });

    const request = session.requestAgent([], [], null);
    request.catch(() => {});
    await vi.advanceTimersByTimeAsync(10);
    await expect(request).rejects.toThrow("Agent request timed out");

    const second = session.requestAgent([], [], null);
    second.catch(() => {});
    session.requestAbort("Stopped");
    await expect(second).rejects.toThrow("Stopped");
    expect(session.isAbortRequested()).toBe(true);
    expect(setStatus).toHaveBeenCalledWith("Stopped");
    expect(hideReplOverlay).toHaveBeenCalled();
  });

  it("loads chat history responses and supports reset", async () => {
    const send = vi.fn(async () => {});
    const session = createChatSession({ send });
    const request = session.requestChatHistory("summary");
    const requestId = vi.mocked(send).mock.calls[0]?.[0]?.requestId;

    session.handleChatHistoryResponse({
      requestId,
      ok: true,
      messages: [{ role: "user", content: "hi" }] as never,
    });
    await expect(request).resolves.toEqual({
      ok: true,
      messages: [{ role: "user", content: "hi" }],
      error: undefined,
    });

    session.resetAbort();
    expect(session.isAbortRequested()).toBe(false);
    session.reset();
    expect(session.isAbortRequested()).toBe(false);
  });
});
