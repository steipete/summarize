import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { runCli } from "../src/run.js";
import { captureStream as collectStream } from "./helpers/streams.js";

const mocks = vi.hoisted(() => {
  const createLinkPreviewClient = vi.fn(() => {
    return {
      fetchLinkContent: vi.fn(async (url: string) => {
        return {
          url,
          title: "Example",
          description: null,
          siteName: null,
          content: "Hello world",
          truncated: false,
          totalCharacters: 11,
          wordCount: 2,
          transcriptCharacters: null,
          transcriptLines: null,
          transcriptWordCount: null,
          transcriptSource: null,
          transcriptionProvider: null,
          transcriptMetadata: null,
          transcriptSegments: null,
          transcriptTimedText: null,
          mediaDurationSeconds: null,
          video: null,
          isVideoOnly: false,
          diagnostics: {
            strategy: "html",
            cacheMode: "default",
            cacheStatus: "miss",
            firecrawl: { used: false },
            markdown: { used: false, provider: null },
            transcript: {
              cacheMode: "default",
              cacheStatus: "miss",
              textProvided: false,
              provider: null,
              attemptedProviders: [],
              notes: null,
            },
          },
        };
      }),
    };
  });

  const generateTextWithModelId = vi.fn();
  const streamTextWithModelId = vi.fn(async () => {
    throw new Error("unexpected streaming call");
  });

  return { createLinkPreviewClient, generateTextWithModelId, streamTextWithModelId };
});

vi.mock("../src/content/index.js", () => ({
  createLinkPreviewClient: mocks.createLinkPreviewClient,
}));

vi.mock("../src/llm/generate-text.js", () => ({
  generateTextWithModelId: mocks.generateTextWithModelId,
  streamTextWithModelId: mocks.streamTextWithModelId,
}));

describe("cli run.ts free preset error branches", () => {
  const setupLiteLlmCache = (root: string) => {
    const cacheDir = join(root, ".summarize", "cache");
    mkdirSync(cacheDir, { recursive: true });
    writeFileSync(
      join(cacheDir, "litellm-model_prices_and_context_window.json"),
      JSON.stringify({}),
      "utf8",
    );
    writeFileSync(
      join(cacheDir, "litellm-model_prices_and_context_window.meta.json"),
      JSON.stringify({ fetchedAtMs: Date.now() }),
      "utf8",
    );
  };

  it("throws lastError message when all free attempts fail with Error", async () => {
    const root = mkdtempSync(join(tmpdir(), "summarize-free-fail-"));
    setupLiteLlmCache(root);

    const globalFetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      throw new Error("unexpected network fetch");
    });

    mocks.generateTextWithModelId.mockImplementation(async () => {
      throw new Error("boom error");
    });

    const stdout = collectStream();
    const stderr = collectStream();

    await expect(
      runCli(["--model", "free", "--timeout", "2s", "https://example.com"], {
        env: { HOME: root, OPENROUTER_API_KEY: "test" },
        fetch: vi.fn() as unknown as typeof fetch,
        stdout: stdout.stream,
        stderr: stderr.stream,
      }),
    ).rejects.toThrow(/boom error/);

    globalFetchSpy.mockRestore();
  });

  it('throws a generic "no model available" when failures are non-Error throwables', async () => {
    const root = mkdtempSync(join(tmpdir(), "summarize-free-fail-"));
    setupLiteLlmCache(root);

    const globalFetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      throw new Error("unexpected network fetch");
    });

    mocks.generateTextWithModelId.mockImplementation(async () => {
      throw "boom string";
    });

    const stdout = collectStream();
    const stderr = collectStream();

    await expect(
      runCli(["--model", "free", "--timeout", "2s", "https://example.com"], {
        env: { HOME: root, OPENROUTER_API_KEY: "test" },
        fetch: vi.fn() as unknown as typeof fetch,
        stdout: stdout.stream,
        stderr: stderr.stream,
      }),
    ).rejects.toThrow(/No model available for --model free/i);

    globalFetchSpy.mockRestore();
  });
});
