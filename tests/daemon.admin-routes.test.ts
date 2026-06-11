import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
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
      const { port } = address;
      server.close((err) => (err ? reject(err) : resolve(port)));
    });
  });

describe("daemon admin routes", () => {
  it("serves daemon log tail from the extracted admin route handler", async () => {
    const home = mkdtempSync(join(tmpdir(), "summarize-daemon-admin-logs-"));
    const port = await findFreePort();
    const token = "test-token-admin-logs";
    const configDir = join(home, ".summarize");
    const logDir = join(configDir, "logs");
    const logPath = join(logDir, "daemon.jsonl");
    mkdirSync(logDir, { recursive: true });
    const lines = Array.from({ length: 60 }, (_value, index) => `{"msg":"line-${index + 1}"}`);
    writeFileSync(logPath, `${lines.join("\n")}\n`, "utf8");
    writeFileSync(
      join(configDir, "config.json"),
      JSON.stringify({
        logging: {
          enabled: true,
          format: "json",
          file: logPath,
        },
      }),
      "utf8",
    );

    const abortController = new AbortController();
    let resolveReady: (() => void) | null = null;
    const ready = new Promise<void>((resolve) => {
      resolveReady = resolve;
    });

    const serverPromise = runDaemonServer({
      env: { HOME: home },
      fetchImpl: fetch,
      config: { token, port, version: 1, installedAt: new Date().toISOString() },
      port,
      signal: abortController.signal,
      onListening: () => resolveReady?.(),
    });

    await ready;

    try {
      const response = await fetch(`http://127.0.0.1:${port}/v1/logs?source=daemon&tail=2`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const payload = (await response.json()) as {
        ok: boolean;
        source: string;
        lines: string[];
        truncated: boolean;
      };
      expect(response.ok).toBe(true);
      expect(payload.ok).toBe(true);
      expect(payload.source).toBe("daemon");
      expect(payload.lines).toHaveLength(50);
      expect(payload.lines[0]).toBe('{"msg":"line-11"}');
      expect(payload.lines.at(-1)).toBe('{"msg":"line-60"}');
      expect(payload.truncated).toBe(true);
    } finally {
      abortController.abort();
      await serverPromise;
    }
  });

  it("reports tool availability and empty process state through admin routes", async () => {
    const home = mkdtempSync(join(tmpdir(), "summarize-daemon-admin-tools-"));
    const port = await findFreePort();
    const token = "test-token-admin-tools";
    const binDir = join(home, "bin");
    mkdirSync(binDir, { recursive: true });

    const abortController = new AbortController();
    let resolveReady: (() => void) | null = null;
    const ready = new Promise<void>((resolve) => {
      resolveReady = resolve;
    });

    const serverPromise = runDaemonServer({
      env: { HOME: home, PATH: binDir },
      fetchImpl: fetch,
      config: { token, port, version: 1, installedAt: new Date().toISOString() },
      port,
      signal: abortController.signal,
      onListening: () => resolveReady?.(),
    });

    await ready;

    try {
      const toolsResponse = await fetch(`http://127.0.0.1:${port}/v1/tools`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const toolsPayload = (await toolsResponse.json()) as {
        ok: boolean;
        tools: {
          ytDlp: { available: boolean; path: string | null };
          ffmpeg: { available: boolean; path: string | null };
          tesseract: { available: boolean; path: string | null };
        };
      };
      expect(toolsResponse.ok).toBe(true);
      expect(toolsPayload.tools.ffmpeg).toEqual({
        available: true,
        path: "bundled:ffmpeg-wasm",
      });
      expect(toolsPayload.tools.ytDlp.available).toBe(false);
      expect(toolsPayload.tools.tesseract.available).toBe(false);

      const processesResponse = await fetch(
        `http://127.0.0.1:${port}/v1/processes?includeCompleted=true`,
        {
          headers: { Authorization: `Bearer ${token}` },
        },
      );
      const processesPayload = (await processesResponse.json()) as {
        ok: boolean;
        processes: unknown[];
      };
      expect(processesResponse.ok).toBe(true);
      expect(processesPayload.processes).toEqual([]);

      const missingLogsResponse = await fetch(
        `http://127.0.0.1:${port}/v1/processes/missing/logs`,
        {
          headers: { Authorization: `Bearer ${token}` },
        },
      );
      const missingLogsPayload = (await missingLogsResponse.json()) as {
        ok: boolean;
        error: string;
      };
      expect(missingLogsResponse.status).toBe(404);
      expect(missingLogsPayload).toEqual({ ok: false, error: "not found" });
    } finally {
      abortController.abort();
      await serverPromise;
    }
  });
});
