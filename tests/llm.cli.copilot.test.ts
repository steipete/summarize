import { describe, expect, it } from "vitest";
import { resolveCliBinary, runCliModel } from "../src/llm/cli.js";
import type { ExecFileFn } from "../src/markitdown.js";

const makeStub = (handler: (args: string[]) => { stdout?: string; stderr?: string }) => {
  const execFileStub: ExecFileFn = ((_cmd, args, _options, cb) => {
    const result = handler(args);
    if (cb) cb(null, result.stdout ?? "", result.stderr ?? "");
    return {
      stdin: { write: () => {}, end: () => {} },
    } as unknown as ReturnType<ExecFileFn>;
  }) as ExecFileFn;
  return execFileStub;
};

describe("runCliModel - copilot provider", () => {
  it("invokes copilot with -p and --allow-all-tools, returns plain text", async () => {
    const seen: string[][] = [];
    let seenCmd = "";
    const execFileImpl: ExecFileFn = ((cmd, args, _options, cb) => {
      seenCmd = String(cmd);
      seen.push(args);
      cb?.(null, "  Hello from Copilot.  \n", "");
      return {
        stdin: { write: () => {}, end: () => {} },
      } as unknown as ReturnType<ExecFileFn>;
    }) as ExecFileFn;

    const result = await runCliModel({
      provider: "copilot",
      prompt: "Summarize this.",
      model: null,
      allowTools: true,
      timeoutMs: 1000,
      env: {},
      execFileImpl,
      config: null,
    });

    expect(result.text).toBe("Hello from Copilot.");
    expect(result.usage).toBeNull();
    expect(result.costUsd).toBeNull();
    expect(seenCmd).toBe("copilot");
    expect(seen[0]).toContain("-p");
    expect(seen[0]).toContain("Summarize this.");
    expect(seen[0]).toContain("--allow-all-tools");
  });

  it("omits --allow-all-tools when allowTools is false and passes --model", async () => {
    const seen: string[][] = [];
    const execFileImpl = makeStub((args) => {
      seen.push(args);
      return { stdout: "answer text" };
    });

    const result = await runCliModel({
      provider: "copilot",
      prompt: "Q?",
      model: "gpt-5.2",
      allowTools: false,
      timeoutMs: 1000,
      env: {},
      execFileImpl,
      config: null,
    });

    expect(result.text).toBe("answer text");
    expect(seen[0]).toContain("-p");
    expect(seen[0]).toContain("Q?");
    expect(seen[0]).not.toContain("--allow-all-tools");
    expect(seen[0]).toContain("--model");
    expect(seen[0]).toContain("gpt-5.2");
  });

  it("throws when copilot returns empty output", async () => {
    const execFileImpl = makeStub(() => ({ stdout: "  \n" }));
    await expect(
      runCliModel({
        provider: "copilot",
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

  it("respects COPILOT_PATH and config-provided binary/extraArgs", async () => {
    expect(resolveCliBinary("copilot", null, { COPILOT_PATH: "/custom/copilot" })).toBe(
      "/custom/copilot",
    );
    expect(resolveCliBinary("copilot", { copilot: { binary: "/cfg/copilot" } }, {})).toBe(
      "/cfg/copilot",
    );
    expect(resolveCliBinary("copilot", null, {})).toBe("copilot");

    const seen: string[][] = [];
    const execFileImpl = makeStub((args) => {
      seen.push(args);
      return { stdout: "ok" };
    });
    await runCliModel({
      provider: "copilot",
      prompt: "Q",
      model: null,
      allowTools: false,
      timeoutMs: 1000,
      env: {},
      execFileImpl,
      config: { copilot: { extraArgs: ["--no-color"] } },
    });
    expect(seen[0]?.[0]).toBe("--no-color");
  });
});
