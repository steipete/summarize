import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { runDaemonServer } from "../src/daemon/server.js";

it.each(["thinking", "reasoningEffort"])(
  "forwards configured %s max through daemon presets to Responses",
  async (key) => {
    const home = await mkdtemp(join(tmpdir(), "summarize-max-"));
    const listener = createServer();
    await new Promise<void>((resolve) => listener.listen(0, "127.0.0.1", resolve));
    const address = listener.address();
    if (!address || typeof address === "string") throw new Error("Missing test port");
    const port = address.port;
    await new Promise<void>((resolve) => listener.close(() => resolve()));
    await mkdir(join(home, ".summarize"));
    await writeFile(
      join(home, ".summarize", "config.json"),
      JSON.stringify({
        openai: { [key]: "low" },
        models: { careful: { id: "openai/gpt-6.1-sol", [key]: "max" } },
      }),
    );
    const fetchImpl = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        new Response(
          'data: {"type":"response.output_text.delta","delta":"The library opens Monday."}\n\ndata: {"type":"response.completed","response":{"usage":{"input_tokens":2,"output_tokens":3,"total_tokens":5}}}\n\n',
          {
            headers: { "content-type": "text/event-stream" },
          },
        ),
    );
    const ready = Promise.withResolvers<void>();
    const done = Promise.withResolvers<string | null>();
    const controller = new AbortController();
    const token = "synthetic-max-test-token";
    const server = runDaemonServer({
      env: { HOME: home, OPENAI_API_KEY: "test-key" },
      fetchImpl,
      config: { token, port, version: 1, installedAt: new Date().toISOString() },
      port,
      signal: controller.signal,
      onListening: () => ready.resolve(),
      onSessionEvent: (event) => {
        if (event.event === "done") done.resolve(null);
        if (event.event === "error") done.resolve(event.data.message);
      },
    });
    try {
      await ready.promise;
      const response = await fetch(`http://127.0.0.1:${port}/v1/summarize`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({
          url: "https://example.com/library",
          text: "The library opens Monday. It has books and a reading room. ".repeat(30),
          mode: "page",
          model: "careful",
          length: "short",
          noCache: true,
        }),
      });
      expect(response.status).toBe(200);
      expect(await done.promise).toBeNull();
      const call = fetchImpl.mock.calls.find(([url]) => String(url).endsWith("/responses"));
      expect(call).toBeDefined();
      expect(JSON.parse(String(call?.[1]?.body))).toMatchObject({
        model: "gpt-6.1-sol",
        reasoning: { effort: "max" },
      });
    } finally {
      controller.abort();
      await server;
      await rm(home, { recursive: true, force: true });
    }
  },
);
