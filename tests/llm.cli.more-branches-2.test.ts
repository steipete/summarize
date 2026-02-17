import type { ChildProcess } from "node:child_process";
import { writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { isCliDisabled, resolveCliBinary, runCliModel } from "../src/llm/cli.js";

describe("llm/cli more branches", () => {
  it("isCliDisabled respects cli.enabled allowlist", () => {
    expect(isCliDisabled("codex", { enabled: ["claude"] })).toBe(true);
    expect(isCliDisabled("codex", { enabled: ["codex"] })).toBe(false);
    expect(isCliDisabled("codex", null)).toBe(false);
  });

  it("resolveCliBinary prefers config binary, then env override, then defaults", () => {
    expect(
      resolveCliBinary(
        "codex",
        { codex: { binary: "  /usr/local/bin/codex  " } },
        { SUMMARIZE_CLI_CODEX: "codex-env" },
      ),
    ).toBe("/usr/local/bin/codex");

    expect(resolveCliBinary("gemini", null, { SUMMARIZE_CLI_GEMINI: " gemini-env " })).toBe(
      "gemini-env",
    );
    expect(resolveCliBinary("agent", null, { AGENT_PATH: " /tmp/agent-bin " })).toBe(
      "/tmp/agent-bin",
    );

    expect(resolveCliBinary("claude", null, {})).toBe("claude");
    expect(resolveCliBinary("agent", null, {})).toBe("agent");
  });

  it("includes stderr in exec error messages", async () => {
    await expect(
      runCliModel({
        provider: "gemini",
        prompt: "hi",
        model: "m",
        allowTools: false,
        timeoutMs: 1000,
        env: {},
        config: null,
        execFileImpl: (_cmd, _args, _opts, cb) => {
          const error = Object.assign(new Error("boom"), { code: 1 });
          cb(error as unknown as NodeJS.ErrnoException, "", "stderr details");
          return { stdin: { write() {}, end() {} } } as unknown as ChildProcess;
        },
      }),
    ).rejects.toThrow(/boom: stderr details/i);
  });

  it("does not duplicate stderr when exec error message already includes stderr", async () => {
    const error = await runCliModel({
      provider: "gemini",
      prompt: "hi",
      model: "m",
      allowTools: false,
      timeoutMs: 1000,
      env: {},
      config: null,
      execFileImpl: (_cmd, _args, _opts, cb) => {
        const stderrText = "stderr details";
        const error = Object.assign(new Error(`Command failed: gemini\n${stderrText}`), {
          code: 1,
        });
        cb(error as unknown as NodeJS.ErrnoException, "", stderrText);
        return { stdin: { write() {}, end() {} } } as unknown as ChildProcess;
      },
    }).catch((error: unknown) => error as Error);

    expect(error.message).toContain("stderr details");
    const occurrences = error.message.match(/stderr details/gi)?.length ?? 0;
    expect(occurrences).toBe(1);
  });

  it("formats timeout errors with duration and hint", async () => {
    const error = await runCliModel({
      provider: "gemini",
      prompt: "hi",
      model: "m",
      allowTools: false,
      timeoutMs: 2000,
      env: {},
      config: null,
      execFileImpl: (_cmd, _args, _opts, cb) => {
        const timeoutError = Object.assign(new Error("Command failed: gemini --prompt hi"), {
          code: "ETIMEDOUT",
          cmd: "gemini --prompt hi",
          killed: true,
          signal: "SIGTERM",
        });
        cb(
          timeoutError as unknown as NodeJS.ErrnoException,
          "",
          "Reading prompt from stdin...",
        );
        return { stdin: { write() {}, end() {} } } as unknown as ChildProcess;
      },
    }).catch((error: unknown) => error as Error);

    expect(error.message).toContain("timed out after 2s");
    expect(error.message).toContain("Increase --timeout");
    expect(error.message).toContain("Reading prompt from stdin...");
  });

  it("codex: uses last-message file when present, otherwise stdout fallback", async () => {
    // file present
    const resultFile = await runCliModel({
      provider: "codex",
      prompt: "hi",
      model: null,
      allowTools: false,
      timeoutMs: 1000,
      env: {},
      config: null,
      execFileImpl: (_cmd, args, _opts, cb) => {
        const outputIndex = args.indexOf("--output-last-message");
        const outputPath = outputIndex >= 0 ? args[outputIndex + 1] : null;
        if (!outputPath) throw new Error("missing output path");
        writeFileSync(outputPath, "FROM FILE", "utf8");
        cb(
          null,
          [
            '{"usage":{"input_tokens":1,"output_tokens":2,"total_tokens":3},"cost_usd":0.01}',
            '{"response":{"usage":{"prompt_tokens":4,"completion_tokens":5,"total_tokens":9}}}',
          ].join("\n"),
          "",
        );
        return { stdin: { write() {}, end() {} } } as unknown as ChildProcess;
      },
    });
    expect(resultFile.text).toBe("FROM FILE");
    expect(resultFile.usage?.promptTokens).toBe(4);
    expect(resultFile.costUsd).toBe(0.01);

    // stdout fallback when file is empty
    const resultStdout = await runCliModel({
      provider: "codex",
      prompt: "hi",
      model: null,
      allowTools: false,
      timeoutMs: 1000,
      env: {},
      config: null,
      execFileImpl: (_cmd, args, _opts, cb) => {
        const outputIndex = args.indexOf("--output-last-message");
        const outputPath = outputIndex >= 0 ? args[outputIndex + 1] : null;
        if (!outputPath) throw new Error("missing output path");
        writeFileSync(outputPath, "   ", "utf8");
        cb(null, "STDOUT", "");
        return { stdin: { write() {}, end() {} } } as unknown as ChildProcess;
      },
    });
    expect(resultStdout.text).toBe("STDOUT");
  });

  it("returns trimmed stdout when JSON payload has no usable result field", async () => {
    const result = await runCliModel({
      provider: "claude",
      prompt: "hi",
      model: "m",
      allowTools: false,
      timeoutMs: 1000,
      env: {},
      config: null,
      execFileImpl: (_cmd, _args, _opts, cb) => {
        cb(null, '{"foo":"bar"}', "");
        return { stdin: { write() {}, end() {} } } as unknown as ChildProcess;
      },
    });
    expect(result.text).toBe('{"foo":"bar"}');
    expect(result.usage).toBeNull();
  });
});
