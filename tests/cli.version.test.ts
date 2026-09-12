import fs, { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runCli } from "../src/run.js";
import { captureStream as collectStream } from "./helpers/streams.js";

describe("cli --version", () => {
  it("prints package.json version", async () => {
    const pkg = JSON.parse(fs.readFileSync("package.json", "utf8")) as { version: string };
    const stdout = collectStream();
    const stderr = collectStream();

    await runCli(["--version"], {
      env: {},
      fetch: globalThis.fetch.bind(globalThis),
      stdout: stdout.stream,
      stderr: stderr.stream,
    });

    expect(stdout.getText()).toContain(pkg.version);
    expect(stderr.getText()).toBe("");
  });

  it("does not use the caller cwd git SHA", async () => {
    const previousCwd = process.cwd();
    const root = fs.mkdtempSync(join(tmpdir(), "summarize-version-cwd-"));
    mkdirSync(join(root, ".git"));
    writeFileSync(join(root, ".git", "HEAD"), "1234567890abcdef1234567890abcdef12345678\n");

    const stdout = collectStream();
    const stderr = collectStream();
    try {
      process.chdir(root);
      await runCli(["--version"], {
        env: {},
        fetch: globalThis.fetch.bind(globalThis),
        stdout: stdout.stream,
        stderr: stderr.stream,
      });
    } finally {
      process.chdir(previousCwd);
      rmSync(root, { recursive: true, force: true });
    }

    expect(stdout.getText()).not.toContain("12345678");
    expect(stderr.getText()).toBe("");
  });
});
