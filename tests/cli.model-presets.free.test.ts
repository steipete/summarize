import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { runCli } from "../src/run.js";
import { captureStream as collectStream } from "./helpers/streams.js";

vi.mock("../src/llm/generate-text.js", () => ({
  generateTextWithModelId: vi.fn(async () => ({ text: "OK" })),
  streamTextWithModelId: vi.fn(async () => {
    throw new Error("unexpected stream call");
  }),
}));

describe("model presets: free", () => {
  it('errors for unknown preset names (no "/")', async () => {
    const root = mkdtempSync(join(tmpdir(), "summarize-preset-unknown-"));
    mkdirSync(join(root, ".summarize"), { recursive: true });

    await expect(
      runCli(["--model", "foobar", "--timeout", "2s", "https://example.com"], {
        env: { HOME: root },
        fetch: vi.fn(
          async () => new Response("<html></html>", { status: 200 }),
        ) as unknown as typeof fetch,
        stdout: collectStream().stream,
        stderr: collectStream().stream,
      }),
    ).rejects.toThrow(/Unknown model "foobar".*under "models"/);
  });

  it("adds a refresh-free tip when --model free fails", async () => {
    const { generateTextWithModelId } = await import("../src/llm/generate-text.js");
    const generateMock = generateTextWithModelId as unknown as ReturnType<typeof vi.fn>;
    generateMock.mockReset().mockImplementation(() => {
      throw new Error("boom");
    });

    const root = mkdtempSync(join(tmpdir(), "summarize-preset-free-tip-"));
    const filePath = join(root, "input.txt");
    writeFileSync(filePath, "hello world", "utf8");

    const stdout = collectStream();
    const stderr = collectStream();

    await expect(
      runCli(["--model", "free", "--max-output-tokens", "500", "--plain", filePath], {
        env: { HOME: root, OPENROUTER_API_KEY: "test" },
        fetch: async () => {
          throw new Error("unexpected fetch");
        },
        stdout: stdout.stream,
        stderr: stderr.stream,
      }),
    ).rejects.toThrow(/boom[\s\S]*summarize refresh-free/i);
  });

  it("lets config override the built-in free preset", async () => {
    const { generateTextWithModelId } = await import("../src/llm/generate-text.js");
    const generateMock = generateTextWithModelId as unknown as ReturnType<typeof vi.fn>;
    generateMock.mockReset().mockResolvedValue({ text: "OK" });

    const root = mkdtempSync(join(tmpdir(), "summarize-preset-free-override-"));
    const filePath = join(root, "input.txt");
    writeFileSync(filePath, "hello world", "utf8");
    mkdirSync(join(root, ".summarize"), { recursive: true });
    writeFileSync(
      join(root, ".summarize", "config.json"),
      JSON.stringify({
        models: {
          free: { mode: "auto", rules: [{ candidates: ["openai/gpt-5.2"] }] },
        },
      }),
      "utf8",
    );

    const stdout = collectStream();
    const stderr = collectStream();

    await runCli(["--model", "free", "--max-output-tokens", "500", "--plain", filePath], {
      env: { HOME: root, OPENAI_API_KEY: "test" },
      fetch: async () => {
        throw new Error("unexpected fetch");
      },
      stdout: stdout.stream,
      stderr: stderr.stream,
    });

    expect(generateMock).toHaveBeenCalled();
    const first = generateMock.mock.calls[0]?.[0] as { modelId?: unknown } | undefined;
    expect(first?.modelId).toBe("openai/gpt-5.2");
  });
});
