import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runDaemonServer } from "../src/daemon/server.js";

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

async function waitForMarker(markerPath: string, expected: string): Promise<void> {
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    if (existsSync(markerPath) && readFileSync(markerPath, "utf8").trim() === expected) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Timed out waiting for ${expected} marker`);
}

describe("daemon agent disconnect", () => {
  it("cancels CLI-backed SSE and JSON agent processes", async () => {
    const home = mkdtempSync(join(tmpdir(), "summarize-daemon-agent-disconnect-"));
    const markerPath = join(home, "marker.txt");
    const cliPath = join(home, "fake-openclaw.cjs");
    writeFileSync(
      cliPath,
      `#!/usr/bin/env node
const fs = require("node:fs");
const marker = process.env.CANCEL_MARKER;
fs.writeFileSync(marker, "started");
process.on("SIGTERM", () => {
  fs.writeFileSync(marker, "interrupted");
  process.exit(0);
});
setTimeout(() => {
  fs.writeFileSync(marker, "completed");
  process.stdout.write('{"result":{"payloads":[{"text":"late"}]}}\\n');
}, 10000);
`,
      { mode: 0o700 },
    );
    chmodSync(cliPath, 0o700);

    const port = await findFreePort();
    const token = "test-agent-disconnect-token";
    const daemonController = new AbortController();
    let resolveReady: (() => void) | null = null;
    const ready = new Promise<void>((resolve) => {
      resolveReady = resolve;
    });
    const serverPromise = runDaemonServer({
      env: {
        HOME: home,
        OPENCLAW_PATH: cliPath,
        CANCEL_MARKER: markerPath,
      },
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
      signal: daemonController.signal,
      onListening: () => resolveReady?.(),
    });
    await ready;

    const disconnect = async (accept?: string) => {
      rmSync(markerPath, { force: true });
      const requestController = new AbortController();
      const responsePromise = fetch(`http://127.0.0.1:${port}/v1/agent`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "content-type": "application/json",
          ...(accept ? { accept } : {}),
        },
        body: JSON.stringify({
          url: "https://example.com/disconnect",
          pageContent: "Disconnect context",
          messages: [{ role: "user", content: "Wait" }],
          model: "cli/openclaw/main",
        }),
        signal: requestController.signal,
      }).then((response) => response.text());
      await waitForMarker(markerPath, "started");
      requestController.abort();
      await expect(responsePromise).rejects.toMatchObject({ name: "AbortError" });
      await waitForMarker(markerPath, "interrupted");
    };

    try {
      await disconnect();
      await disconnect("application/json");
    } finally {
      daemonController.abort();
      await serverPromise;
    }
  });
});
