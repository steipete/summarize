// @vitest-environment jsdom
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
});
