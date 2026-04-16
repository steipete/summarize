import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { runCli } from "../src/run.js";
import { makeAssistantMessage, makeTextDeltaStream } from "./helpers/pi-ai-mock.js";

function noopStream(): Writable {
  return new Writable({
    write(_chunk, _encoding, callback) {
      callback();
    },
  });
}

// Mock the extraction session to intercept the context/model
vi.mock("../src/run/flows/url/extraction-session.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/run/flows/url/extraction-session.js")>();
  return {
    ...actual,
    createUrlExtractionSession: (args: any) => {
      // Store the context so we can inspect it
      (globalThis as any).capturedUrlFlowContext = args.ctx;
      return actual.createUrlExtractionSession(args);
    },
  };
});

// Also mock pi-ai to avoid real LLM calls
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

mocks.completeSimple.mockResolvedValue(
  makeAssistantMessage({
    text: "Summary content.",
    usage: { input: 1, output: 1, totalTokens: 2 },
  }),
);

vi.mock("@mariozechner/pi-ai", () => ({
  streamSimple: mocks.streamSimple,
  completeSimple: mocks.completeSimple,
  getModel: mocks.getModel,
}));

describe("cli media API key mapping", () => {
  it("should correctly map OPENAI_API_KEY to openaiTranscriptionKey in UrlFlowModel", async () => {
    const root = mkdtempSync(join(tmpdir(), "summarize-media-key-url-integration-"));
    const summarizeDir = join(root, ".summarize");
    mkdirSync(summarizeDir, { recursive: true });

    // Mock LiteLLM catalog to avoid network calls
    const cacheDir = join(summarizeDir, "cache");
    mkdirSync(cacheDir, { recursive: true });
    writeFileSync(
      join(cacheDir, "litellm-model_prices_and_context_window.json"),
      JSON.stringify({ "gpt-4o-mini": { max_input_tokens: 128000 } }),
      "utf8",
    );
    writeFileSync(
      join(cacheDir, "litellm-model_prices_and_context_window.meta.json"),
      JSON.stringify({ fetchedAtMs: Date.now() }),
      "utf8",
    );

    const testKey = "test-openai-transcription-key";

    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : "url" in input ? input.url : input.toString();
      if (url === "https://example.com") {
        return new Response("<!doctype html><html><body>Hi</body></html>", {
          headers: { "Content-Type": "text/html" }
        });
      }
      throw new Error(`Unexpected fetch call: ${url}`);
    });

    await runCli(
      [
        "--model",
        "openai/gpt-4o-mini",
        "--metrics",
        "off",
        "https://example.com",
      ],
      {
        env: { 
          HOME: root, 
          OPENAI_API_KEY: testKey,
          PATH: process.env.PATH
        },
        fetch: fetchMock as unknown as typeof fetch,
        stdout: noopStream(),
        stderr: noopStream(),
      },
    );

    const capturedCtx = (globalThis as any).capturedUrlFlowContext;
    expect(capturedCtx, "UrlFlowContext should have been captured").toBeDefined();
    
    // THE FIX: This should now contain our key
    expect(capturedCtx.model.apiStatus.openaiTranscriptionKey).toBe(testKey);
  });
});
