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
    let stdinText = "";
    const prompt = "summarize this image";

    const result = await runCliModel({
      provider: "codex",
      prompt,
      model: "gpt-5.2",
      allowTools: true,
      timeoutMs: 1000,
      env: {},
      config: null,
      extraArgs: ["-i", "/tmp/image-1.jpg", "/tmp/image-2.jpg"],
      execFileImpl: (_cmd, args, _opts, cb) => {
        seenArgs = [...args];
        const outputIndex = args.indexOf("--output-last-message");
        const outputPath = outputIndex >= 0 ? args[outputIndex + 1] : null;
        if (!outputPath) throw new Error("missing output path");
        writeFileSync(outputPath, "ok", "utf8");
        cb(null, "", "");
        return {
          stdin: {
            write(value: string) {
              stdinText += value;
            },
            end() {},
          },
        } as unknown as ChildProcess;
      },
    });

    const execIndex = seenArgs.indexOf("exec");
    const imageFlagIndex = seenArgs.indexOf("-i");
    const firstImageIndex = seenArgs.indexOf("/tmp/image-1.jpg");
    const secondImageIndex = seenArgs.indexOf("/tmp/image-2.jpg");
    const outputIndex = seenArgs.indexOf("--output-last-message");
    const modelIndex = seenArgs.indexOf("-m");
    const verbosityIndex = seenArgs.indexOf("-c");

    expect(result.text).toBe("ok");
    expect(execIndex).toBe(0);
    expect(imageFlagIndex).toBeGreaterThan(execIndex);
    expect(firstImageIndex).toBe(imageFlagIndex + 1);
    expect(secondImageIndex).toBe(firstImageIndex + 1);
    expect(outputIndex).toBeGreaterThan(secondImageIndex);
    expect(modelIndex).toBeGreaterThan(execIndex);
    expect(verbosityIndex).toBeGreaterThan(execIndex);
    expect(seenArgs).not.toContain(prompt);
    expect(stdinText).toBe(prompt);
  });

  it("keeps generated Codex flags under exec for non-image summaries", async () => {
    let seenArgs: string[] = [];

    const result = await runCliModel({
      provider: "codex",
      prompt: "summarize text",
      model: "gpt-fast",
      allowTools: false,
      timeoutMs: 1000,
      env: {},
      config: { codex: { extraArgs: ["--sandbox", "read-only"] } },
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

    const execIndex = seenArgs.indexOf("exec");

    expect(result.text).toBe("ok");
    expect(execIndex).toBe(0);
    expect(seenArgs).not.toContain("-i");
    for (const flag of [
      "--sandbox",
      "--ephemeral",
      "--ignore-user-config",
      "--ignore-rules",
      "-C",
      "--output-last-message",
      "--skip-git-repo-check",
      "--json",
      "-m",
      "-c",
    ]) {
      expect(seenArgs.indexOf(flag)).toBeGreaterThan(execIndex);
    }
    expect(seenArgs).toContain("gpt-5.5");
    expect(seenArgs).toContain('service_tier="fast"');
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
