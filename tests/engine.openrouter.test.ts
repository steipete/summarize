import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { createServer, type RequestListener, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildOpenRouterNoAllowedProvidersMessage } from "../src/engine/openrouter.js";
import { runCli } from "../src/run.js";
import { captureStream } from "./helpers/streams.js";

const cleanups: Array<() => Promise<void>> = [];
const attempts = [{ userModelId: "openrouter/vendor/model:free" }];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

async function providerServer(listener: RequestListener): Promise<typeof fetch> {
  const server = createServer(listener);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  cleanups.push(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing HTTP fixture address");
  const origin = `http://127.0.0.1:${address.port}`;
  return async (input, init) => {
    const url = new URL(
      typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
    );
    return fetch(`${origin}${url.pathname}${url.search}`, init);
  };
}

function sendProviders(response: ServerResponse, providers: string[]) {
  response.writeHead(200, { "content-type": "application/json" });
  response.end(
    JSON.stringify({ data: { endpoints: providers.map((provider_name) => ({ provider_name })) } }),
  );
}

function stallBody(response: ServerResponse) {
  response.writeHead(200, { "content-type": "application/json" });
  response.write('{"data":{"endpoints":[');
  const timer = setTimeout(() => {
    response.end('{"provider_name":"Slow Provider"}]}}');
  }, 1500);
  response.once("close", () => clearTimeout(timer));
}

describe("OpenRouter routing diagnostics", () => {
  it("keeps sorted, unique provider hints from a successful response", async () => {
    const requests: string[] = [];
    let accept: string | undefined;
    const fetchImpl = await providerServer((request, response) => {
      requests.push(request.url ?? "");
      accept = request.headers.accept;
      sendProviders(response, ["Provider B", "Provider A", "Provider B"]);
    });

    const message = await buildOpenRouterNoAllowedProvidersMessage({
      attempts: [...attempts, ...attempts],
      fetchImpl,
      timeoutMs: 500,
    });

    expect(message).toContain("Providers to allow: Provider A, Provider B.");
    expect(requests).toEqual(["/api/v1/models/vendor/model%3Afree/endpoints"]);
    expect(accept).toBe("application/json");
  });

  it("cancels a stalled body after response headers arrive", async () => {
    let headersReceived = false;
    let cancelled = false;
    const fetchImpl = await providerServer((_request, response) => {
      stallBody(response);
      response.once("close", () => {
        cancelled = !response.writableFinished;
      });
    });

    const message = await buildOpenRouterNoAllowedProvidersMessage({
      attempts,
      timeoutMs: 500,
      fetchImpl: async (input, init) => {
        const response = await fetchImpl(input, init);
        headersReceived = true;
        return response;
      },
    });

    expect(headersReceived).toBe(true);
    expect(message).toContain("OpenRouter could not route any models");
    expect(message).not.toContain("Providers to allow:");
    await expect.poll(() => cancelled).toBe(true);
  });

  it("retains fast hints when another model's response body stalls", async () => {
    const fetchImpl = await providerServer((request, response) => {
      if (request.url?.includes("/fast")) sendProviders(response, ["Fast Provider"]);
      else stallBody(response);
    });

    const message = await buildOpenRouterNoAllowedProvidersMessage({
      attempts: [{ userModelId: "openrouter/vendor/fast:free" }, ...attempts],
      fetchImpl,
      timeoutMs: 500,
    });

    expect(message).toContain("Providers to allow: Fast Provider.");
    expect(message).not.toContain("Slow Provider");
  });

  it("also bounds a response that never sends headers", async () => {
    let cancelled = false;
    const fetchImpl = await providerServer((_request, response) => {
      const timer = setTimeout(() => sendProviders(response, ["Late Provider"]), 1500);
      response.once("close", () => {
        clearTimeout(timer);
        cancelled = !response.writableFinished;
      });
    });

    const message = await buildOpenRouterNoAllowedProvidersMessage({
      attempts,
      fetchImpl,
      timeoutMs: 500,
    });

    expect(message).not.toContain("Providers to allow:");
    await expect.poll(() => cancelled).toBe(true);
  });

  it.each([
    { name: "an HTTP error", status: 503, body: '{"error":"unavailable"}' },
    { name: "invalid JSON", status: 200, body: "invalid" },
  ])("keeps routing guidance after $name", async ({ status, body }) => {
    const fetchImpl = await providerServer((_request, response) => {
      response.writeHead(status, { "content-type": "application/json" });
      response.end(body);
    });

    const message = await buildOpenRouterNoAllowedProvidersMessage({
      attempts,
      fetchImpl,
      timeoutMs: 500,
    });

    expect(message).toContain("OpenRouter could not route any models");
    expect(message).not.toContain("Providers to allow:");
  });

  it("preserves the CLI failure cause and free-preset guidance when metadata times out", async () => {
    let cancelled = false;
    const fetchImpl = await providerServer((request, response) => {
      if (request.method === "POST") {
        response.writeHead(404, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            error: { message: "No allowed providers are available for the selected model." },
          }),
        );
        return;
      }
      stallBody(response);
      response.once("close", () => {
        cancelled = !response.writableFinished;
      });
    });
    const root = await mkdtemp(join(tmpdir(), "summarize-routing-deadline-"));
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    await mkdir(join(root, ".summarize"));
    await writeFile(
      join(root, ".summarize", "config.json"),
      JSON.stringify({
        cache: { enabled: false },
        models: {
          free: {
            mode: "auto",
            rules: [{ candidates: attempts.map(({ userModelId }) => userModelId) }],
          },
        },
      }),
    );
    const input = join(root, "input.txt");
    await writeFile(
      input,
      "A scientific report about lunar instruments and calibration measurements.",
    );
    const stdout = captureStream();
    const stderr = captureStream();
    let failure: unknown;
    try {
      await runCli(
        [
          "--model",
          "free",
          "--timeout",
          "500ms",
          "--retries",
          "0",
          "--force-summary",
          "--plain",
          input,
        ],
        {
          env: { HOME: root, OPENROUTER_API_KEY: "fixture-key", LANG: "C" },
          fetch: fetchImpl,
          stdout: stdout.stream,
          stderr: stderr.stream,
        },
      );
    } catch (error) {
      failure = error;
    }

    expect(failure).toHaveProperty(
      "message",
      expect.stringContaining("OpenRouter could not route any models"),
    );
    expect(failure).toHaveProperty(
      "message",
      expect.stringContaining('Tip: run "summarize refresh-free"'),
    );
    expect(failure).toHaveProperty(
      "cause",
      expect.objectContaining({ message: expect.stringContaining("No allowed providers") }),
    );
    expect(failure).toHaveProperty("message", expect.not.stringContaining("Slow Provider"));
    expect(stdout.getText()).toBe("");
    await expect.poll(() => cancelled).toBe(true);
  });
});
