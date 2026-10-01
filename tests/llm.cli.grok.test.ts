import { execFile } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parseGrokOutput } from "../src/llm/cli-provider-output.js";
import { resolveCliBinary, runCliModel } from "../src/llm/cli.js";
import type { ExecFileFn } from "../src/markitdown.js";

const GROK_SUCCESS = JSON.stringify({
  text: "Final grok summary.",
  stopReason: "end_turn",
  sessionId: "session-1",
  requestId: "request-1",
  usage: {
    input_tokens: 100,
    cache_read_input_tokens: 20,
    cache_creation_input_tokens: 10,
    output_tokens: 5,
    total_tokens: 135,
  },
  num_turns: 1,
  total_cost_usd: 0.0123,
});

const promptPathFromArgs = (args: string[]): string => {
  const index = args.indexOf("--prompt-file");
  return index >= 0 ? (args[index + 1] ?? "") : "";
};

const stubExecFile = (
  stdout: string,
  seen?: {
    cmd?: string;
    args?: string[][];
    cwd?: string;
    error?: Error;
  },
): ExecFileFn =>
  ((cmd: unknown, args: string[], options: { cwd?: string }, cb?: (...a: unknown[]) => void) => {
    if (seen) {
      seen.cmd = String(cmd);
      seen.args?.push(args);
      seen.cwd = typeof options?.cwd === "string" ? options.cwd : "";
    }
    cb?.(seen?.error ?? null, stdout, "");
    return {
      stdin: { write: () => {}, end: () => {} },
    } as unknown as ReturnType<ExecFileFn>;
  }) as ExecFileFn;

describe("runCliModel - grok provider", () => {
  it("invokes grok headless with a private prompt file and a restricted sandboxed toolset", async () => {
    const prompt = "Summarize a short local proof document.";
    const sourceHome = mkdtempSync(path.join(tmpdir(), "grok-source-home-"));
    writeFileSync(path.join(sourceHome, "config.toml"), "malicious-config");
    writeFileSync(path.join(sourceHome, "hooks.json"), "malicious-hooks");
    writeFileSync(path.join(sourceHome, "auth.json"), '{"token":"secret"}', { mode: 0o600 });
    const seen: { cmd?: string; args: string[][]; cwd?: string } = { args: [] };
    let seenPrompt = "";
    let seenPromptMode = 0;
    let promptPath = "";
    let grokHome = "";
    let grokHomeAuth = "";
    let seenHome = "";
    let homeFiles: string[] = [];
    const execFileImpl: ExecFileFn = ((cmd, args, options, cb) => {
      seen.cmd = String(cmd);
      seen.args.push(args);
      seen.cwd = typeof options?.cwd === "string" ? options.cwd : "";
      grokHome =
        typeof (options?.env as Record<string, string | undefined>)?.GROK_HOME === "string"
          ? (options?.env as Record<string, string>).GROK_HOME
          : "";
      seenHome = String(options?.env?.HOME);
      homeFiles = readdirSync(grokHome);
      expect(readFileSync(path.join(grokHome, "sandbox.toml"), "utf8")).toBe(
        '[profiles.summarize]\nextends = "strict"\n',
      );
      expect(options?.env?.CLAUDE_CONFIG_DIR).toBeUndefined();
      expect(options?.env?.GROK_SANDBOX).toBeUndefined();
      grokHomeAuth = grokHome ? readFileSync(path.join(grokHome, "auth.json"), "utf8") : "";
      promptPath = promptPathFromArgs(args);
      seenPrompt = readFileSync(promptPath, "utf8");
      seenPromptMode = statSync(promptPath).mode & 0o777;
      cb?.(null, GROK_SUCCESS, "");
      return {
        stdin: { write: () => {}, end: () => {} },
      } as unknown as ReturnType<ExecFileFn>;
    }) as ExecFileFn;

    const result = await runCliModel({
      provider: "grok",
      prompt,
      model: null,
      allowTools: false,
      timeoutMs: 1000,
      env: {
        GROK_PATH: "/env/grok",
        GROK_HOME: sourceHome,
        CLAUDE_CONFIG_DIR: "/untrusted/config",
        GROK_SANDBOX: "off",
      },
      cwd: sourceHome,
      execFileImpl,
      config: {
        grok: {
          binary: "/configured/grok",
          model: "grok-4.6",
          extraArgs: ["--effort", "low"],
        },
      },
      extraArgs: ["--max-turns=1"],
      systemPrompt: "System prompt",
    });

    expect(result).toEqual({
      text: "Final grok summary.",
      usage: { promptTokens: 130, completionTokens: 5, totalTokens: 135 },
      costUsd: 0.0123,
    });
    expect(seen.cmd).toBe("/configured/grok");
    expect(seen.args[0]?.slice(0, 3)).toEqual(["--effort", "low", "--max-turns=1"]);
    expect(seen.args[0]).toEqual(
      expect.arrayContaining([
        "--prompt-file",
        promptPath,
        "--output-format",
        "json",
        "--permission-mode",
        "dontAsk",
        "--disallowed-tools",
        "list_dir",
        "--tools",
        "list_dir",
        "--deny",
        "MCPTool(*)",
        "--sandbox",
        "summarize",
        "--no-plan",
        "--no-subagents",
        "--disable-web-search",
        "-m",
        "grok-4.6",
      ]),
    );
    expect(seen.args[0]).not.toContain(prompt);
    expect(seen.args[0]).not.toContain("System prompt");
    expect(seen.args[0]).not.toContain("--always-approve");
    // Prompt file lives inside the isolated sandbox cwd so Grok can read it.
    expect(seen.cwd).toContain("summarize-grok-");
    expect(promptPath).toBe(path.join(seen.cwd ?? "", "prompt.txt"));
    expect(seenPrompt).toBe(`System prompt\n\n${prompt}`);
    expect(seenPromptMode).toBe(0o600);
    // GROK_HOME is redirected to an isolated home carrying only auth.json so
    // sessions, hooks, and user config do not leak in.
    expect(grokHome).toBe(path.join(seenHome, ".grok"));
    expect(homeFiles).toEqual(["auth.json", "sandbox.toml"]);
    expect(seenHome).not.toBe(process.env.HOME);
    expect(seen.cwd).not.toBe(sourceHome);
    expect(grokHome).not.toBe(sourceHome);
    expect(grokHomeAuth).toBe('{"token":"secret"}');
    expect(existsSync(promptPath)).toBe(false);
    expect(existsSync(seen.cwd ?? "")).toBe(false);
    expect(existsSync(grokHome)).toBe(false);
    rmSync(sourceHome, { recursive: true, force: true });
  });

  it("keeps tools enabled when requested and preserves the caller cwd", async () => {
    const seen: { args: string[][]; cwd?: string; grokHome?: string } = { args: [] };
    let promptPath = "";
    const execFileImpl: ExecFileFn = ((_cmd, args, options, cb) => {
      seen.args.push(args);
      seen.cwd = typeof options?.cwd === "string" ? options.cwd : "";
      const env = options?.env as Record<string, string | undefined> | undefined;
      seen.grokHome = env?.GROK_HOME;
      promptPath = promptPathFromArgs(args);
      cb?.(null, GROK_SUCCESS, "");
      return {
        stdin: { write: () => {}, end: () => {} },
      } as unknown as ReturnType<ExecFileFn>;
    }) as ExecFileFn;

    const result = await runCliModel({
      provider: "grok",
      prompt: "Read /tmp/file.txt and summarize it.",
      model: "grok-4.7",
      allowTools: true,
      timeoutMs: 1000,
      env: {},
      execFileImpl,
      config: null,
      cwd: "/tmp/grok-tools-cwd",
    });

    expect(result.text).toBe("Final grok summary.");
    expect(seen.args[0]).toEqual(
      expect.arrayContaining(["--always-approve", "--sandbox", "off", "-m", "grok-4.7"]),
    );
    expect(seen.args[0]).not.toContain("--tools");
    expect(seen.args[0]).not.toContain("strict");
    expect(seen.cwd).toBe("/tmp/grok-tools-cwd");
    // Trusted runs keep the user's real GROK_HOME so their config/MCP setup applies.
    expect(seen.grokHome ?? "").not.toContain("summarize-grok-home-");
    expect(promptPath).toContain("summarize-grok-");
    expect(existsSync(promptPath)).toBe(false);
  });

  it("refuses to disable text isolation", async () => {
    await expect(
      runCliModel({
        provider: "grok",
        prompt: "hi",
        model: null,
        allowTools: false,
        timeoutMs: 1000,
        env: {},
        execFileImpl: stubExecFile(GROK_SUCCESS),
        config: { grok: { isolated: false } },
        cwd: "/untrusted/project",
      }),
    ).rejects.toThrow(/require isolation/);
  });

  it.each([
    ["--sandbox", "off"],
    ["--tools=read_file"],
    ["--always-approve"],
    ["--cwd", "/untrusted/project"],
    ["--agent=evil"],
    ["--resume=old"],
    ["--prompt-file", "/different/prompt"],
    ["--permission-mode=bypassPermissions"],
    ["--leader-socket", "/existing/leader.sock"],
    ["--", "positional prompt"],
  ])("rejects unsafe extraArgs %j", async (...extraArgs) => {
    await expect(
      runCliModel({
        provider: "grok",
        prompt: "hi",
        model: null,
        allowTools: false,
        timeoutMs: 1000,
        env: {},
        execFileImpl: stubExecFile(GROK_SUCCESS),
        config: { grok: { extraArgs } },
      }),
    ).rejects.toThrow(/Grok extraArgs only support/);
  });

  it("rejects missing tuning flag values", async () => {
    await expect(
      runCliModel({
        provider: "grok",
        prompt: "hi",
        model: null,
        allowTools: false,
        timeoutMs: 1000,
        env: {},
        execFileImpl: stubExecFile(GROK_SUCCESS),
        config: { grok: { extraArgs: ["--effort"] } },
      }),
    ).rejects.toThrow(/Missing value/);
  });

  it("proves the subprocess boundary with a recording executable", async () => {
    const fixture = mkdtempSync(path.join(tmpdir(), "grok-recording-"));
    const binary = path.join(fixture, "grok");
    const marker = "UNTRUSTED_PAGE_" + "x".repeat(200_000);
    writeFileSync(path.join(fixture, "auth.json"), '{"token":"synthetic-auth"}');
    writeFileSync(path.join(fixture, "config.toml"), "must-not-be-copied");
    writeFileSync(
      binary,
      `#!${process.execPath}
const fs = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(2);
const promptPath = args[args.indexOf("--prompt-file") + 1];
const record = {
  args, cwd: process.cwd(), home: process.env.HOME,
  homeFiles: fs.readdirSync(process.env.GROK_HOME),
  auth: fs.readFileSync(path.join(process.env.GROK_HOME, "auth.json"), "utf8"),
  prompt: fs.readFileSync(promptPath, "utf8"),
  mode: fs.statSync(promptPath).mode & 0o777,
  inheritedHook: process.env.CLAUDE_CONFIG_DIR ?? null,
  inheritedSecret: process.env.UNRELATED_SECRET ?? null,
};
console.log(JSON.stringify({text: JSON.stringify(record)}));
`,
    );
    chmodSync(binary, 0o700);
    try {
      const result = await runCliModel({
        provider: "grok",
        prompt: marker,
        systemPrompt: "Synthetic system prompt",
        model: null,
        allowTools: false,
        timeoutMs: 10_000,
        env: {
          GROK_HOME: fixture,
          CLAUDE_CONFIG_DIR: fixture,
          UNRELATED_SECRET: "synthetic-secret",
        },
        execFileImpl: execFile as ExecFileFn,
        config: { grok: { binary } },
        cwd: fixture,
      });
      const record = JSON.parse(result.text);
      expect(record.prompt).toBe(`Synthetic system prompt\n\n${marker}`);
      expect(record.args.join(" ")).not.toContain("UNTRUSTED_PAGE_");
      expect(record.args.join(" ")).not.toContain("Synthetic system prompt");
      expect(record.args).toEqual(
        expect.arrayContaining([
          "--disallowed-tools",
          "list_dir",
          "--sandbox",
          "summarize",
          "--no-subagents",
          "--disable-web-search",
          "MCPTool(*)",
        ]),
      );
      expect(record.mode).toBe(0o600);
      expect(record.homeFiles).toEqual(["auth.json", "sandbox.toml"]);
      expect(record.auth).toBe('{"token":"synthetic-auth"}');
      expect(record.inheritedHook).toBeNull();
      expect(record.inheritedSecret).toBeNull();
      expect(record.cwd).not.toBe(fixture);
      expect(existsSync(record.cwd)).toBe(false);
      expect(existsSync(record.home)).toBe(false);
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }
  });

  it("surfaces grok's stdout error object when the process exits non-zero", async () => {
    const execError = new Error("Command failed: grok --prompt-file ...");
    const execFileImpl: ExecFileFn = ((_cmd, _args, _options, cb) => {
      // The real execFile callback reports the buffered stdout alongside the
      // error; execCliWithInput attaches it to the thrown error.
      cb?.(execError, JSON.stringify({ type: "error", message: "quota exceeded for plan" }), "");
      return {
        stdin: { write: () => {}, end: () => {} },
      } as unknown as ReturnType<ExecFileFn>;
    }) as ExecFileFn;

    await expect(
      runCliModel({
        provider: "grok",
        prompt: "hi",
        model: null,
        allowTools: false,
        timeoutMs: 1000,
        env: {},
        execFileImpl,
        config: null,
      }),
    ).rejects.toThrow(/quota exceeded for plan/);
  });

  it("surfaces structured grok errors", async () => {
    const execFileImpl: ExecFileFn = ((_cmd, _args, _options, cb) => {
      cb?.(
        null,
        JSON.stringify({
          type: "error",
          message:
            "Couldn't set model 'totally-bogus-model': Invalid params: \"unknown model id\".",
        }),
        "",
      );
      return {
        stdin: { write: () => {}, end: () => {} },
      } as unknown as ReturnType<ExecFileFn>;
    }) as ExecFileFn;

    await expect(
      runCliModel({
        provider: "grok",
        prompt: "hi",
        model: "totally-bogus-model",
        allowTools: false,
        timeoutMs: 1000,
        env: {},
        execFileImpl,
        config: null,
      }),
    ).rejects.toThrow(/totally-bogus-model/);
  });

  it("cleans up the prompt file and temp cwd when grok fails", async () => {
    let seenCwd = "";
    let promptPath = "";
    const execFileImpl: ExecFileFn = ((_cmd, args, options, cb) => {
      seenCwd = typeof options?.cwd === "string" ? options.cwd : "";
      promptPath = promptPathFromArgs(args);
      cb?.(new Error("spawn failed"), "", "");
      return {
        stdin: { write: () => {}, end: () => {} },
      } as unknown as ReturnType<ExecFileFn>;
    }) as ExecFileFn;

    await expect(
      runCliModel({
        provider: "grok",
        prompt: "hi",
        model: null,
        allowTools: false,
        timeoutMs: 1000,
        env: {},
        execFileImpl,
        config: null,
      }),
    ).rejects.toThrow(/spawn failed/);
    expect(existsSync(promptPath)).toBe(false);
    expect(existsSync(seenCwd)).toBe(false);
  });

  it("resolves grok binaries from GROK_PATH when config binary is absent", () => {
    expect(resolveCliBinary("grok", null, { GROK_PATH: "/custom/grok" })).toBe("/custom/grok");
    expect(resolveCliBinary("grok", null, { SUMMARIZE_CLI_GROK: "/env-override/grok" })).toBe(
      "/env-override/grok",
    );
    expect(
      resolveCliBinary("grok", null, {
        GROK_PATH: "/primary/grok",
        SUMMARIZE_CLI_GROK: "/fallback/grok",
      }),
    ).toBe("/primary/grok");
  });
});

describe("parseGrokOutput", () => {
  it("parses the grok JSON result object with usage and cost", () => {
    expect(parseGrokOutput(GROK_SUCCESS)).toEqual({
      text: "Final grok summary.",
      usage: { promptTokens: 130, completionTokens: 5, totalTokens: 135 },
      costUsd: 0.0123,
    });
  });

  it("skips warning preludes before the JSON object", () => {
    const output = `Warning: config migrated\n${GROK_SUCCESS}`;
    expect(parseGrokOutput(output).text).toBe("Final grok summary.");
  });

  it("recovers the result object after diagnostics containing braces", () => {
    const output = `${JSON.stringify({ warning: { detail: "migrated" } })}\n${GROK_SUCCESS}`;
    const parsed = parseGrokOutput(output);
    expect(parsed.text).toBe("Final grok summary.");
    expect(parsed.costUsd).toBe(0.0123);
  });

  it("throws on empty output", () => {
    expect(() => parseGrokOutput("  ")).toThrow(/empty output/);
  });

  it("throws on structured error payloads", () => {
    expect(() => parseGrokOutput(JSON.stringify({ type: "error", message: " boom " }))).toThrow(
      "boom",
    );
    expect(() =>
      parseGrokOutput(JSON.stringify({ type: "error", error: { message: "nested boom" } })),
    ).toThrow("nested boom");
    expect(() => parseGrokOutput(JSON.stringify({ type: "error" }))).toThrow(/error/);
  });

  it("does not treat messages on non-error payloads as failures", () => {
    expect(() =>
      parseGrokOutput(JSON.stringify({ type: "warning", message: "not an error" })),
    ).toThrow(/empty output/);
  });

  it("throws on JSON payloads without result text", () => {
    expect(() => parseGrokOutput(JSON.stringify({ sessionId: "s1" }))).toThrow(/empty output/);
  });

  it("falls back to plain stdout when no JSON object exists", () => {
    expect(parseGrokOutput(" plain grok output ")).toEqual({
      text: "plain grok output",
      usage: null,
      costUsd: null,
    });
  });

  it("handles missing cache and total usage fields", () => {
    expect(
      parseGrokOutput(JSON.stringify({ text: "ok", usage: { input_tokens: 3, output_tokens: 2 } })),
    ).toEqual({
      text: "ok",
      usage: { promptTokens: 3, completionTokens: 2, totalTokens: 5 },
      costUsd: null,
    });
    expect(parseGrokOutput(JSON.stringify({ text: "ok" }))).toEqual({
      text: "ok",
      usage: null,
      costUsd: null,
    });
  });
});
