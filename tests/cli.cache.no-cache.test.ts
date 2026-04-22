import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { runCli } from "../src/run.js";
import { makeAssistantMessage, makeTextDeltaStream } from "./helpers/pi-ai-mock.js";

const TARGET_URL = "https://example.com";

const htmlResponse = (html: string, status = 200) =>
  new Response(html, {
    status,
    headers: { "Content-Type": "text/html" },
  });

function collectStream() {
  let text = "";
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      text += chunk.toString();
      callback();
    },
  });
  return { stream, getText: () => text };
}

function requestUrl(input: RequestInfo | URL): string {
  return typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
}

const mocks = vi.hoisted(() => ({
  streamSimple: vi.fn(),
  completeSimple: vi.fn(),
  getModel: vi.fn(() => {
    throw new Error("no model");
  }),
}));

mocks.streamSimple.mockImplementation(() =>
  makeTextDeltaStream(
    ["Summary content."],
    makeAssistantMessage({
      text: "Summary content.",
      usage: { input: 1, output: 1, totalTokens: 2 },
    }),
  ),
);

vi.mock("@mariozechner/pi-ai", () => ({
  streamSimple: mocks.streamSimple,
  completeSimple: mocks.completeSimple,
  getModel: mocks.getModel,
}));

describe("cli --no-cache bug reproduction", () => {
  it("refetches URL content when --no-cache is provided", async () => {
    mocks.streamSimple.mockClear();

    const root = mkdtempSync(join(tmpdir(), "summarize-no-cache-repro-"));
    const summarizeDir = join(root, ".summarize");
    const cacheDir = join(summarizeDir, "cache");
    mkdirSync(cacheDir, { recursive: true });

    writeFileSync(
      join(summarizeDir, "config.json"),
      JSON.stringify({ cache: { enabled: true, maxMb: 32, ttlDays: 30 } }),
      "utf8",
    );

    // Mock LiteLLM catalog to avoid fetch
    writeFileSync(
      join(cacheDir, "litellm-model_prices_and_context_window.json"),
      JSON.stringify({ "gpt-5.2": { max_input_tokens: 999_999 } }),
      "utf8",
    );
    writeFileSync(
      join(cacheDir, "litellm-model_prices_and_context_window.meta.json"),
      JSON.stringify({ fetchedAtMs: Date.now() }),
      "utf8",
    );

    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = requestUrl(input);
      if (url === TARGET_URL) {
        return htmlResponse("<!doctype html><html><body>First fetch</body></html>");
      }
      if (url.includes("api.openai.com")) {
        return new Response(
          JSON.stringify({
            output_text: "Summary content.",
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          }),
        );
      }
      throw new Error(`Unexpected fetch call: ${url}`);
    });

    const stdout1 = collectStream();
    const stderr1 = collectStream();

    await runCli(["--model", "openai/gpt-5.2", "--metrics", "off", TARGET_URL], {
      env: { HOME: root, OPENAI_API_KEY: "test" },
      fetch: fetchMock as unknown as typeof fetch,
      stdout: stdout1.stream,
      stderr: stderr1.stream,
    });

    const firstUrlCalls = fetchMock.mock.calls.filter((call) => requestUrl(call[0]) === TARGET_URL);
    expect(firstUrlCalls.length).toBeGreaterThan(0);

    fetchMock.mockClear();

    fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
      const url = requestUrl(input);
      if (url === TARGET_URL) {
        return htmlResponse("<!doctype html><html><body>Second fetch</body></html>");
      }
      if (url.includes("api.openai.com")) {
        return new Response(
          JSON.stringify({
            output_text: "New summary content.",
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          }),
        );
      }
      throw new Error(`Unexpected fetch call: ${url}`);
    });

    const stdout2 = collectStream();
    const stderr2 = collectStream();

    await runCli(["--model", "openai/gpt-5.2", "--metrics", "off", "--no-cache", TARGET_URL], {
      env: { HOME: root, OPENAI_API_KEY: "test" },
      fetch: fetchMock as unknown as typeof fetch,
      stdout: stdout2.stream,
      stderr: stderr2.stream,
    });

    const urlCalls = fetchMock.mock.calls.filter((call) => requestUrl(call[0]) === TARGET_URL);
    expect(urlCalls.length).toBeGreaterThan(0);
    expect(stdout2.getText()).toContain("New summary content.");
  }, 30_000);
});
