// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { createDaemonStatusChecker } from "../apps/chrome-extension/src/entrypoints/options/daemon-status.js";

const jsonResponse = (body: unknown) =>
  new Response(JSON.stringify(body), { headers: { "Content-Type": "application/json" } });

const createDeferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};

describe("options daemon status", () => {
  it("shows that the daemon is not selected without probing it", async () => {
    const statusEl = document.createElement("div");
    let fetchCalls = 0;
    const checker = createDaemonStatusChecker({
      statusEl,
      fetchImpl: async () => {
        fetchCalls += 1;
        throw new Error("should not fetch");
      },
      getExtensionVersion: () => "0.17.0",
      isDaemonMode: () => false,
    });

    await checker.checkDaemonStatus("token");

    expect(statusEl.textContent).toBe("Daemon not selected");
    expect(statusEl.dataset.state).toBe("ok");
    expect(fetchCalls).toBe(0);
  });

  it("keeps an empty-token warning from being overwritten by an older check", async () => {
    const statusEl = document.createElement("div");
    const health = createDeferred<Response>();
    const fetchImpl = async (input: string | URL | Request) => {
      const url = new URL(String(input));
      if (url.pathname === "/health") return health.promise;
      if (url.pathname === "/v1/ping") return jsonResponse({ ok: true });
      throw new Error(`unexpected request: ${url.pathname}`);
    };
    const checker = createDaemonStatusChecker({
      statusEl,
      fetchImpl,
      getExtensionVersion: () => "0.15.2",
    });

    const staleCheck = checker.checkDaemonStatus("token");
    await checker.checkDaemonStatus("");
    health.resolve(jsonResponse({ version: "0.15.2" }));
    await staleCheck;

    expect(statusEl.textContent).toBe("Add token to verify daemon connection");
    expect(statusEl.dataset.state).toBe("warn");
  });

  it("keeps the unselected state from being overwritten by an older daemon check", async () => {
    const statusEl = document.createElement("div");
    const health = createDeferred<Response>();
    let daemonMode = true;
    const fetchImpl = async (input: string | URL | Request) => {
      const url = new URL(String(input));
      if (url.pathname === "/health") return health.promise;
      if (url.pathname === "/v1/ping") return jsonResponse({ ok: true });
      throw new Error(`unexpected request: ${url.pathname}`);
    };
    const checker = createDaemonStatusChecker({
      statusEl,
      fetchImpl,
      getExtensionVersion: () => "0.17.0",
      isDaemonMode: () => daemonMode,
    });

    const staleCheck = checker.checkDaemonStatus("token");
    daemonMode = false;
    await checker.checkDaemonStatus("token");
    health.resolve(jsonResponse({ version: "0.17.0" }));
    await staleCheck;

    expect(statusEl.textContent).toBe("Daemon not selected");
    expect(statusEl.dataset.state).toBe("ok");
  });
});
