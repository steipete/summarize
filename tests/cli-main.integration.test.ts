import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import { describe, expect, it } from "vitest";
import { runCliMain } from "../src/cli-main.js";

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

async function run(argv: string[]) {
  const stdout = collectStream();
  const stderr = collectStream();
  let exitCode: number | null = null;

  await runCliMain({
    argv,
    env: { HOME: mkdtempSync(join(tmpdir(), "summarize-cli-main-")) },
    fetch: globalThis.fetch.bind(globalThis),
    stdout: stdout.stream,
    stderr: stderr.stream,
    exit: () => {},
    setExitCode: (code) => {
      exitCode = code;
    },
  });

  return { stdout: stdout.getText(), stderr: stderr.getText(), exitCode };
}

describe("cli main integration", () => {
  it.each([
    [["--definitely-invalid"], "error: unknown option '--definitely-invalid'"],
    [["slides", "--definitely-invalid"], "error: unknown option '--definitely-invalid'"],
    [
      ["--preprocess", "on", "https://example.com"],
      "error: option '--preprocess <mode>' argument 'on' is invalid",
    ],
  ])("prints Commander errors once for %j", async (argv, expected) => {
    const result = await run(argv);

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe("");
    expect(
      result.stderr.match(new RegExp(expected.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g")),
    ).toHaveLength(1);
  });

  it.each([[[]], [["--verbose"]], [["--debug"]]])(
    "prints missing-input help only to stdout for %j",
    async (argv) => {
      const result = await run(argv);

      expect(result.exitCode).toBe(1);
      expect(result.stdout).toContain("Usage: summarize <input> [flags]");
      expect(result.stderr).toBe("");
    },
  );
});
