import { mkdtempSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { runDaemonServer } from "../src/daemon/server.js";
import { makeAssistantMessage, makeTextDeltaStream } from "./helpers/pi-ai-mock.js";

const mocks = vi.hoisted(() => ({
  completeSimple: vi.fn(),
  getModel: vi.fn(),
  streamSimple: vi.fn(),
}));

vi.mock("@earendil-works/pi-ai", () => ({
  completeSimple: mocks.completeSimple,
  getModel: mocks.getModel,
  streamSimple: mocks.streamSimple,
}));

const findFreePort = async (): Promise<number> =>
  await new Promise((resolve, reject) => {
    const server = createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close(() => reject(new Error("Failed to resolve port")));
        return;
      }
      server.close((error) => (error ? reject(error) : resolve(address.port)));
    });
  });

const model = {
  id: "gpt-5.2",
  name: "gpt-5.2",
  provider: "openai",
  api: "openai-responses" as const,
  baseUrl: "https://api.openai.com/v1",
  reasoning: false,
  input: ["text"] as const,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 8192,
  maxTokens: 2048,
};

beforeEach(() => {
  const assistant = makeAssistantMessage({ text: "Cached reply" });
  mocks.completeSimple.mockReset();
  mocks.getModel.mockReset();
  mocks.streamSimple.mockReset();
  mocks.getModel.mockReturnValue(model);
  mocks.completeSimple.mockResolvedValue(assistant);
  mocks.streamSimple.mockReturnValue(makeTextDeltaStream(["Cached ", "reply"], assistant));
});

describe("daemon agent history", () => {
  it("persists JSON and SSE responses and isolates cache keys", async () => {
    const home = mkdtempSync(join(tmpdir(), "summarize-daemon-agent-history-"));
    const port = await findFreePort();
    const token = "test-agent-history-token";
    const abortController = new AbortController();
    let resolveReady: (() => void) | null = null;
    const ready = new Promise<void>((resolve) => {
      resolveReady = resolve;
    });
    const serverPromise = runDaemonServer({
      env: { HOME: home, OPENAI_API_KEY: "test-key" },
      fetchImpl: fetch,
      config: {
        version: 2,
        token,
        tokens: [token],
        port,
        env: {},
        installedAt: new Date().toISOString(),
      },
      port,
      signal: abortController.signal,
      onListening: () => resolveReady?.(),
    });
    await ready;

    const request = async (pathname: string, body: Record<string, unknown>, accept?: string) => {
      const response = await fetch(`http://127.0.0.1:${port}${pathname}`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "content-type": "application/json",
          ...(accept ? { accept } : {}),
        },
        body: JSON.stringify(body),
      });
      return response;
    };
    const cacheFields = {
      url: "https://example.com/article",
      pageContent: "Rendered page context",
      cacheContent: "Stable extracted article",
      model: "openai/gpt-5.2",
      length: "short",
      language: "en",
      automationEnabled: false,
    };

    try {
      const miss = await request("/v1/agent/history", cacheFields);
      expect(miss.status).toBe(200);
      expect(await miss.json()).toEqual({ ok: true, messages: null });

      const jsonResponse = await request(
        "/v1/agent",
        {
          ...cacheFields,
          automationEnabled: true,
          messages: [
            { role: "user", content: "JSON question" },
            {
              role: "toolResult",
              toolCallId: "call-1",
              toolName: "repl",
              content: [{ type: "text", text: "Tool output" }],
              isError: false,
            },
          ],
        },
        "application/json",
      );
      expect(jsonResponse.status).toBe(200);
      expect(await jsonResponse.json()).toMatchObject({
        ok: true,
        assistant: { role: "assistant" },
      });

      const jsonHistory = await request("/v1/agent/history", {
        ...cacheFields,
        automationEnabled: true,
      });
      expect(jsonHistory.status).toBe(200);
      expect(await jsonHistory.json()).toMatchObject({
        ok: true,
        messages: [
          { role: "user", content: "JSON question", timestamp: expect.any(Number) },
          {
            role: "toolResult",
            toolCallId: "call-1",
            toolName: "repl",
            timestamp: expect.any(Number),
          },
          { role: "assistant", timestamp: expect.any(Number) },
        ],
      });

      const isolatedHistory = await request("/v1/agent/history", {
        ...cacheFields,
        cacheContent: "Different extracted article",
        automationEnabled: true,
      });
      expect(await isolatedHistory.json()).toEqual({ ok: true, messages: null });

      const otherPageHistory = await request("/v1/agent/history", {
        ...cacheFields,
        url: "https://example.com/other",
        automationEnabled: true,
      });
      expect(await otherPageHistory.json()).toEqual({ ok: true, messages: null });

      const streamFields = { ...cacheFields, cacheContent: "Streamed extracted article" };
      const streamResponse = await request("/v1/agent", {
        ...streamFields,
        messages: [{ role: "user", content: "SSE question" }],
      });
      expect(streamResponse.status).toBe(200);
      const streamBody = await streamResponse.text();
      expect(streamBody).toContain("event: assistant");
      expect(streamBody).toContain("event: done");

      const streamHistory = await request("/v1/agent/history", streamFields);
      expect(await streamHistory.json()).toMatchObject({
        ok: true,
        messages: [
          { role: "user", content: "SSE question", timestamp: expect.any(Number) },
          { role: "assistant", timestamp: expect.any(Number) },
        ],
      });
    } finally {
      abortController.abort();
      await serverPromise;
    }
  });
});
