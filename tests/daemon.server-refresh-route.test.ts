import type http from "node:http";
import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  refreshFree: vi.fn(),
}));

vi.mock("../src/refresh-free.js", () => ({
  refreshFree: mocks.refreshFree,
}));

import { handleRefreshFreeRoute } from "../src/daemon/server-refresh-route.js";
import { DaemonRuntime } from "../src/daemon/server-runtime.js";
import type { SessionEvent } from "../src/daemon/server-session.js";

function createResponse() {
  const response = {
    writeHead: vi.fn(),
    end: vi.fn(),
  };
  return response as unknown as http.ServerResponse & typeof response;
}

function readJsonResponse(response: ReturnType<typeof createResponse>) {
  const body = response.end.mock.calls[0]?.[0];
  return JSON.parse(String(body)) as Record<string, unknown>;
}

describe("daemon refresh-free route", () => {
  it("ignores unrelated routes", async () => {
    const handled = await handleRefreshFreeRoute({
      req: { method: "GET" } as http.IncomingMessage,
      res: createResponse(),
      pathname: "/health",
      cors: {},
      env: {},
      fetchImpl: fetch,
      runtime: new DaemonRuntime({ maxActiveSummaries: 1 }),
      createSessionId: () => "refresh-1",
    });

    expect(handled).toBe(false);
    expect(mocks.refreshFree).not.toHaveBeenCalled();
  });

  it("streams keyed status and completion events without parsing terminal output", async () => {
    mocks.refreshFree.mockImplementationOnce(async ({ stdout, onMessage }) => {
      stdout.write("raw terminal-only diagnostic\n");
      onMessage("Refresh Free: selected 2 candidates.", {
        key: "refresh.selected",
        values: { count: 2 },
      });
    });
    const runtime = new DaemonRuntime({ maxActiveSummaries: 1 });
    const events: SessionEvent[] = [];
    const response = createResponse();

    await handleRefreshFreeRoute({
      req: { method: "POST" } as http.IncomingMessage,
      res: response,
      pathname: "/v1/refresh-free",
      cors: {},
      env: {},
      fetchImpl: fetch,
      runtime,
      createSessionId: () => "refresh-1",
      cleanupDelayMs: 0,
      onSessionEvent: (event) => events.push(event),
    });

    expect(readJsonResponse(response)).toEqual({ ok: true, id: "refresh-1" });
    await vi.waitFor(() => expect(runtime.activeRefreshSessionId).toBeNull());
    expect(events).toEqual([
      {
        event: "status",
        data: { text: "Refresh Free: starting…", message: { key: "refresh.begin", values: {} } },
      },
      {
        event: "status",
        data: {
          text: "Refresh Free: selected 2 candidates.",
          message: { key: "refresh.selected", values: { count: 2 } },
        },
      },
      { event: "done", data: {} },
    ]);
  });

  it("coalesces active refreshes and reports failures", async () => {
    let rejectRefresh: ((error: Error) => void) | null = null;
    mocks.refreshFree.mockImplementationOnce(
      async () =>
        await new Promise<void>((_resolve, reject) => {
          rejectRefresh = reject;
        }),
    );
    const runtime = new DaemonRuntime({ maxActiveSummaries: 1 });
    const events: SessionEvent[] = [];
    const firstResponse = createResponse();

    await handleRefreshFreeRoute({
      req: { method: "POST" } as http.IncomingMessage,
      res: firstResponse,
      pathname: "/v1/refresh-free",
      cors: {},
      env: {},
      fetchImpl: fetch,
      runtime,
      createSessionId: () => "refresh-1",
      cleanupDelayMs: 0,
      onSessionEvent: (event) => events.push(event),
    });

    const secondResponse = createResponse();
    await handleRefreshFreeRoute({
      req: { method: "POST" } as http.IncomingMessage,
      res: secondResponse,
      pathname: "/v1/refresh-free",
      cors: {},
      env: {},
      fetchImpl: fetch,
      runtime,
      createSessionId: () => "refresh-2",
      cleanupDelayMs: 0,
    });
    expect(readJsonResponse(secondResponse)).toEqual({
      ok: true,
      id: "refresh-1",
      running: true,
    });

    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    rejectRefresh?.(new Error("refresh failed"));
    await vi.waitFor(() => expect(runtime.activeRefreshSessionId).toBeNull());
    expect(events.at(-1)).toEqual({
      event: "error",
      data: { message: "refresh failed" },
    });
    expect(consoleError).toHaveBeenCalledOnce();
    consoleError.mockRestore();
  });
});
