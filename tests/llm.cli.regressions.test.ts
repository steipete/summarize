import type { ChildProcess } from "node:child_process";
import { writeFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { runCliModel } from "../src/llm/cli.js";
import type { ExecFileFn } from "../src/markitdown.js";

describe("runCliModel regressions", () => {
  it("passes OpenClaw prompts with --message for current OpenClaw CLI", async () => {
    const seenArgs: string[][] = [];
    const stdinWrites: string[] = [];
    const execFileImpl: ExecFileFn = ((_cmd, args, _opts, cb) => {
      seenArgs.push(args);
      cb?.(
        null,
        JSON.stringify({
          result: {
            payloads: [{ text: "hello from openclaw" }],
          },
        }),
        "",
      );
      return {
        stdin: {
          write(value: string) {
            stdinWrites.push(value);
          },
          end() {},
        },
      } as unknown as ChildProcess;
    }) as ExecFileFn;

    const prompt = "Large prompt body that should not become a CLI argument.";
    const result = await runCliModel({
      provider: "openclaw",
      prompt,
      model: "main",
      allowTools: false,
      timeoutMs: 1000,
      env: {},
      execFileImpl,
      config: null,
    });

    expect(result.text).toBe("hello from openclaw");
    expect(seenArgs[0]).toContain("-m");
    expect(seenArgs[0]).toContain(prompt);
    expect(seenArgs[0]).not.toContain("-");
    expect(stdinWrites.join("")).toBe("");
  });

  it("rejects oversized OpenClaw prompts before passing them through argv", async () => {
    const execFileImpl = vi.fn(((_cmd, _args, _opts, cb) => {
      cb?.(null, "", "");
      return { stdin: { write() {}, end() {} } } as unknown as ChildProcess;
    }) as ExecFileFn);

    await expect(
      runCliModel({
        provider: "openclaw",
        prompt: "x".repeat(121 * 1024),
        model: "main",
        allowTools: false,
        timeoutMs: 1000,
        env: {},
        execFileImpl,
        config: null,
      }),
    ).rejects.toThrow(/cannot safely receive large prompts over argv/);
    expect(execFileImpl).not.toHaveBeenCalled();
  });

  it("codex extracts assistant text from JSONL stdout when last-message is blank", async () => {
    const result = await runCliModel({
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
        cb(
          null,
          [
            '{"type":"thread.started","thread_id":"abc"}',
            '{"type":"response.output_text.delta","delta":"Hello"}',
            '{"type":"response.output_text.delta","delta":" world"}',
          ].join("\n"),
          "",
        );
        return { stdin: { write() {}, end() {} } } as unknown as ChildProcess;
      },
    });

    expect(result.text).toBe("Hello world");
  });

  it("passes Codex image args after exec so -i does not consume the subcommand", async () => {
    let seenArgs: string[] = [];

    const result = await runCliModel({
      provider: "codex",
      prompt: "summarize this image",
      model: "gpt-5.2",
      allowTools: true,
      timeoutMs: 1000,
      env: {},
      config: null,
      extraArgs: ["-i", "/tmp/image.jpg"],
      execFileImpl: (_cmd, args, _opts, cb) => {
        seenArgs = [...args];
        const outputIndex = args.indexOf("--output-last-message");
        const outputPath = outputIndex >= 0 ? args[outputIndex + 1] : null;
        if (!outputPath) throw new Error("missing output path");
        writeFileSync(outputPath, "ok", "utf8");
        cb(null, "", "");
        return { stdin: { write() {}, end() {} } } as unknown as ChildProcess;
      },
    });

    expect(result.text).toBe("ok");
    expect(seenArgs.indexOf("exec")).toBeLessThan(seenArgs.indexOf("-i"));
  });

  it("codex does not leak lifecycle JSONL when no assistant text was produced", async () => {
    await expect(
      runCliModel({
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
          cb(
            null,
            [
              '{"type":"thread.started","thread_id":"abc"}',
              '{"usage":{"input_tokens":1,"output_tokens":2,"total_tokens":3}}',
            ].join("\n"),
            "",
          );
          return { stdin: { write() {}, end() {} } } as unknown as ChildProcess;
        },
      }),
    ).rejects.toThrow("CLI returned empty output");
  });
});
