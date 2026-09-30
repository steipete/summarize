import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { parseDevinOutputFromAtif } from "../src/llm/cli-provider-output.js";
import { resolveCliBinary, runCliModel } from "../src/llm/cli.js";
import type { ExecFileFn } from "../src/markitdown.js";

const fixtureHome = path.join(tmpdir(), `summarize-devin-test-${process.pid}`);
const originalPlatform = process.platform;

afterEach(() => {
  vi.unstubAllEnvs();
  Object.defineProperty(process, "platform", { value: originalPlatform });
});

afterAll(() => {
  rmSync(fixtureHome, { recursive: true, force: true });
});

function atifDocument(text: string, metrics?: Record<string, number>): string {
  return JSON.stringify({
    schema_version: "ATIF-v1.7",
    session_id: "s1",
    agent: { name: "devin", model_name: "swe-2-max" },
    steps: [
      { source: "system", message: "You are Devin." },
      { source: "user", message: "Summarize this." },
      { source: "agent", message: text },
    ],
    ...(metrics ? { final_metrics: metrics } : {}),
  });
}

describe("runCliModel - devin provider", () => {
  it("invokes devin in isolated mode with XDG redirection, deny rules, and ATIF usage", async () => {
    const prompt = "Summarize a short local proof document.";
    const home = fixtureHome;
    mkdirSync(path.join(home, "config", "devin"), { recursive: true });
    mkdirSync(path.join(home, "data", "devin"), { recursive: true });
    writeFileSync(
      path.join(home, "config", "devin", "config.json"),
      JSON.stringify({
        devin: { org_id: "org-1" },
        agent: { model: "swe-2-max" },
        mcpServers: { rogue: { command: "x" } },
        hooks: { SessionStart: [{ type: "command", command: "echo hi" }] },
      }),
    );
    writeFileSync(path.join(home, "data", "devin", "credentials.toml"), 'api_key = "k"\n');

    let seenEnv: Record<string, string | undefined> = {};
    let seenCwd = "";
    let seenPromptPath = "";
    let seenPrompt = "";
    let seenPromptMode = 0;
    let seenConfig: Record<string, unknown> = {};
    let copiedCreds = "";
    const seenArgs: string[][] = [];
    const execFileImpl: ExecFileFn = ((_cmd, args, options, cb) => {
      seenArgs.push(args);
      seenEnv = (options?.env ?? {}) as Record<string, string | undefined>;
      seenCwd = typeof options?.cwd === "string" ? options.cwd : "";
      seenPromptPath = args[args.indexOf("--prompt-file") + 1] ?? "";
      seenPrompt = readFileSync(seenPromptPath, "utf8");
      seenPromptMode = statSync(seenPromptPath).mode & 0o777;
      const exportPath = args[args.indexOf("--export") + 1] ?? "";
      const configPath = path.join(String(seenEnv.XDG_CONFIG_HOME), "devin", "config.json");
      seenConfig = JSON.parse(readFileSync(configPath, "utf8")) as Record<string, unknown>;
      copiedCreds = readFileSync(
        path.join(String(seenEnv.XDG_DATA_HOME), "devin", "credentials.toml"),
        "utf8",
      );
      writeFileSync(
        exportPath,
        atifDocument("Final devin summary.", {
          total_prompt_tokens: 18000,
          total_completion_tokens: 42,
          total_cached_tokens: 9000,
          total_steps: 3,
        }),
      );
      cb?.(null, "Final devin summary.\n", "");
      return {
        stdin: { write: () => {}, end: () => {} },
      } as unknown as ReturnType<ExecFileFn>;
    }) as ExecFileFn;

    const result = await runCliModel({
      provider: "devin",
      prompt,
      model: "swe-2-max",
      allowTools: false,
      timeoutMs: 1000,
      env: { XDG_CONFIG_HOME: path.join(home, "config"), XDG_DATA_HOME: path.join(home, "data") },
      execFileImpl,
      config: { devin: { binary: "/configured/devin" } },
      systemPrompt: "System prompt",
    });

    expect(result).toEqual({
      text: "Final devin summary.",
      usage: { promptTokens: 18000, completionTokens: 42, totalTokens: 18042 },
      costUsd: null,
    });
    expect(seenArgs[0]).toEqual(
      expect.arrayContaining([
        "--print",
        "--prompt-file",
        seenPromptPath,
        "--permission-mode",
        "auto",
        "--respect-workspace-trust",
        "false",
        "--model",
        "swe-2-max",
      ]),
    );
    expect(seenArgs[0]).not.toContain(prompt);
    expect(seenPrompt).toBe(`System prompt\n\n${prompt}`);
    expect(seenPromptMode).toBe(0o600);
    // Isolated environment: XDG roots redirect into the temp workdir and the
    // prompt file lives outside the (empty) isolated cwd.
    expect(String(seenEnv.XDG_CONFIG_HOME)).toContain("summarize-devin-");
    expect(String(seenEnv.XDG_DATA_HOME)).toContain("summarize-devin-");
    expect(seenCwd).toContain("summarize-devin-");
    // Merged config keeps user sections but enforces deny rules and strips
    // MCP config + command hooks (hooks run outside the tool deny list).
    expect(seenConfig.devin).toEqual({ org_id: "org-1" });
    expect(seenConfig.mcpServers).toBeUndefined();
    expect(seenConfig.hooks).toBeUndefined();
    expect((seenConfig.read_config_from as Record<string, boolean>).claude).toBe(false);
    expect((seenConfig.read_config_from as Record<string, boolean>).vscode).toBe(false);
    const deny = (seenConfig.permissions as { deny: string[] }).deny;
    expect(deny).toEqual(
      expect.arrayContaining(["exec", "write", "apply_patch", "read", "mcp_call_tool"]),
    );
    expect(copiedCreds).toBe('api_key = "k"\n');
    // Temp workdir (including prompt + export) is cleaned up.
    expect(existsSync(seenPromptPath)).toBe(false);
    expect(existsSync(path.join(String(seenEnv.XDG_CONFIG_HOME)))).toBe(false);
  });

  it.each([
    { marker: ".git", file: false },
    { marker: ".git", file: true },
    { marker: ".jj", file: false },
  ])("rejects a temporary directory inside a project (%j)", async ({ marker, file }) => {
    const project = path.join(fixtureHome, `project-${marker}-${file}`);
    const temp = path.join(project, "scratch");
    mkdirSync(temp, { recursive: true });
    if (file) writeFileSync(path.join(project, marker), "gitdir: /synthetic/worktree\n");
    else mkdirSync(path.join(project, marker));
    vi.stubEnv("TMPDIR", temp);
    vi.stubEnv("TEMP", temp);
    vi.stubEnv("TMP", temp);
    const execFileImpl = vi.fn((_cmd, args, _options, cb) => {
      writeFileSync(args[args.indexOf("--export") + 1], atifDocument("unsafe execution"));
      cb?.(null, "", "");
      return { stdin: { write: () => {}, end: () => {} } };
    });

    await expect(
      runCliModel({
        provider: "devin",
        prompt: "Summarize.",
        model: null,
        allowTools: false,
        timeoutMs: 1000,
        env: {},
        config: null,
        execFileImpl: execFileImpl as unknown as ExecFileFn,
      }),
    ).rejects.toThrow(/temporary directory.*outside.*checkout/i);
    expect(execFileImpl).not.toHaveBeenCalled();
  });

  it("uses Windows APPDATA for auth and config even when XDG roots are set", async () => {
    const appData = path.join(fixtureHome, "windows-roaming");
    mkdirSync(path.join(appData, "devin"), { recursive: true });
    writeFileSync(path.join(appData, "devin", "credentials.toml"), 'api_key = "windows-fixture"\n');
    writeFileSync(path.join(appData, "devin", "config.json"), '{"devin":{"org_id":"windows-org"}}');
    Object.defineProperty(process, "platform", { value: "win32" });
    let auth = "";
    let copiedConfig: Record<string, unknown> = {};
    const execFileImpl: ExecFileFn = ((_cmd, args, options, cb) => {
      const env = options.env as Record<string, string>;
      auth = readFileSync(path.join(env.APPDATA, "devin", "credentials.toml"), "utf8");
      copiedConfig = JSON.parse(
        readFileSync(path.join(env.APPDATA, "devin", "config.json"), "utf8"),
      );
      writeFileSync(args[args.indexOf("--export") + 1], atifDocument("windows answer"));
      cb?.(null, "", "");
      return { stdin: { write: () => {}, end: () => {} } } as unknown as ReturnType<ExecFileFn>;
    }) as ExecFileFn;
    await runCliModel({
      provider: "devin",
      prompt: "Summarize.",
      model: null,
      allowTools: false,
      timeoutMs: 1000,
      env: { APPDATA: appData, XDG_CONFIG_HOME: "/wrong/config", XDG_DATA_HOME: "/wrong/data" },
      config: null,
      execFileImpl,
    });
    expect(auth).toBe('api_key = "windows-fixture"\n');
    expect(copiedConfig.devin).toEqual({ org_id: "windows-org" });
  });

  it("keeps the caller cwd and real environment for tool-enabled runs", async () => {
    let seenEnv: Record<string, string | undefined> = {};
    let seenCwd = "";
    const seenArgs: string[][] = [];
    const execFileImpl: ExecFileFn = ((_cmd, args, options, cb) => {
      seenArgs.push(args);
      seenEnv = (options?.env ?? {}) as Record<string, string | undefined>;
      seenCwd = typeof options?.cwd === "string" ? options.cwd : "";
      const exportPath = args[args.indexOf("--export") + 1] ?? "";
      writeFileSync(exportPath, atifDocument("tool-enabled answer"));
      cb?.(null, "", "");
      return { stdin: { write: () => {}, end: () => {} } } as unknown as ReturnType<ExecFileFn>;
    }) as ExecFileFn;

    const result = await runCliModel({
      provider: "devin",
      prompt: "Summarize the attached file.",
      model: null,
      allowTools: true,
      timeoutMs: 1000,
      env: { DEVIN_PATH: "/env/devin", XDG_CONFIG_HOME: "/real/xdg-config" },
      execFileImpl,
      config: { devin: { model: "claude-opus-4.6" } },
      cwd: "/tmp/devin-tools-cwd",
    });

    expect(result.text).toBe("tool-enabled answer");
    expect(seenCwd).toBe("/tmp/devin-tools-cwd");
    expect(seenEnv.XDG_CONFIG_HOME).toBe("/real/xdg-config");
    expect(seenEnv.XDG_DATA_HOME).toBeUndefined();
    expect(seenArgs[0]).toEqual(
      expect.arrayContaining(["--permission-mode", "auto", "--model", "claude-opus-4.6"]),
    );
  });

  it("uses a private cwd even when isolated text runs receive an explicit cwd", async () => {
    let seenEnv: Record<string, string | undefined> = {};
    let seenCwd = "";
    let seenArgs: string[] = [];
    const execFileImpl: ExecFileFn = ((_cmd, args, options, cb) => {
      seenArgs = args;
      seenEnv = (options?.env ?? {}) as Record<string, string | undefined>;
      seenCwd = typeof options?.cwd === "string" ? options.cwd : "";
      const exportPath = args[args.indexOf("--export") + 1] ?? "";
      writeFileSync(exportPath, atifDocument("explicit cwd answer"));
      cb?.(null, "", "");
      return { stdin: { write: () => {}, end: () => {} } } as unknown as ReturnType<ExecFileFn>;
    }) as ExecFileFn;

    const result = await runCliModel({
      provider: "devin",
      prompt: "Summarize.",
      model: null,
      allowTools: false,
      timeoutMs: 1000,
      env: { XDG_CONFIG_HOME: "/real/xdg-config" },
      execFileImpl,
      config: null,
      cwd: "/tmp/devin-explicit-cwd",
    });

    expect(result.text).toBe("explicit cwd answer");
    expect(seenCwd).not.toBe("/tmp/devin-explicit-cwd");
    expect(seenCwd).toContain("summarize-devin-");
    expect(seenArgs[seenArgs.indexOf("--respect-workspace-trust") + 1]).toBe("false");
    expect(existsSync(seenCwd)).toBe(false);
    expect(String(seenEnv.XDG_CONFIG_HOME)).toContain("summarize-devin-");
  });

  it("keeps the real environment when cli.devin.isolated is false", async () => {
    let seenEnv: Record<string, string | undefined> = {};
    const execFileImpl: ExecFileFn = ((_cmd, args, options, cb) => {
      seenEnv = (options?.env ?? {}) as Record<string, string | undefined>;
      const exportPath = args[args.indexOf("--export") + 1] ?? "";
      writeFileSync(exportPath, atifDocument("trusted answer"));
      cb?.(null, "", "");
      return { stdin: { write: () => {}, end: () => {} } } as unknown as ReturnType<ExecFileFn>;
    }) as ExecFileFn;

    const result = await runCliModel({
      provider: "devin",
      prompt: "Summarize.",
      model: null,
      allowTools: false,
      timeoutMs: 1000,
      env: { XDG_CONFIG_HOME: "/real/xdg-config" },
      execFileImpl,
      config: { devin: { isolated: false } },
      cwd: "/tmp/devin-cwd",
    });

    expect(result.text).toBe("trusted answer");
    expect(seenEnv.XDG_CONFIG_HOME).toBe("/real/xdg-config");
  });

  it.each([
    { allowTools: true, isolated: true, cwd: "/tmp/devin-untrusted-project" },
    { allowTools: false, isolated: false, cwd: "/tmp/devin-untrusted-project" },
    { allowTools: false, isolated: false, cwd: undefined },
  ])("preserves workspace trust outside the private cwd (%j)", async (scenario) => {
    let invocation: string[] = [];
    const execFileImpl: ExecFileFn = ((_cmd, args, _options, cb) => {
      invocation = args;
      writeFileSync(args[args.indexOf("--export") + 1], atifDocument("answer"));
      cb?.(null, "", "");
      return { stdin: { write: () => {}, end: () => {} } } as unknown as ReturnType<ExecFileFn>;
    }) as ExecFileFn;

    await runCliModel({
      provider: "devin",
      prompt: "Summarize the selected input.",
      model: null,
      allowTools: scenario.allowTools,
      timeoutMs: 1000,
      env: {},
      execFileImpl,
      config: { devin: { isolated: scenario.isolated } },
      cwd: scenario.cwd,
    });

    expect(invocation[invocation.indexOf("--respect-workspace-trust") + 1]).toBe("true");
  });

  it("honors extraArgs overrides for managed flags", async () => {
    const seenArgs: string[][] = [];
    const execFileImpl: ExecFileFn = ((_cmd, args, _options, cb) => {
      seenArgs.push(args);
      const exportPath = args[args.indexOf("--export") + 1] ?? "";
      writeFileSync(exportPath, atifDocument("ok"));
      cb?.(null, "", "");
      return { stdin: { write: () => {}, end: () => {} } } as unknown as ReturnType<ExecFileFn>;
    }) as ExecFileFn;

    await runCliModel({
      provider: "devin",
      prompt: "Summarize.",
      model: null,
      allowTools: true,
      timeoutMs: 1000,
      env: {},
      execFileImpl,
      config: {
        devin: { extraArgs: ["--permission-mode", "dangerous", "--sandbox"] },
      },
    });

    const invocation = seenArgs[0];
    expect(invocation.filter((arg) => arg === "--permission-mode")).toHaveLength(1);
    expect(invocation[invocation.indexOf("--permission-mode") + 1]).toBe("dangerous");
    expect(invocation).toContain("--sandbox");
    expect(invocation).toContain("--print");
  });

  it.each([["--export", "/shared/result.json"], ["--export=/shared/result.json"], ["--export"]])(
    "rejects custom export flags (%j)",
    async (...extraArgs) => {
      const execFileImpl = vi.fn();
      await expect(
        runCliModel({
          provider: "devin",
          prompt: "Summarize.",
          model: null,
          allowTools: true,
          timeoutMs: 1000,
          env: {},
          config: { devin: { extraArgs } },
          execFileImpl: execFileImpl as unknown as ExecFileFn,
        }),
      ).rejects.toThrow(/cannot override --export/);
      expect(execFileImpl).not.toHaveBeenCalled();
    },
  );

  it("keeps concurrent results in private export files", async () => {
    const pending: Array<{ output: string; text: string; complete: () => void }> = [];
    const execFileImpl: ExecFileFn = ((_cmd, args, _options, cb) => {
      pending.push({
        output: args[args.indexOf("--export") + 1],
        text: readFileSync(args[args.indexOf("--prompt-file") + 1], "utf8"),
        complete: () => cb?.(null, "", ""),
      });
      if (pending.length === 2) {
        for (const call of pending) writeFileSync(call.output, atifDocument(call.text));
        for (const call of pending) call.complete();
      }
      return { stdin: { write: () => {}, end: () => {} } } as unknown as ReturnType<ExecFileFn>;
    }) as ExecFileFn;
    const results = await Promise.all(
      ["first", "second"].map((prompt) =>
        runCliModel({
          provider: "devin",
          prompt,
          model: null,
          allowTools: true,
          timeoutMs: 1000,
          env: {},
          config: null,
          execFileImpl,
        }),
      ),
    );
    expect(new Set(pending.map((call) => call.output)).size).toBe(2);
    expect(results.map((result) => result.text)).toEqual(["first", "second"]);
    for (const call of pending) expect(existsSync(call.output)).toBe(false);
  });

  it("inserts managed flags before a -- sentinel", async () => {
    const seenArgs: string[][] = [];
    const execFileImpl: ExecFileFn = ((_cmd, args, _options, cb) => {
      seenArgs.push(args);
      const exportPath = args[args.indexOf("--export") + 1] ?? "";
      writeFileSync(exportPath, atifDocument("sentinel ok"));
      cb?.(null, "", "");
      return { stdin: { write: () => {}, end: () => {} } } as unknown as ReturnType<ExecFileFn>;
    }) as ExecFileFn;

    const result = await runCliModel({
      provider: "devin",
      prompt: "Summarize.",
      model: "swe-2-max",
      allowTools: true,
      timeoutMs: 1000,
      env: {},
      execFileImpl,
      config: { devin: { extraArgs: ["--", "trailing", "prompt", "text"] } },
    });

    const invocation = seenArgs[0];
    const sentinel = invocation.indexOf("--");
    expect(result.text).toBe("sentinel ok");
    expect(sentinel).toBeGreaterThan(-1);
    for (const flag of ["--print", "--prompt-file", "--export", "--permission-mode", "--model"]) {
      expect(invocation.indexOf(flag)).toBeGreaterThan(-1);
      expect(invocation.indexOf(flag)).toBeLessThan(sentinel);
    }
    expect(invocation.slice(sentinel + 1)).toEqual(["trailing", "prompt", "text"]);
  });

  it("lets a user --model in extraArgs win over the requested model", async () => {
    const seenArgs: string[][] = [];
    const execFileImpl: ExecFileFn = ((_cmd, args, _options, cb) => {
      seenArgs.push(args);
      const exportPath = args[args.indexOf("--export") + 1] ?? "";
      writeFileSync(exportPath, atifDocument("user model wins"));
      cb?.(null, "", "");
      return { stdin: { write: () => {}, end: () => {} } } as unknown as ReturnType<ExecFileFn>;
    }) as ExecFileFn;

    const result = await runCliModel({
      provider: "devin",
      prompt: "Summarize.",
      model: "requested-model",
      allowTools: true,
      timeoutMs: 1000,
      env: {},
      execFileImpl,
      config: { devin: { extraArgs: ["--model", "extraargs-model"] } },
    });

    expect(result.text).toBe("user model wins");
    // devin hard-errors on duplicate flags, so the requested model is dropped.
    const invocation = seenArgs[0];
    expect(invocation.filter((arg) => arg === "--model")).toHaveLength(1);
    expect(invocation[invocation.indexOf("--model") + 1]).toBe("extraargs-model");
    expect(invocation).not.toContain("requested-model");
  });

  it("detects --flag=value forms of managed flags", async () => {
    const seenArgs: string[][] = [];
    const execFileImpl: ExecFileFn = ((_cmd, args, _options, cb) => {
      seenArgs.push(args);
      const exportPath = args[args.indexOf("--export") + 1] ?? "";
      writeFileSync(exportPath, atifDocument("eq ok"));
      cb?.(null, "", "");
      return { stdin: { write: () => {}, end: () => {} } } as unknown as ReturnType<ExecFileFn>;
    }) as ExecFileFn;

    await runCliModel({
      provider: "devin",
      prompt: "Summarize.",
      model: null,
      allowTools: true,
      timeoutMs: 1000,
      env: {},
      execFileImpl,
      config: {
        devin: { extraArgs: ["--permission-mode=dangerous", "--respect-workspace-trust=true"] },
      },
    });

    const invocation = seenArgs[0];
    expect(invocation).toContain("--permission-mode=dangerous");
    expect(invocation).not.toContain("auto");
    expect(invocation).not.toContain("--permission-mode");
    expect(invocation).toContain("--respect-workspace-trust=true");
    expect(invocation).not.toContain("--respect-workspace-trust");
  });

  it("rejects --config in extraArgs while isolated, allows it when trusted", async () => {
    const execFileImpl: ExecFileFn = ((_cmd, _args, _options, cb) => {
      cb?.(null, "", "");
      return { stdin: { write: () => {}, end: () => {} } } as unknown as ReturnType<ExecFileFn>;
    }) as ExecFileFn;

    await expect(
      runCliModel({
        provider: "devin",
        prompt: "Summarize.",
        model: null,
        allowTools: false,
        timeoutMs: 1000,
        env: {},
        execFileImpl,
        config: { devin: { extraArgs: ["--config", "/custom/config.json"] } },
      }),
    ).rejects.toThrow(/--config/);

    const seenArgs: string[][] = [];
    const trustedImpl: ExecFileFn = ((_cmd, args, _options, cb) => {
      seenArgs.push(args);
      const exportPath = args[args.indexOf("--export") + 1] ?? "";
      writeFileSync(exportPath, atifDocument("trusted config"));
      cb?.(null, "", "");
      return { stdin: { write: () => {}, end: () => {} } } as unknown as ReturnType<ExecFileFn>;
    }) as ExecFileFn;
    const result = await runCliModel({
      provider: "devin",
      prompt: "Summarize.",
      model: null,
      allowTools: true,
      timeoutMs: 1000,
      env: {},
      execFileImpl: trustedImpl,
      config: { devin: { extraArgs: ["--config", "/custom/config.json"] } },
    });
    expect(result.text).toBe("trusted config");
    expect(seenArgs[0]).toContain("--config");
  });

  it("merges a JSONC user config without dropping settings", async () => {
    const home = fixtureHome;
    mkdirSync(path.join(home, "config", "devin"), { recursive: true });
    mkdirSync(path.join(home, "data", "devin"), { recursive: true });
    writeFileSync(
      path.join(home, "config", "devin", "config.json"),
      '{\n  // user org\n  "devin": { "org_id": "org-jsonc" },\n}\n',
    );

    let seenConfig: Record<string, unknown> = {};
    const execFileImpl: ExecFileFn = ((_cmd, args, options, cb) => {
      const env = (options?.env ?? {}) as Record<string, string | undefined>;
      seenConfig = JSON.parse(
        readFileSync(path.join(String(env.XDG_CONFIG_HOME), "devin", "config.json"), "utf8"),
      ) as Record<string, unknown>;
      writeFileSync(args[args.indexOf("--export") + 1] ?? "", atifDocument("jsonc ok"));
      cb?.(null, "", "");
      return { stdin: { write: () => {}, end: () => {} } } as unknown as ReturnType<ExecFileFn>;
    }) as ExecFileFn;

    const result = await runCliModel({
      provider: "devin",
      prompt: "Summarize.",
      model: null,
      allowTools: false,
      timeoutMs: 1000,
      env: {
        XDG_CONFIG_HOME: path.join(home, "config"),
        XDG_DATA_HOME: path.join(home, "data"),
      },
      execFileImpl,
      config: null,
    });

    expect(result.text).toBe("jsonc ok");
    expect(seenConfig.devin).toEqual({ org_id: "org-jsonc" });
  });

  it("falls back to trusted stdout (banner stripped) when no export is written", async () => {
    const execFileImpl: ExecFileFn = ((_cmd, _args, _options, cb) => {
      cb?.(null, "[1mWelcome to Devin CLI![0m\n[?2004lThe answer.", "");
      return { stdin: { write: () => {}, end: () => {} } } as unknown as ReturnType<ExecFileFn>;
    }) as ExecFileFn;

    const result = await runCliModel({
      provider: "devin",
      prompt: "Summarize.",
      model: null,
      allowTools: false,
      timeoutMs: 1000,
      env: {},
      execFileImpl,
      config: { devin: { isolated: false } },
      cwd: "/tmp/devin-cwd",
    });

    expect(result.text).toBe("The answer.");
  });

  it("falls back to trusted stdout when the export is malformed", async () => {
    const execFileImpl: ExecFileFn = ((_cmd, args, _options, cb) => {
      writeFileSync(args[args.indexOf("--export") + 1] ?? "", "{truncated json");
      cb?.(null, "stdout answer", "");
      return { stdin: { write: () => {}, end: () => {} } } as unknown as ReturnType<ExecFileFn>;
    }) as ExecFileFn;

    const result = await runCliModel({
      provider: "devin",
      prompt: "Summarize.",
      model: null,
      allowTools: true,
      timeoutMs: 1000,
      env: {},
      execFileImpl,
      config: null,
      cwd: "/tmp/devin-cwd",
    });

    expect(result.text).toBe("stdout answer");
  });

  it("rejects empty results in isolated mode instead of trusting stdout noise", async () => {
    const execFileImpl: ExecFileFn = ((_cmd, _args, _options, cb) => {
      cb?.(null, "Welcome to Devin CLI!\n", "");
      return { stdin: { write: () => {}, end: () => {} } } as unknown as ReturnType<ExecFileFn>;
    }) as ExecFileFn;

    await expect(
      runCliModel({
        provider: "devin",
        prompt: "Summarize.",
        model: null,
        allowTools: false,
        timeoutMs: 1000,
        env: {},
        execFileImpl,
        config: null,
      }),
    ).rejects.toThrow(/empty output/);
  });

  it("surfaces stderr from failed invocations", async () => {
    const execFileImpl: ExecFileFn = ((_cmd, _args, _options, cb) => {
      const error = new Error("Command failed") as Error & { code?: number };
      error.code = 1;
      cb?.(error, "", "Error: Unknown model 'bogus'");
      return { stdin: { write: () => {}, end: () => {} } } as unknown as ReturnType<ExecFileFn>;
    }) as ExecFileFn;

    await expect(
      runCliModel({
        provider: "devin",
        prompt: "Summarize.",
        model: "bogus",
        allowTools: false,
        timeoutMs: 1000,
        env: {},
        execFileImpl,
        config: null,
      }),
    ).rejects.toThrow(/Unknown model 'bogus'/);
  });

  it("resolves devin binaries from DEVIN_PATH or SUMMARIZE_CLI_DEVIN", () => {
    expect(resolveCliBinary("devin", null, { DEVIN_PATH: "/custom/devin" })).toBe("/custom/devin");
    expect(resolveCliBinary("devin", null, { SUMMARIZE_CLI_DEVIN: "/env/devin" })).toBe(
      "/env/devin",
    );
    expect(resolveCliBinary("devin", { devin: { binary: "/cfg/devin" } }, {})).toBe("/cfg/devin");
    expect(resolveCliBinary("devin", null, {})).toBe("devin");
  });
});

describe("parseDevinOutputFromAtif", () => {
  it("reads the final agent message and metrics", () => {
    const parsed = parseDevinOutputFromAtif(
      atifDocument("Last agent reply.", {
        total_prompt_tokens: 120,
        total_completion_tokens: 8,
        total_cached_tokens: 30,
        total_steps: 4,
      }),
    );
    expect(parsed).toEqual({
      text: "Last agent reply.",
      usage: { promptTokens: 120, completionTokens: 8, totalTokens: 128 },
      costUsd: null,
    });
  });

  it("keeps the last non-empty agent message", () => {
    const doc = JSON.stringify({
      steps: [
        { source: "agent", message: "first" },
        { source: "agent", message: "final" },
        { source: "agent", message: "  " },
      ],
    });
    expect(parseDevinOutputFromAtif(doc).text).toBe("final");
  });

  it("joins array-form agent message content parts", () => {
    const doc = JSON.stringify({
      steps: [
        { source: "agent", message: [{ type: "text", text: "part one. " }, { text: "part two." }] },
      ],
    });
    expect(parseDevinOutputFromAtif(doc).text).toBe("part one. part two.");
  });

  it("returns null usage when metrics are missing", () => {
    expect(parseDevinOutputFromAtif(atifDocument("hi")).usage).toBeNull();
  });

  it("returns empty text without an agent step", () => {
    const doc = JSON.stringify({ steps: [{ source: "system", message: "x" }] });
    expect(parseDevinOutputFromAtif(doc).text).toBe("");
  });
});
