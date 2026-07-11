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

    expect(statusEl.textContent).toBe(
      "Daemon runtime off — choose Daemon for AI or media to connect",
    );
    expect(statusEl.dataset.state).toBe("warn");
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

    expect(statusEl.textContent).toBe(
      "Daemon runtime off — choose Daemon for AI or media to connect",
    );
    expect(statusEl.dataset.state).toBe("warn");
  });

  it("maps native host failures to an actionable reload/install hint", async () => {
    const statusEl = document.createElement("div");
    const checker = createDaemonStatusChecker({
      statusEl,
      fetchImpl: async () => {
        throw new Error("Specified native messaging host not found.");
      },
      getExtensionVersion: () => "0.17.0",
    });

    await checker.checkDaemonStatus("token");

    expect(statusEl.textContent).toBe(
      "Native host unavailable — rerun the install command, then reload the extension",
    );
    expect(statusEl.dataset.state).toBe("error");
  });

  it("preserves installed native host exit diagnostics instead of reinstall guidance", async () => {
    const statusEl = document.createElement("div");
    const checker = createDaemonStatusChecker({
      statusEl,
      fetchImpl: async () => {
        throw new Error("Native host has exited.");
      },
      getExtensionVersion: () => "0.17.0",
    });

    await checker.checkDaemonStatus("token");

    expect(statusEl.textContent).toBe(
      "Native host exited — run `summarize daemon status` and check ~/.summarize/logs/daemon.err.log",
    );
    expect(statusEl.dataset.state).toBe("error");
  });

  it("maps native host startup failures to install and launcher guidance", async () => {
    const statusEl = document.createElement("div");
    const checker = createDaemonStatusChecker({
      statusEl,
      fetchImpl: async () => {
        throw new Error("Failed to start native messaging host.");
      },
      getExtensionVersion: () => "0.17.0",
    });

    await checker.checkDaemonStatus("token");

    expect(statusEl.textContent).toBe(
      "Native host failed to start — rerun the install command and verify launcher permissions",
    );
    expect(statusEl.dataset.state).toBe("error");
  });

  it("maps native host protocol failures to status and log guidance", async () => {
    const statusEl = document.createElement("div");
    const checker = createDaemonStatusChecker({
      statusEl,
      fetchImpl: async () => {
        throw new Error("Error when communicating with the native messaging host.");
      },
      getExtensionVersion: () => "0.17.0",
    });

    await checker.checkDaemonStatus("token");

    expect(statusEl.textContent).toBe(
      "Native host communication failed — run `summarize daemon status` and check ~/.summarize/logs/daemon.err.log",
    );
    expect(statusEl.dataset.state).toBe("error");
  });

  it("maps missing native messaging permission to the Runtime setup action", async () => {
    const statusEl = document.createElement("div");
    const checker = createDaemonStatusChecker({
      statusEl,
      fetchImpl: async () => {
        throw new Error("Local companion permission is not enabled");
      },
      getExtensionVersion: () => "0.17.0",
    });

    await checker.checkDaemonStatus("token");

    expect(statusEl.textContent).toBe(
      "Local companion permission missing — enable it in Runtime settings",
    );
    expect(statusEl.dataset.state).toBe("error");
  });

  it("maps generic fetch failures to daemon status, port, and reload guidance", async () => {
    const statusEl = document.createElement("div");
    let fetchCalls = 0;
    const checker = createDaemonStatusChecker({
      statusEl,
      fetchImpl: async () => {
        fetchCalls += 1;
        throw new Error("Failed to fetch");
      },
      getExtensionVersion: () => "0.17.0",
    });

    await checker.checkDaemonStatus("token");

    expect(statusEl.textContent).toBe(
      "Daemon unreachable — run `summarize daemon status`, verify the port, then reload the extension",
    );
    expect(statusEl.dataset.state).toBe("error");
    expect(fetchCalls).toBe(2);
  });
});
