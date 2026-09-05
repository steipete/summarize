import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runCli } from "../src/run.js";
import { captureStream as collectStream } from "./helpers/streams.js";

describe("--model auto no-model footer", () => {
  it("does not print a via footer when no extractor ran", async () => {
    const root = mkdtempSync(join(tmpdir(), "summarize-auto-no-model-"));
    const filePath = join(root, "input.txt");
    writeFileSync(filePath, "hello world", "utf8");

    const stdout = collectStream();
    const stderr = collectStream();

    await runCli(["--model", "auto", "--plain", filePath], {
      env: { HOME: root },
      fetch: async () => {
        throw new Error("unexpected fetch");
      },
      stdout: stdout.stream,
      stderr: stderr.stream,
    });

    expect(stdout.getText()).toContain("hello world");
    expect(stderr.getText()).not.toMatch(/\bvia\b/i);
  });
});
