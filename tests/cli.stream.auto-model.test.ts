import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { runCli } from "../src/run.js";
import { captureStream as collectStream } from "./helpers/streams.js";

const htmlResponse = (html: string, status = 200) =>
  new Response(html, {
    status,
    headers: { "Content-Type": "text/html" },
  });

function createTextStream(chunks: string[]): AsyncIterable<string> {
  return {
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) yield chunk;
    },
  };
}

vi.mock("../src/llm/generate-text.js", () => ({
  generateTextWithModelId: vi.fn(async () => {
    throw new Error("unexpected non-streaming call");
  }),
  streamTextWithModelId: vi.fn(async () => ({
    textStream: createTextStream(["O", "K"]),
    canonicalModelId: "openai/gpt-5.2",
    provider: "openai",
    usage: Promise.resolve({ promptTokens: 1, completionTokens: 2, totalTokens: 3 }),
    lastError: () => null,
  })),
}));

describe("cli streaming with auto model selection", () => {
  it("streams when using an auto preset and --stream on", async () => {
    const root = mkdtempSync(join(tmpdir(), "summarize-stream-auto-"));
    mkdirSync(join(root, ".summarize"), { recursive: true });
    mkdirSync(join(root, ".summarize", "cache"), { recursive: true });

    writeFileSync(
      join(root, ".summarize", "cache", "litellm-model_prices_and_context_window.json"),
      JSON.stringify({
        "gpt-5.2": { input_cost_per_token: 0.00000175, output_cost_per_token: 0.000014 },
      }),
      "utf8",
    );
    writeFileSync(
      join(root, ".summarize", "cache", "litellm-model_prices_and_context_window.meta.json"),
      JSON.stringify({ fetchedAtMs: Date.now() }),
      "utf8",
    );

    writeFileSync(
      join(root, ".summarize", "config.json"),
      JSON.stringify({
        models: {
          free: { mode: "auto", rules: [{ candidates: ["openai/gpt-5.2"] }] },
        },
      }),
      "utf8",
    );

    const globalFetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      throw new Error("unexpected LiteLLM catalog fetch");
    });

    const html =
      "<!doctype html><html><head><title>Hello</title></head>" +
      "<body><article><p>Hi</p></article></body></html>";

    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.url;
      if (url === "https://example.com") return htmlResponse(html);
      throw new Error(`Unexpected fetch call: ${url}`);
    });

    const stdout = collectStream();
    const stderr = collectStream();

    await runCli(
      ["--model", "free", "--timeout", "2s", "--stream", "on", "--plain", "https://example.com"],
      {
        env: { HOME: root, OPENAI_API_KEY: "test" },
        fetch: fetchMock as unknown as typeof fetch,
        stdout: stdout.stream,
        stderr: stderr.stream,
      },
    );

    expect(stdout.getText()).toContain("OK");

    const { streamTextWithModelId } = await import("../src/llm/generate-text.js");
    const streamMock = streamTextWithModelId as unknown as ReturnType<typeof vi.fn>;
    expect(streamMock).toHaveBeenCalled();

    globalFetchSpy.mockRestore();
  });
});
