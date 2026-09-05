import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runCli } from "../src/run.js";
import { captureStream as collectStream } from "./helpers/streams.js";

describe("cli run.ts validation branches", () => {
  it("rejects --markdown-mode without --format md", async () => {
    const stdout = collectStream();
    const stderr = collectStream();
    await expect(
      runCli(["--markdown-mode", "llm", "--timeout", "2s", "https://example.com"], {
        env: {},
        fetch: (() => {
          throw new Error("unexpected fetch");
        }) as unknown as typeof fetch,
        stdout: stdout.stream,
        stderr: stderr.stream,
      }),
    ).rejects.toThrow(/--markdown-mode is only supported with --format md/);
  });

  it("rejects --extract for local files", async () => {
    const root = mkdtempSync(join(tmpdir(), "summarize-extract-file-"));
    const filePath = join(root, "input.txt");
    writeFileSync(filePath, "hello", "utf8");

    const stdout = collectStream();
    const stderr = collectStream();
    await expect(
      runCli(["--extract", "--timeout", "2s", filePath], {
        env: {},
        fetch: (() => {
          throw new Error("unexpected fetch");
        }) as unknown as typeof fetch,
        stdout: stdout.stream,
        stderr: stderr.stream,
      }),
    ).rejects.toThrow(/--extract .*only supported/);
  });

  it("rejects unsupported --cli values", async () => {
    const stdout = collectStream();
    const stderr = collectStream();
    await expect(
      runCli(["--cli", "nope", "--timeout", "2s", "https://example.com"], {
        env: {},
        fetch: (() => {
          throw new Error("unexpected fetch");
        }) as unknown as typeof fetch,
        stdout: stdout.stream,
        stderr: stderr.stream,
      }),
    ).rejects.toThrow(/Unsupported --cli/);
  });
});
