import fs from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { execCliWithInput } from "../cli-exec.js";
import { extractGrokError, parseGrokOutput } from "../cli-provider-output.js";
import type { CliRunResult, ResolvedCliRunOptions } from "./types.js";

function validateExtraArgs(args: string[]): void {
  const allowed = ["--reasoning-effort", "--effort", "--max-turns"];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] ?? "";
    const flag = arg.split("=", 1)[0] ?? "";
    if (!allowed.includes(flag)) {
      throw new Error(
        `Grok extraArgs only support ${allowed.join(", ")}; use cli.grok.model for model selection.`,
      );
    }
    if (!arg.includes("=")) {
      const value = args[++index];
      if (!value || value.startsWith("-")) throw new Error(`Missing value for Grok ${flag}`);
    }
  }
}

async function assertNoProjectAncestor(cwd: string): Promise<void> {
  let directory = await fs.realpath(cwd);
  for (;;) {
    for (const marker of [".git", ".jj", ".grok", ".claude", ".cursor", "AGENTS.md", "CLAUDE.md"]) {
      try {
        await fs.lstat(path.join(directory, marker));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw error;
      }
      throw new Error(
        "Grok isolation requires a temporary directory outside project and agent configuration. Set TMPDIR or TEMP to a clean directory.",
      );
    }
    const parent = path.dirname(directory);
    if (parent === directory) return;
    directory = parent;
  }
}

async function isolatedEnvironment(
  source: Record<string, string | undefined>,
  home: string,
): Promise<Record<string, string | undefined>> {
  const grokHome = path.join(home, ".grok");
  await fs.mkdir(grokHome, { mode: 0o700 });
  const sourceHome =
    source.GROK_HOME?.trim() ||
    path.join(source.HOME?.trim() || source.USERPROFILE?.trim() || homedir(), ".grok");
  const authPath = path.join(grokHome, "auth.json");
  try {
    await fs.copyFile(path.join(sourceHome, "auth.json"), authPath);
    await fs.chmod(authPath, 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  // Custom profiles fail closed even on platforms where a built-in profile may warn and continue.
  await fs.writeFile(
    path.join(grokHome, "sandbox.toml"),
    '[profiles.summarize]\nextends = "strict"\n',
    { mode: 0o600 },
  );
  // GROK_HOME alone still imports Claude/Cursor hooks and rules from HOME.
  const env: Record<string, string | undefined> = {};
  for (const key of [
    "PATH",
    "SystemRoot",
    "WINDIR",
    "LANG",
    "LC_ALL",
    "LC_CTYPE",
    "TZ",
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "ALL_PROXY",
    "NO_PROXY",
    "http_proxy",
    "https_proxy",
    "all_proxy",
    "no_proxy",
    "SSL_CERT_FILE",
    "SSL_CERT_DIR",
    "XAI_API_KEY",
  ]) {
    if (source[key] !== undefined) env[key] = source[key];
  }
  return {
    ...env,
    HOME: home,
    USERPROFILE: home,
    GROK_HOME: grokHome,
    XDG_CONFIG_HOME: path.join(home, ".config"),
    XDG_DATA_HOME: path.join(home, ".local", "share"),
    XDG_CACHE_HOME: path.join(home, ".cache"),
    APPDATA: path.join(home, "AppData", "Roaming"),
    LOCALAPPDATA: path.join(home, "AppData", "Local"),
  };
}

export async function runGrokCli(options: ResolvedCliRunOptions): Promise<CliRunResult> {
  validateExtraArgs(options.providerExtraArgs);
  if (!options.allowTools && options.providerConfig?.isolated === false) {
    throw new Error("Grok text summaries require isolation; remove cli.grok.isolated: false.");
  }
  const root = await fs.mkdtemp(path.join(tmpdir(), "summarize-grok-"));
  try {
    const isolated = !options.allowTools;
    if (isolated) await assertNoProjectAncestor(root);
    const cwd = path.join(root, "work");
    await fs.mkdir(cwd, { mode: 0o700 });
    let env = options.env;
    if (isolated) {
      const home = path.join(root, "home");
      await fs.mkdir(home, { mode: 0o700 });
      env = await isolatedEnvironment({ ...process.env, ...options.env }, home);
    }
    const promptPath = path.join(cwd, "prompt.txt");
    const prompt = options.systemPrompt
      ? `${options.systemPrompt}\n\n${options.prompt}`
      : options.prompt;
    await fs.writeFile(promptPath, prompt, { mode: 0o600 });
    const args = [
      ...options.providerExtraArgs,
      "--prompt-file",
      promptPath,
      "--output-format",
      "json",
    ];
    if (isolated) {
      // An empty --tools list is ignored by Grok. Select one real tool, then remove it.
      args.push(
        "--tools",
        "list_dir",
        "--disallowed-tools",
        "list_dir",
        "--deny",
        "*",
        "--deny",
        "MCPTool(*)",
        "--permission-mode",
        "dontAsk",
        "--sandbox",
        "summarize",
        "--no-plan",
        "--no-subagents",
        "--disable-web-search",
      );
    } else {
      args.push("--always-approve", "--sandbox", "off");
    }
    if (options.requestedModel) args.push("-m", options.requestedModel);
    let stdout: string;
    try {
      ({ stdout } = await execCliWithInput({
        execFileImpl: options.execFileImpl,
        cmd: options.binary,
        args,
        input: "",
        timeoutMs: options.timeoutMs,
        env,
        inheritEnv: !isolated,
        cwd: isolated ? cwd : options.cwd,
        signal: options.signal,
      }));
    } catch (error) {
      const failedStdout = (error as { stdout?: unknown } | null)?.stdout;
      const detail = typeof failedStdout === "string" ? extractGrokError(failedStdout) : null;
      if (detail) throw new Error(detail, { cause: error });
      throw error;
    }
    return parseGrokOutput(stdout);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}
