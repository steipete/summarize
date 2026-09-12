import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { runCli } from "../src/run.js";
import { captureStream as collectStream } from "./helpers/streams.js";

vi.mock("../src/llm/generate-text.js", () => ({
  generateTextWithModelId: vi.fn(async ({ modelId }: { modelId: string }) => {
    expect(modelId).toBe("openai/gpt-5-mini");
    return {
      provider: "openai",
      canonicalModelId: "openai/gpt-5-mini",
      usage: { promptTokens: 10, completionTokens: 10, totalTokens: 20 },
      text: "# Converted\n\nHello\n",
    };
  }),
}));

describe("cli --extract finish line includes model when LLM ran", () => {
  it("prints extraction label + model id when markdown conversion uses an LLM", async () => {
    const root = mkdtempSync(join(tmpdir(), "summarize-extract-llm-finish-line-"));
    const cacheDir = join(root, ".summarize", "cache");
    mkdirSync(cacheDir, { recursive: true });

    writeFileSync(
      join(cacheDir, "litellm-model_prices_and_context_window.json"),
      JSON.stringify({
        "gpt-5-mini": { input_cost_per_token: 0.000001, output_cost_per_token: 0.000001 },
      }),
      "utf8",
    );
    writeFileSync(
      join(cacheDir, "litellm-model_prices_and_context_window.meta.json"),
      JSON.stringify({ fetchedAtMs: Date.now() }),
      "utf8",
    );

    const globalFetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      throw new Error("unexpected LiteLLM catalog fetch");
    });

    const html =
      "<!doctype html><html><head><title>Ok</title></head>" +
      "<body><article><h1>Title</h1><p>Hello</p></article></body></html>";

    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.url;
      if (url === "https://example.com") {
        return new Response(html, { status: 200, headers: { "Content-Type": "text/html" } });
      }
      throw new Error(`Unexpected fetch call: ${url}`);
    });

    const stdout = collectStream();
    (stdout.stream as unknown as { isTTY?: boolean; columns?: number }).isTTY = true;
    (stdout.stream as unknown as { columns?: number }).columns = 80;
    const stderr = collectStream();

    await runCli(
      ["--extract", "--markdown-mode", "llm", "--plain", "--timeout", "2s", "https://example.com"],
      {
        env: { HOME: root, OPENAI_API_KEY: "test" },
        fetch: fetchMock as unknown as typeof fetch,
        stdout: stdout.stream,
        stderr: stderr.stream,
      },
    );

    expect(stdout.getText()).toContain("# Converted");
    const err = stderr.getText();
    expect(err).toContain("markdown via llm");
    expect(err).toContain("openai/gpt-5-mini");

    globalFetchSpy.mockRestore();
  });
});
