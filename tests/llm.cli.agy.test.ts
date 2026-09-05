import fsSync from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import {
  AGY_NO_TOOLS_GUIDANCE,
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
    expect(printVal).toMatch(/Summarize the content in file:\/\/\/.+\/document\.txt/);
    expect(seenCwd).toContain("summarize-agy-");
  });

  it("splits XML-tagged prompt payload into document.txt while retaining instructions in --print", async () => {
    let sentPrintArg = "";
    let fileContentRead = "";
    const instructions =
      "<instructions>\nSummarize carefully.\n</instructions>\n\n<context>\nFilename: test.txt\n</context>";
    const largeContent = "<content>\n" + "X".repeat(150 * 1024) + "\n</content>";
    const fullTaggedPrompt = `${instructions}\n\n${largeContent}`;

    const execFileImpl: ExecFileFn = ((_cmd, args, _options, cb) => {
      const printIdx = args.indexOf("--print");
      sentPrintArg = args[printIdx + 1];
      const match = sentPrintArg.match(/file:\/\/.+?\bdocument\.txt/);
      if (match) {
        fileContentRead = fsSync.readFileSync(fileURLToPath(match[0]), "utf-8");
      }
      cb?.(null, "Summary of tagged content", "");
      return { stdin: { write: () => {}, end: () => {} } } as unknown as ReturnType<ExecFileFn>;
    }) as ExecFileFn;

    const result = await runCliModel({
      provider: "agy",
      prompt: fullTaggedPrompt,
      model: null,
      allowTools: false,
      timeoutMs: 1000,
      env: {},
      execFileImpl,
      config: null,
    });

    expect(result.text).toBe("Summary of tagged content");
    // Verify that instructions are retained in the --print argument
    expect(sentPrintArg).toContain("<instructions>\nSummarize carefully.\n</instructions>");
    expect(sentPrintArg).toContain("<context>\nFilename: test.txt\n</context>");
    expect(sentPrintArg).toMatch(/Summarize the content in file:\/\/\/.+\/document\.txt/);
    // Verify that only the <content> payload is written to the file
    expect(fileContentRead).toBe(largeContent);
    expect(fileContentRead).not.toContain("<instructions>");
  });

  it("anchors XML content match to final <content> block when instructions contain literal <content> examples", async () => {
    let sentPrintArg = "";
    let fileContentRead = "";
    const instructionsWithLiteralContent =
      "<instructions>\nRefer to the <content> tag below when summarizing.\n</instructions>\n\n<context>\nExample tag: <content>example</content>\n</context>";
    const largeContent = "<content>\n" + "REAL_PAYLOAD_".repeat(10 * 1024) + "\n</content>";
    const fullTaggedPrompt = `${instructionsWithLiteralContent}\n\n${largeContent}`;

    const execFileImpl: ExecFileFn = ((_cmd, args, _options, cb) => {
      const printIdx = args.indexOf("--print");
      sentPrintArg = args[printIdx + 1];
      const match = sentPrintArg.match(/file:\/\/.+?\bdocument\.txt/);
      if (match) {
        fileContentRead = fsSync.readFileSync(fileURLToPath(match[0]), "utf-8");
      }
      cb?.(null, "Summary of real payload", "");
      return { stdin: { write: () => {}, end: () => {} } } as unknown as ReturnType<ExecFileFn>;
    }) as ExecFileFn;

    const result = await runCliModel({
      provider: "agy",
      prompt: fullTaggedPrompt,
      model: null,
      allowTools: false,
      timeoutMs: 1000,
      env: {},
      execFileImpl,
      config: null,
    });

    expect(result.text).toBe("Summary of real payload");
    expect(sentPrintArg).toContain("Refer to the <content> tag below");
    expect(sentPrintArg).toContain("Example tag: <content>example</content>");
    expect(fileContentRead).toBe(largeContent);
    expect(fileContentRead).not.toContain("Refer to the <content> tag");
  });

  it("preserves instructions both before and after </content> block when offloading to temp file", async () => {
    let sentPrintArg = "";
    let fileContentRead = "";
    const prefixInstructions = "<instructions>\nHeader instruction\n</instructions>";
    const largeContent = "<content>\n" + "PAYLOAD_CONTENT_".repeat(10 * 1024) + "\n</content>";
    const suffixInstructions = "IMPORTANT_FOOTER: Follow formatting strictly.";
    const fullPrompt = `${prefixInstructions}\n\n${largeContent}\n\n${suffixInstructions}`;

    const execFileImpl: ExecFileFn = ((_cmd, args, _options, cb) => {
      const printIdx = args.indexOf("--print");
      sentPrintArg = args[printIdx + 1];
      const match = sentPrintArg.match(/file:\/\/.+?\bdocument\.txt/);
      if (match) {
        fileContentRead = fsSync.readFileSync(fileURLToPath(match[0]), "utf-8");
      }
      cb?.(null, "Summary of full prompt", "");
      return { stdin: { write: () => {}, end: () => {} } } as unknown as ReturnType<ExecFileFn>;
    }) as ExecFileFn;

    const result = await runCliModel({
      provider: "agy",
      prompt: fullPrompt,
      model: null,
      allowTools: false,
      timeoutMs: 1000,
      env: {},
      execFileImpl,
      config: null,
    });

    expect(result.text).toBe("Summary of full prompt");
    expect(sentPrintArg).toContain("Header instruction");
    expect(sentPrintArg).toContain("IMPORTANT_FOOTER: Follow formatting strictly.");
    expect(sentPrintArg).toMatch(/Summarize the content in file:\/\/\/.+\/document\.txt/);
    expect(fileContentRead).toBe(largeContent);
    expect(fileContentRead).not.toContain("Header instruction");
    expect(fileContentRead).not.toContain("IMPORTANT_FOOTER");
  });

  it("correctly extracts XML content block without index shift when prompt contains UTF-16 length-changing characters", async () => {
    let sentPrintArg = "";
    let fileContentRead = "";
    // Dotted capital I (İ, U+0130) expands to two chars (i + combining dot) when lowercased
    const unicodeInstructions = "<instructions>\nTurkish characters: İİİİİİİİİİ\n</instructions>";
    const largeContent = "<content>\n" + "UNICODE_PAYLOAD_".repeat(10 * 1024) + "\n</content>";
    const fullPrompt = `${unicodeInstructions}\n\n${largeContent}`;

    const execFileImpl: ExecFileFn = ((_cmd, args, _options, cb) => {
      const printIdx = args.indexOf("--print");
      sentPrintArg = args[printIdx + 1];
      const match = sentPrintArg.match(/file:\/\/.+?\bdocument\.txt/);
      if (match) {
        fileContentRead = fsSync.readFileSync(fileURLToPath(match[0]), "utf-8");
      }
      cb?.(null, "Summary of unicode payload", "");
      return { stdin: { write: () => {}, end: () => {} } } as unknown as ReturnType<ExecFileFn>;
    }) as ExecFileFn;

    const result = await runCliModel({
      provider: "agy",
      prompt: fullPrompt,
      model: null,
      allowTools: false,
      timeoutMs: 1000,
      env: {},
      execFileImpl,
      config: null,
    });

    expect(result.text).toBe("Summary of unicode payload");
    expect(sentPrintArg).toContain("Turkish characters: İİİİİİİİİİ");
    expect(fileContentRead).toBe(largeContent);
    expect(fileContentRead).not.toContain("Turkish characters");
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

  it("triggers offload when --print-timeout pushes command length over limit", async () => {
    let seenArgs: string[] = [];
    const execFileImpl: ExecFileFn = ((_cmd, args, _options, cb) => {
      seenArgs = args as string[];
      cb?.(null, "ok", "");
      return { stdin: { write: () => {}, end: () => {} } } as unknown as ReturnType<ExecFileFn>;
    }) as ExecFileFn;

    const limit = resolveAgyMaxPrintArgLimit().limit;
    const baseOverhead =
      "agy".length +
      1 +
      "--sandbox".length +
      1 +
      "--print".length +
      1 +
      AGY_NO_TOOLS_GUIDANCE.length;
    const promptLength = limit - baseOverhead - 10;
    const nearLimitPrompt = "P".repeat(promptLength);

    // 1. Without timeout: command fits within limit without offload
    await runCliModel({
      provider: "agy",
      prompt: nearLimitPrompt,
      model: null,
      allowTools: false,
      timeoutMs: 0,
      env: {},
      execFileImpl,
      config: null,
    });
    expect(seenArgs).not.toContain("--print-timeout");
    expect(seenArgs[seenArgs.indexOf("--print") + 1]).not.toContain("file://");

    // 2. With timeout: --print-timeout 125s pushes initialCommandSize over limit, triggering offload
    await runCliModel({
      provider: "agy",
      prompt: nearLimitPrompt,
      model: null,
      allowTools: false,
      timeoutMs: 125_000,
      env: {},
      execFileImpl,
      config: null,
    });
    expect(seenArgs).toContain("--print-timeout");
    expect(seenArgs[seenArgs.indexOf("--print") + 1]).toContain("file://");
  });

  it("rejects command when --print-timeout pushes extraArgs boundary over limit", async () => {
    let called = false;
    const execFileImpl: ExecFileFn = ((_cmd, _args, _options, cb) => {
      called = true;
      cb?.(null, "ok", "");
      return { stdin: { write: () => {}, end: () => {} } } as unknown as ReturnType<ExecFileFn>;
    }) as ExecFileFn;

    const limit = resolveAgyMaxPrintArgLimit().limit;
    const shortPrompt = "Short prompt";
    const baseOverhead =
      "agy".length +
      1 +
      "--sandbox".length +
      1 +
      "--print".length +
      1 +
      shortPrompt.length +
      AGY_NO_TOOLS_GUIDANCE.length;

    // Fill extraArgs to leave 7 bytes of headroom below limit without timeout;
    // --print-timeout 125s (21 bytes) pushes command size over limit
    const paddingSize = limit - baseOverhead - 15;
    const boundaryExtraArgs = ["--flag=" + "y".repeat(paddingSize)];

    // 1. Without timeout: command fits within limit and executes
    await runCliModel({
      provider: "agy",
      prompt: shortPrompt,
      model: null,
      allowTools: false,
      timeoutMs: 0,
      env: {},
      execFileImpl,
      config: { agy: { extraArgs: boundaryExtraArgs } },
    });
    expect(called).toBe(true);

    // 2. With timeout: --print-timeout 125s (22 bytes) pushes command size over limit, causing rejection
    called = false;
    await expect(
      runCliModel({
        provider: "agy",
        prompt: shortPrompt,
        model: null,
        allowTools: false,
        timeoutMs: 125_000,
        env: {},
        execFileImpl,
        config: { agy: { extraArgs: boundaryExtraArgs } },
      }),
    ).rejects.toThrow(/cannot safely receive large command arguments over argv/);
    expect(called).toBe(false);
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
