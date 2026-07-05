import { Writable } from "node:stream";
import { describe, expect, it } from "vitest";
import { runCli } from "../src/run.js";

const collectStream = () => {
  let text = "";
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      text += chunk.toString();
      callback();
    },
  });
  return { stream, getText: () => text };
};

describe("--help output", () => {
  it("prints examples without ANSI when not a TTY", async () => {
    const stdout = collectStream();
    const stderr = collectStream();

    await runCli(["--help"], {
      env: { TERM: "xterm-256color" },
      fetch: globalThis.fetch.bind(globalThis),
      stdout: stdout.stream,
      stderr: stderr.stream,
    });

    const out = stdout.getText();
    expect(out).toContain("Examples");
    expect(out).toContain('summarize "https://example.com"');
    expect(out).toContain("--embedded-video <mode>");
    expect(out).toContain("Local transcription stage");
    expect(out).toMatch(/Groq still runs\s+first when keyed/);
    expect(out).not.toContain("Audio transcription backend");
    expect(out).toContain("default: long");
    expect(out).not.toContain("\u001b[");
  });

  it("uses ANSI color when stdout is a rich TTY", async () => {
    const stdout = collectStream();
    const stderr = collectStream();
    (stdout.stream as unknown as { isTTY?: boolean }).isTTY = true;

    await runCli(["--help"], {
      env: { TERM: "xterm-256color" },
      fetch: globalThis.fetch.bind(globalThis),
      stdout: stdout.stream,
      stderr: stderr.stream,
    });

    const out = stdout.getText();
    expect(out).toContain("Examples");
    expect(out).toContain('summarize "https://example.com"');
    expect(out).toContain("Env Vars");
  });

  it("prints refresh-free options supported by the CLI parser", async () => {
    const stdout = collectStream();
    const stderr = collectStream();

    await runCli(["refresh-free", "--help"], {
      env: {},
      fetch: globalThis.fetch.bind(globalThis),
      stdout: stdout.stream,
      stderr: stderr.stream,
    });

    const out = stdout.getText();
    expect(out).toContain("Usage: summarize refresh-free");
    expect(out).toContain("--max-age-days 180");
    expect(out).toContain("--set-default");
    expect(stderr.getText()).toBe("");
  });
});
