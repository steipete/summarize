import type { ChildProcess } from "node:child_process";
import { writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { runCliModel } from "../src/llm/cli.js";

const CODEX_META_ONLY_STDOUT = [
  '{"type":"thread.started","thread_id":"019cd2c2-0645-7312-b7f2-f10a3d41eb5c"}',
  "2m 0s · 3.1k words · cli/codex/gpt-5.2",
].join("\n");

describe("llm/cli extra branches", () => {
  it("parses the last JSON object when stdout includes a preface", async () => {
    const result = await runCliModel({
      provider: "gemini",
      prompt: "hi",
      model: "gemini-2.0",
      allowTools: false,
      timeoutMs: 1000,
      env: {},
      config: null,
      execFileImpl: (_cmd, _args, _opts, cb) => {
        cb(
          null,
          [
            "some debug output",
            '{"result":"OK","stats":{"models":{"x":{"tokens":{"prompt":2,"candidates":3,"total":5}}}}}',
          ].join("\n"),
          "",
        );
        return { stdin: { write() {}, end() {} } } as unknown as ChildProcess;
      },
    });

    expect(result.text).toBe("OK");
    expect(result.usage?.promptTokens).toBe(2);
    expect(result.usage?.completionTokens).toBe(3);
    expect(result.usage?.totalTokens).toBe(5);
  });

  it("falls back to the last JSON object when the first looks like JSON but is invalid", async () => {
    const result = await runCliModel({
      provider: "claude",
      prompt: "hi",
      model: "claude-sonnet",
      allowTools: false,
      timeoutMs: 1000,
      env: {},
      config: null,
      execFileImpl: (_cmd, _args, _opts, cb) => {
        cb(
          null,
          [
            "{ this is not json",
            '{"result":"OK","usage":{"input_tokens":1,"output_tokens":2}}',
          ].join("\n"),
          "",
        );
        return { stdin: { write() {}, end() {} } } as unknown as ChildProcess;
      },
    });

    expect(result.text).toBe("OK");
    expect(result.usage?.promptTokens).toBe(1);
    expect(result.usage?.completionTokens).toBe(2);
    expect(result.usage?.totalTokens).toBe(3);
  });

  it("throws when Codex last-message is empty and stdout only contains session metadata", async () => {
    await expect(
      runCliModel({
        provider: "codex",
        prompt: "hi",
        model: "gpt-5.2",
        allowTools: false,
        timeoutMs: 1000,
        env: {},
        config: null,
        execFileImpl: (_cmd, args, _opts, cb) => {
          const outputIndex = args.indexOf("--output-last-message");
          const outputPath = outputIndex >= 0 ? args[outputIndex + 1] : null;
          if (!outputPath) throw new Error("missing output path");
          writeFileSync(outputPath, "   ", "utf8");
          cb(null, CODEX_META_ONLY_STDOUT, "");
          return { stdin: { write() {}, end() {} } } as unknown as ChildProcess;
        },
      }),
    ).rejects.toThrow(/stdout only contained session\/meta events/i);
  });

  it("throws when Codex last-message is missing and stdout only contains session metadata", async () => {
    await expect(
      runCliModel({
        provider: "codex",
        prompt: "hi",
        model: "gpt-5.2",
        allowTools: false,
        timeoutMs: 1000,
        env: {},
        config: null,
        execFileImpl: (_cmd, _args, _opts, cb) => {
          cb(null, CODEX_META_ONLY_STDOUT, "");
          return { stdin: { write() {}, end() {} } } as unknown as ChildProcess;
        },
      }),
    ).rejects.toThrow(/stdout only contained session\/meta events/i);
  });
});
