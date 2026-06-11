import { mkdtempSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { runDaemonServer } from "../src/daemon/server.js";

const PUBLIC_TEST_URL = "http://93.184.216.34/article";

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

const summarizeBody = () =>
  JSON.stringify({
    url: PUBLIC_TEST_URL,
    mode: "url",
    extractOnly: true,
  });

const summaryBody = () =>
  JSON.stringify({
    url: PUBLIC_TEST_URL,
    mode: "url",
    text: "",
    title: "Article",
    length: "medium",
  });

describe("daemon summarize limits", () => {
  it("rejects concurrent summarize requests over the active limit", async () => {
    const home = mkdtempSync(join(tmpdir(), "summarize-daemon-limits-"));
    const port = await findFreePort();
    const token = "test-token-limits-123";
    const abortController = new AbortController();
    let resolveReady: (() => void) | null = null;
    const ready = new Promise<void>((resolve) => {
      resolveReady = resolve;
    });
    let resolveFetchStarted: (() => void) | null = null;
    const fetchStarted = new Promise<void>((resolve) => {
      resolveFetchStarted = resolve;
    });
    let resolveFetch: ((response: Response) => void) | null = null;
    const fetchImpl = vi.fn(async () => {
      resolveFetchStarted?.();
      return await new Promise<Response>((resolve) => {
        resolveFetch = resolve;
      });
    });

    const serverPromise = runDaemonServer({
      env: { HOME: home, SUMMARIZE_DAEMON_MAX_ACTIVE_SUMMARIES: "1" },
      fetchImpl: fetchImpl as unknown as typeof fetch,
      config: { token, port, version: 1, installedAt: new Date().toISOString() },
      port,
      signal: abortController.signal,
      onListening: () => resolveReady?.(),
    });

    await ready;

    try {
      const first = fetch(`http://127.0.0.1:${port}/v1/summarize`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        body: summarizeBody(),
      });
      await fetchStarted;

      const second = await fetch(`http://127.0.0.1:${port}/v1/summarize`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        body: summarizeBody(),
      });
      const secondJson = (await second.json()) as { error?: string };

      expect(second.status).toBe(429);
      expect(secondJson.error).toMatch(/too many active summarize requests/i);

      resolveFetch?.(
        new Response("<!doctype html><html><body><article>Hello</article></body></html>", {
          headers: { "content-type": "text/html" },
        }),
      );
      const firstRes = await first;
      expect(firstRes.status).toBe(200);
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    } finally {
      abortController.abort();
      await serverPromise;
    }
  });

  it("coalesces duplicate active summarize requests before enforcing the active limit", async () => {
    const home = mkdtempSync(join(tmpdir(), "summarize-daemon-dedupe-"));
    const port = await findFreePort();
    const token = "test-token-dedupe-123";
    const abortController = new AbortController();
    let resolveReady: (() => void) | null = null;
    const ready = new Promise<void>((resolve) => {
      resolveReady = resolve;
    });
    let resolveFetchStarted: (() => void) | null = null;
    const fetchStarted = new Promise<void>((resolve) => {
      resolveFetchStarted = resolve;
    });
    let resolveFetch: ((response: Response) => void) | null = null;
    const fetchImpl = vi.fn(async () => {
      resolveFetchStarted?.();
      return await new Promise<Response>((resolve) => {
        resolveFetch = resolve;
      });
    });

    const serverPromise = runDaemonServer({
      env: { HOME: home, SUMMARIZE_DAEMON_MAX_ACTIVE_SUMMARIES: "1" },
      fetchImpl: fetchImpl as unknown as typeof fetch,
      config: { token, port, version: 1, installedAt: new Date().toISOString() },
      port,
      signal: abortController.signal,
      onListening: () => resolveReady?.(),
    });

    await ready;

    try {
      const first = await fetch(`http://127.0.0.1:${port}/v1/summarize`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        body: summaryBody(),
      });
      const firstJson = (await first.json()) as { id?: string };
      expect(first.status).toBe(200);
      expect(firstJson.id).toBeTruthy();
      await fetchStarted;

      const second = await fetch(`http://127.0.0.1:${port}/v1/summarize`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        body: summaryBody(),
      });
      const secondJson = (await second.json()) as { id?: string; coalesced?: boolean };

      expect(second.status).toBe(200);
      expect(secondJson).toMatchObject({ id: firstJson.id, coalesced: true });
      expect(fetchImpl).toHaveBeenCalledTimes(1);

      resolveFetch?.(
        new Response("<!doctype html><html><body><article>Hello</article></body></html>", {
          headers: { "content-type": "text/html" },
        }),
      );
    } finally {
      abortController.abort();
      await serverPromise;
    }
  });
});
