import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { runCli } from "../src/run.js";
import { captureStream as collectStream } from "./helpers/streams.js";

const mocks = vi.hoisted(() => ({
  weakFails: false,
  generateTextWithModelId: vi.fn(),
  streamTextWithModelId: vi.fn(),
}));

vi.mock("../src/llm/generate-text.js", () => ({
  generateTextWithModelId: mocks.generateTextWithModelId,
  streamTextWithModelId: mocks.streamTextWithModelId,
}));

describe("auto preset summary cache", () => {
  it("prefers the preset-level cached winner over older per-candidate cache entries", async () => {
    mocks.generateTextWithModelId.mockReset();
    mocks.streamTextWithModelId.mockReset();
    mocks.streamTextWithModelId.mockImplementation(() => {
      throw new Error("unexpected streaming call");
    });
    mocks.generateTextWithModelId.mockImplementation(async ({ modelId }: { modelId: string }) => {
      if (modelId === "openai/gpt-4.1") {
        if (mocks.weakFails) throw new Error("weak model failed");
        return { text: "Weak summary." };
      }
      if (modelId === "openai/gpt-5.2") {
        return { text: "Good summary." };
      }
      throw new Error(`unexpected model id: ${modelId}`);
    });

    const root = mkdtempSync(join(tmpdir(), "summarize-auto-preset-cache-"));
    const summarizeDir = join(root, ".summarize");
    const cacheDir = join(summarizeDir, "cache");
    mkdirSync(cacheDir, { recursive: true });

    writeFileSync(
      join(summarizeDir, "config.json"),
      JSON.stringify({
        cache: { enabled: true, maxMb: 32, ttlDays: 30 },
        models: {
          best: {
            mode: "auto",
            rules: [{ candidates: ["openai/gpt-4.1", "openai/gpt-5.2"] }],
          },
        },
      }),
      "utf8",
    );
    writeFileSync(
      join(cacheDir, "litellm-model_prices_and_context_window.json"),
      JSON.stringify({
        "gpt-4.1": { max_input_tokens: 999_999 },
        "gpt-5.2": { max_input_tokens: 999_999 },
      }),
      "utf8",
    );
    writeFileSync(
      join(cacheDir, "litellm-model_prices_and_context_window.meta.json"),
      JSON.stringify({ fetchedAtMs: Date.now() }),
      "utf8",
    );

    const filePath = join(root, "input.txt");
    writeFileSync(filePath, "Hello from cache regression.\n", "utf8");

    const run = async (model: string) => {
      const stdout = collectStream();
      const stderr = collectStream();
      await runCli(["--model", model, "--stream", "off", "--plain", filePath], {
        env: { HOME: root, OPENAI_API_KEY: "test" },
        fetch: async () => {
          throw new Error("unexpected fetch");
        },
        stdout: stdout.stream,
        stderr: stderr.stream,
      });
      return stdout.getText();
    };

    mocks.weakFails = true;
    const first = await run("best");
    expect(first).toContain("Good summary.");

    mocks.weakFails = false;
    const weak = await run("openai/gpt-4.1");
    expect(weak).toContain("Weak summary.");

    const second = await run("best");
    expect(second).toContain("Good summary.");
    expect(second).not.toContain("Weak summary.");
  });
});
