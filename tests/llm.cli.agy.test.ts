import fsSync from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import {
  estimateWindowsCommandChars,
  resolveAgyMaxPrintArgLimit,
} from "../src/llm/cli-runners/plain.js";
import { resolveCliBinary, runCliModel } from "../src/llm/cli.js";
import type { ExecFileFn } from "../src/markitdown.js";

const makeStub = (
  handler: (args: string[], input?: string) => { stdout?: string; stderr?: string },
) => {
  const execFileStub: ExecFileFn = ((_cmd, args, _options, cb) => {
    const result = handler(args);
    if (cb) cb(null, result.stdout ?? "", result.stderr ?? "");
    return {
      stdin: { write: (_chunk: unknown) => {}, end: () => {} },
    } as unknown as ReturnType<ExecFileFn>;
  }) as ExecFileFn;
  return execFileStub;
};

describe("runCliModel - agy provider", () => {
  it("uses a lower agy prompt argv limit on Windows", () => {
    expect(resolveAgyMaxPrintArgLimit("win32")).toEqual({ limit: 30_000, type: "chars" });
    expect(resolveAgyMaxPrintArgLimit("darwin")).toEqual({ limit: 120 * 1024, type: "bytes" });
    expect(resolveAgyMaxPrintArgLimit("linux")).toEqual({ limit: 120 * 1024, type: "bytes" });
  });

  it("accounts for Windows argv escaping overhead", () => {
    const plainPrompt = "x".repeat(20_000);
    const quoteHeavyPrompt = '"'.repeat(20_000);

    expect(estimateWindowsCommandChars(["agy", "--print", plainPrompt])).toBeLessThan(30_000);
    expect(estimateWindowsCommandChars(["agy", "--print", quoteHeavyPrompt])).toBeGreaterThan(
      30_000,
    );
    expect(estimateWindowsCommandChars(["agy", ""])).toBe("agy".length + 1 + 2);
    expect(estimateWindowsCommandChars(["agy", "C:\\Program Files\\agy\\"])).toBeGreaterThan(
      "agy C:\\Program Files\\agy\\".length,
    );
    expect(estimateWindowsCommandChars(["agy", 'say \\"hello"'])).toBeGreaterThan(
      'agy say \\"hello"'.length,
    );
    expect(estimateWindowsCommandChars(["agy", "--print", "😀 "])).toBe(
      "agy".length + 1 + "--print".length + 1 + 2 + "😀 ".length,
    );
  });

  it("invokes agy with --print prompt argument, returns plain text", async () => {
    let seenCmd = "";
    let seenCwd = "";
    let seenInput = "";
    const seen: string[][] = [];
    const execFileImpl: ExecFileFn = ((cmd, args, options, cb) => {
      seenCmd = String(cmd);
      seen.push(args);
      seenCwd = typeof options?.cwd === "string" ? options.cwd : "";
      cb?.(null, "  Hello from agy.  \n", "");
      return {
        stdin: {
          write: (chunk: unknown) => {
            seenInput += String(chunk);
          },
          end: () => {},
        },
      } as unknown as ReturnType<ExecFileFn>;
    }) as ExecFileFn;

    const result = await runCliModel({
      provider: "agy",
      prompt: "Summarize this.",
      model: null,
      allowTools: false,
      timeoutMs: 1000,
      env: {},
      execFileImpl,
      config: null,
      cwd: "/tmp/agy-original-cwd",
    });

    expect(result.text).toBe("Hello from agy.");
    expect(result.usage).toBeNull();
    expect(result.costUsd).toBeNull();
    expect(seenCmd).toBe("agy");
    const printIdx = seen[0].indexOf("--print");
    expect(printIdx).toBeGreaterThanOrEqual(0);
    const sentPrompt = seen[0][printIdx + 1];
    expect(sentPrompt).toContain("Summarize this.");
    expect(sentPrompt).toMatch(/do not create or edit files/i);
    expect(sentPrompt).toMatch(/do not include local file links or work-log narration/i);
    expect(sentPrompt).toMatch(/return only the final text response/i);
    expect(seen[0]).toContain("--sandbox");
    expect(seen[0]).toContain("--print-timeout");
    expect(seen[0]).toContain("1s");
    expect(seen[0]).not.toContain("--output-format");
    expect(seenCwd).toContain("summarize-agy-");
    expect(seenCwd).not.toBe("/tmp/agy-original-cwd");
    expect(seenInput).toBe("");
  });

  it("uses the active agy session model instead of passing --model", async () => {
    const seen: string[][] = [];
    const execFileImpl = makeStub((args) => {
      seen.push(args);
      return { stdout: "answer text" };
    });

    const result = await runCliModel({
      provider: "agy",
      prompt: "Q?",
      model: "Gemini 3.5 Flash (Medium)",
      allowTools: false,
      timeoutMs: 1000,
      env: {},
      execFileImpl,
      config: null,
    });

    expect(result.text).toBe("answer text");
    expect(seen[0]).toContain("--print");
    expect(seen[0]).not.toContain("--model");
    expect(seen[0]).not.toContain("Gemini 3.5 Flash (Medium)");
  });

  it("does not auto-approve agy tools when allowTools is true", async () => {
    const seen: string[][] = [];
    let seenCwd = "";
    const execFileImpl = makeStub((args) => {
      seen.push(args);
      return { stdout: "ok" };
    });
    const wrappedExecFileImpl: ExecFileFn = ((cmd, args, options, cb) => {
      seenCwd = typeof options?.cwd === "string" ? options.cwd : "";
      return execFileImpl(cmd, args, options, cb);
    }) as ExecFileFn;

    await runCliModel({
      provider: "agy",
      prompt: "Q",
      model: null,
      allowTools: true,
      timeoutMs: 1000,
      env: {},
      execFileImpl: wrappedExecFileImpl,
      config: null,
      cwd: "/tmp/agy-tools-cwd",
    });

    expect(seen[0]).not.toContain("--dangerously-skip-permissions");
    expect(seen[0]).not.toContain("--sandbox");
    expect(seenCwd).toBe("/tmp/agy-tools-cwd");
  });

  it("passes summarize timeout to agy unless extra args override it", async () => {
    const seen: string[][] = [];
    const execFileImpl = makeStub((args) => {
      seen.push(args);
      return { stdout: "ok" };
    });

    await runCliModel({
      provider: "agy",
      prompt: "Q",
      model: null,
      allowTools: false,
      timeoutMs: 125_000,
      env: {},
      execFileImpl,
      config: null,
    });
    expect(seen[0]).toContain("--print-timeout");
    expect(seen[0]).toContain("125s");

    await runCliModel({
      provider: "agy",
      prompt: "Q",
      model: null,
      allowTools: false,
      timeoutMs: 125_000,
      env: {},
      execFileImpl,
      config: { agy: { extraArgs: ["--print-timeout=10m"] } },
    });
    expect(seen[1]?.filter((arg) => arg.startsWith("--print-timeout"))).toEqual([
      "--print-timeout=10m",
    ]);

    await runCliModel({
      provider: "agy",
      prompt: "Q",
      model: null,
      allowTools: false,
      timeoutMs: 125_000,
      env: {},
      execFileImpl,
      config: { agy: { extraArgs: ["-print-timeout=10m"] } },
    });
    expect(seen[2]?.filter((arg) => arg.includes("print-timeout"))).toEqual(["-print-timeout=10m"]);
  });

  it("does not treat prompt text as an agy timeout override", async () => {
    const seen: string[][] = [];
    const execFileImpl = makeStub((args) => {
      seen.push(args);
      return { stdout: "ok" };
    });

    await runCliModel({
      provider: "agy",
      prompt: "--print-timeout should be summarized",
      model: null,
      allowTools: false,
      timeoutMs: 90_000,
      env: {},
      execFileImpl,
      config: null,
    });

    const args = seen[0];
    expect(args).toContain("--print-timeout");
    expect(args).toContain("90s");
    const timeoutIdx = args.indexOf("--print-timeout");
    const printIdx = args.indexOf("--print");
    expect(timeoutIdx).toBeGreaterThanOrEqual(0);
    expect(printIdx).toBeGreaterThan(timeoutIdx);
    expect(args[printIdx + 1]).toContain("--print-timeout should be summarized");
  });

  it("redacts the agy prompt from timeout errors", async () => {
    const prompt = "super secret page content";
    const execFileImpl: ExecFileFn = ((cmd, args, _options, cb) => {
      cb?.(
        Object.assign(new Error("timed out"), {
          code: "ETIMEDOUT",
          cmd: [cmd, ...args].join(" "),
        }),
        "",
        "",
      );
      return {
        stdin: { write: () => {}, end: () => {} },
      } as unknown as ReturnType<ExecFileFn>;
    }) as ExecFileFn;

    const promise = runCliModel({
      provider: "agy",
      prompt,
      model: null,
      allowTools: false,
      timeoutMs: 1000,
      env: {},
      execFileImpl,
      config: null,
    });

    const error = await promise.catch((value: unknown) => value);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toMatch(/agy .*--print \[prompt redacted\]/);
    expect((error as Error).message).not.toContain(prompt);
    expect((error as Error & { cause?: unknown }).cause).toBeUndefined();
  });

  it("redacts the agy prompt from non-timeout errors", async () => {
    const prompt = "super secret page content";
    const transformedPromptExcerpt = "super\\nsecret";
    const execFileImpl: ExecFileFn = ((cmd, args, _options, cb) => {
      cb?.(
        Object.assign(new Error(`Command failed: ${[cmd, ...args].join(" ")}`), {
          code: 1,
        }),
        "",
        `stderr includes transformed prompt text: ${transformedPromptExcerpt}`,
      );
      return {
        stdin: { write: () => {}, end: () => {} },
      } as unknown as ReturnType<ExecFileFn>;
    }) as ExecFileFn;

    const promise = runCliModel({
      provider: "agy",
      prompt,
      model: null,
      allowTools: false,
      timeoutMs: 1000,
      env: {},
      execFileImpl,
      config: null,
    });

    const error = await promise.catch((value: unknown) => value);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toMatch(
      /CLI command failed: agy .*--print \[prompt redacted\]/,
    );
    expect((error as Error).message).not.toContain(prompt);
    expect((error as Error).message).not.toContain(transformedPromptExcerpt);
    expect((error as Error & { cause?: unknown }).cause).toBeUndefined();
  });

  it("offloads oversized agy prompts (>120 KB) to a temp file with file:// reference", async () => {
    let seenArgs: string[] = [];
    let seenCwd = "";
    const largePrompt = "A".repeat(resolveAgyMaxPrintArgLimit().limit + 100);
    const execFileImpl: ExecFileFn = ((_cmd, args, options, cb) => {
      seenArgs = args as string[];
      seenCwd = typeof options?.cwd === "string" ? options.cwd : "";
      cb?.(null, "Summary of large prompt", "");
      return {
        stdin: { write: () => {}, end: () => {} },
      } as unknown as ReturnType<ExecFileFn>;
    }) as ExecFileFn;

    const result = await runCliModel({
      provider: "agy",
      prompt: largePrompt,
      model: null,
      allowTools: false,
      timeoutMs: 1000,
      env: {},
      execFileImpl,
      config: null,
    });

    expect(result.text).toBe("Summary of large prompt");
    const printIdx = seenArgs.indexOf("--print");
    expect(printIdx).toBeGreaterThanOrEqual(0);
    const printVal = seenArgs[printIdx + 1];
    expect(printVal).toMatch(/^Summarize the content in file:\/\/\/.+\/document\.txt/);
    expect(seenCwd).toContain("summarize-agy-");
  });

  it("writes prompt file with mode 0o600 and cleans up prompt directory afterwards", async () => {
    let promptFilePath = "";
    let fileContentReadDuringExec = "";
    let fileStatModeDuringExec = 0;

    const largePrompt = "B".repeat(150 * 1024);
    const execFileImpl: ExecFileFn = ((_cmd, args, _options, cb) => {
      const printIdx = args.indexOf("--print");
      const printVal = args[printIdx + 1];
      const match = printVal.match(/^Summarize the content in (file:\/\/.+?\bdocument\.txt)/);
      if (match) {
        promptFilePath = fileURLToPath(match[1]);
        fileContentReadDuringExec = fsSync.readFileSync(promptFilePath, "utf-8");
        fileStatModeDuringExec = fsSync.statSync(promptFilePath).mode & 0o777;
      }
      cb?.(null, "ok", "");
      return { stdin: { write: () => {}, end: () => {} } } as unknown as ReturnType<ExecFileFn>;
    }) as ExecFileFn;

    await runCliModel({
      provider: "agy",
      prompt: largePrompt,
      model: null,
      allowTools: false,
      timeoutMs: 1000,
      env: {},
      execFileImpl,
      config: null,
    });

    expect(fileContentReadDuringExec).toBe(largePrompt);
    expect(fileStatModeDuringExec).toBe(0o600);
    expect(fsSync.existsSync(promptFilePath)).toBe(false);
  });

  it("cleans up temp prompt file directory even when agy command fails", async () => {
    let promptFilePath = "";
    const largePrompt = "C".repeat(150 * 1024);
    const execFileImpl: ExecFileFn = ((_cmd, args, _options, cb) => {
      const printIdx = args.indexOf("--print");
      const printVal = args[printIdx + 1];
      const match = printVal.match(/^Summarize the content in (file:\/\/.+?\bdocument\.txt)/);
      if (match) {
        promptFilePath = fileURLToPath(match[1]);
      }
      cb?.(new Error("agy execution failed"), "", "");
      return { stdin: { write: () => {}, end: () => {} } } as unknown as ReturnType<ExecFileFn>;
    }) as ExecFileFn;

    await expect(
      runCliModel({
        provider: "agy",
        prompt: largePrompt,
        model: null,
        allowTools: false,
        timeoutMs: 1000,
        env: {},
        execFileImpl,
        config: null,
      }),
    ).rejects.toThrow();

    expect(promptFilePath).not.toBe("");
    expect(fsSync.existsSync(promptFilePath)).toBe(false);
  });

  it("offloads large agy prompts to system temp dir when allowTools is true", async () => {
    let promptFilePath = "";
    const largePrompt = "D".repeat(150 * 1024);
    const execFileImpl: ExecFileFn = ((_cmd, args, _options, cb) => {
      const printIdx = args.indexOf("--print");
      const printVal = args[printIdx + 1];
      const match = printVal.match(/^Summarize the content in (file:\/\/.+?\bdocument\.txt)/);
      if (match) {
        promptFilePath = fileURLToPath(match[1]);
      }
      cb?.(null, "ok", "");
      return { stdin: { write: () => {}, end: () => {} } } as unknown as ReturnType<ExecFileFn>;
    }) as ExecFileFn;

    await runCliModel({
      provider: "agy",
      prompt: largePrompt,
      model: null,
      allowTools: true,
      timeoutMs: 1000,
      env: {},
      execFileImpl,
      config: null,
    });

    expect(promptFilePath).toContain("summarize-agy-prompt-");
    expect(fsSync.existsSync(promptFilePath)).toBe(false);
  });

  it("throws limit error if extraArgs alone exceed command limit after offload", async () => {
    const execFileImpl = vi.fn() as unknown as ExecFileFn;
    const hugeExtraArgs = ["--extra-flag=" + "x".repeat(150 * 1024)];
    const largePrompt = "E".repeat(150 * 1024);

    await expect(
      runCliModel({
        provider: "agy",
        prompt: largePrompt,
        model: null,
        allowTools: false,
        timeoutMs: 1000,
        env: {},
        execFileImpl,
        config: { agy: { extraArgs: hugeExtraArgs } },
      }),
    ).rejects.toThrow(/cannot safely receive large command arguments over argv/);
    expect(execFileImpl).not.toHaveBeenCalled();
  });

  it("rejects NUL-containing agy prompts before passing them through argv", async () => {
    const execFileImpl = vi.fn() as unknown as ExecFileFn;

    await expect(
      runCliModel({
        provider: "agy",
        prompt: "private\0content",
        model: null,
        allowTools: false,
        timeoutMs: 1000,
        env: {},
        execFileImpl,
        config: null,
      }),
    ).rejects.toThrow(/cannot receive prompts containing NUL characters/);
    expect(execFileImpl).not.toHaveBeenCalled();
  });

  it("throws when agy returns empty output", async () => {
    const execFileImpl = makeStub(() => ({ stdout: "  \n" }));
    await expect(
      runCliModel({
        provider: "agy",
        prompt: "Q",
        model: null,
        allowTools: false,
        timeoutMs: 1000,
        env: {},
        execFileImpl,
        config: null,
      }),
    ).rejects.toThrow(/empty output/);
  });

  it("respects AGY_PATH and config-provided binary/extraArgs", async () => {
    expect(resolveCliBinary("agy", null, { AGY_PATH: "/custom/agy" })).toBe("/custom/agy");
    expect(resolveCliBinary("agy", { agy: { binary: "/cfg/agy" } }, {})).toBe("/cfg/agy");
    expect(resolveCliBinary("agy", null, {})).toBe("agy");

    const seen: string[][] = [];
    const execFileImpl = makeStub((args) => {
      seen.push(args);
      return { stdout: "ok" };
    });
    await runCliModel({
      provider: "agy",
      prompt: "Q",
      model: null,
      allowTools: false,
      timeoutMs: 1000,
      env: {},
      execFileImpl,
      config: { agy: { extraArgs: ["--no-color"] } },
    });
    expect(seen[0]?.[0]).toBe("--no-color");
  });
});
