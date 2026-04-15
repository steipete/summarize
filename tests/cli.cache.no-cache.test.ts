import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { runCli } from "../src/run.js";
import { makeAssistantMessage, makeTextDeltaStream } from "./helpers/pi-ai-mock.js";

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
  it("should NOT reuse cached content when --no-cache is provided", async () => {
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
      const url = typeof input === "string" ? input : "url" in input ? input.url : input.toString();
      if (url === "https://example.com") {
        return htmlResponse("<!doctype html><html><body>First fetch</body></html>");
      }
      if (url.includes("api.openai.com")) {
        return new Response(JSON.stringify({
          output_text: "Summary content.",
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }
        }));
      }
      throw new Error(`Unexpected fetch call: ${url}`);
    });

    const stdout1 = collectStream();
    const stderr1 = collectStream();

    // First run to populate cache
    await runCli(
      [
        "--model",
        "openai/gpt-5.2",
        "--metrics",
        "off",
        "https://example.com",
      ],
      {
        env: { HOME: root, OPENAI_API_KEY: "test" },
        fetch: fetchMock as unknown as typeof fetch,
        stdout: stdout1.stream,
        stderr: stderr1.stream,
      },
    );

    expect(fetchMock).toHaveBeenCalledTimes(4);

    // Update fetch mock to return something different
    fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : "url" in input ? input.url : input.toString();
      if (url === "https://example.com") {
        return htmlResponse("<!doctype html><html><body>Second fetch</body></html>");
      }
      if (url.includes("api.openai.com")) {
        return new Response(JSON.stringify({
          output_text: "Summary content.",
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }
        }));
      }
      throw new Error(`Unexpected fetch call: ${url}`);
    });

    const stdout2 = collectStream();
    const stderr2 = collectStream();

    // Second run WITH --no-cache
    await runCli(
      [
        "--model",
        "openai/gpt-5.2",
        "--metrics",
        "off",
        "--no-cache",
        "https://example.com",
      ],
      {
        env: { HOME: root, OPENAI_API_KEY: "test" },
        fetch: fetchMock as unknown as typeof fetch,
        stdout: stdout2.stream,
        stderr: stderr2.stream,
      },
    );

    // If the bug exists, fetchMock won't be called again for the URL (it will hit cache)
    // and mocks.streamSimple might also be skipped if the summary is cached.
    
    // THE BUG: noCacheFlag is hardcoded to false, so it WILL hit the cache for extraction.
    // EXPECTATION: It SHOULD call fetch again for the URL, so total calls should be 4 + 4 = 8.
    // (1 URL fetch + 3 OpenAI calls each time)
    expect(fetchMock, "Fetch should be called again when --no-cache is used").toHaveBeenCalledTimes(8);
  }, 30_000);
});
