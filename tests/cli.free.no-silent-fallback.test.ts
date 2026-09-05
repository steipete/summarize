import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { runCli } from "../src/run.js";
import { captureStream as collectStream } from "./helpers/streams.js";

vi.mock("../src/llm/generate-text.js", () => ({
  generateTextWithModelId: vi.fn(async () => {
    throw new Error("boom");
  }),
  streamTextWithModelId: vi.fn(async () => {
    throw new Error("boom");
  }),
}));

describe("model presets: no silent fallback", () => {
  it("throws instead of returning extracted text when the preset fails", async () => {
    const root = mkdtempSync(join(tmpdir(), "summarize-preset-no-fallback-"));
    const filePath = join(root, "input.txt");
    writeFileSync(filePath, "hello world", "utf8");
    mkdirSync(join(root, ".summarize"), { recursive: true });
    writeFileSync(
      join(root, ".summarize", "config.json"),
      JSON.stringify({
        models: {
          free: { mode: "auto", rules: [{ candidates: ["openai/gpt-5-mini"] }] },
        },
      }),
      "utf8",
    );

    const stdout = collectStream();
    const stderr = collectStream();

    await expect(
      runCli(["--model", "free", "--max-output-tokens", "500", "--plain", filePath], {
        env: { HOME: root, OPENAI_API_KEY: "test" },
        fetch: async () => {
          throw new Error("unexpected fetch");
        },
        stdout: stdout.stream,
        stderr: stderr.stream,
      }),
    ).rejects.toThrow(/boom/);

    expect(stdout.getText()).not.toContain("hello world");
    expect(stderr.getText()).not.toMatch(/\bvia\b/i);
  });
});
