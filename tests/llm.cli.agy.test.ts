import { describe, expect, it } from "vitest";
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
  it("invokes agy with --print, passes prompt via stdin, returns plain text", async () => {
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
    expect(seen[0]).toContain("--print");
    expect(seen[0]).toContain("--sandbox");
    expect(seen[0]).toContain("--print-timeout");
    expect(seen[0]).toContain("1s");
    expect(seen[0]).not.toContain("--output-format");
    expect(seenCwd).toContain("summarize-agy-");
    expect(seenCwd).not.toBe("/tmp/agy-original-cwd");
    expect(seenInput).toContain("Summarize this.");
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
