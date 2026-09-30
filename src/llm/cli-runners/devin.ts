import fs from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import JSON5 from "json5";
import { execCliWithInput } from "../cli-exec.js";
import { parseDevinOutputFromAtif } from "../cli-provider-output.js";
import type { CliRunResult, ResolvedCliRunOptions } from "./types.js";

// Denied tool names for tool-free summaries. Verified against devin 3000.x:
// permissions.deny hard-blocks tools even under --permission-mode dangerous.
// Includes documented synonyms (glob/web_fetch) defensively.
const DEVIN_ALL_TOOLS = [
  "read",
  "grep",
  "glob",
  "find_file_by_name",
  "edit",
  "write",
  "apply_patch",
  "notebook_edit",
  "notebook_read",
  "exec",
  "write_to_process",
  "kill_shell",
  "get_output",
  "web_search",
  "webfetch",
  "web_fetch",
  "run_subagent",
  "read_subagent",
  "ask_user_question",
  "todo_write",
  "browser_preview",
  "close_browser_preview",
  "skill",
  "request_scope",
  "mcp_call_tool",
  "mcp_list_servers",
  "mcp_list_tools",
  "mcp_read_resource",
  "mcp_list_resources",
];

// i18n-ignore: matches Devin CLI's own onboarding banner text
const DEVIN_BANNER_LINE = /welcome to devin cli/i;

function hasAnyFlag(args: string[], flags: string[]): boolean {
  return args.some((arg) => flags.some((flag) => arg === flag || arg.startsWith(`${flag}=`)));
}

function devinHomeDir(env: Record<string, string | undefined>): string {
  return env.HOME?.trim() || env.USERPROFILE?.trim() || homedir();
}

function devinConfigRoot(env: Record<string, string | undefined>): string {
  // Devin keeps config.json and credentials.toml under Roaming %APPDATA%\devin.
  if (process.platform === "win32") {
    return env.APPDATA?.trim() || path.join(devinHomeDir(env), "AppData", "Roaming");
  }
  if (env.XDG_CONFIG_HOME?.trim()) return env.XDG_CONFIG_HOME.trim();
  return path.join(devinHomeDir(env), ".config");
}

function devinDataRoot(env: Record<string, string | undefined>): string {
  if (process.platform === "win32") {
    return env.APPDATA?.trim() || path.join(devinHomeDir(env), "AppData", "Roaming");
  }
  if (env.XDG_DATA_HOME?.trim()) return env.XDG_DATA_HOME.trim();
  return path.join(devinHomeDir(env), ".local", "share");
}

async function assertNoProjectAncestor(cwd: string): Promise<void> {
  let directory = await fs.realpath(cwd);
  for (;;) {
    const markers = await Promise.all(
      [".git", ".jj"].map(async (marker) => {
        try {
          await fs.lstat(path.join(directory, marker));
          return true;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
          throw error;
        }
      }),
    );
    if (markers.some(Boolean)) {
      throw new Error(
        "Devin isolation requires a temporary directory outside a Git or Jujutsu checkout. Set TMPDIR or TEMP to a directory outside the checkout.",
      );
    }
    const parent = path.dirname(directory);
    if (parent === directory) return;
    directory = parent;
  }
}

async function copyDevinAuth(sourceRoot: string, targetRoot: string): Promise<void> {
  const target = path.join(targetRoot, "devin");
  await fs.mkdir(target, { recursive: true });
  await fs
    .copyFile(
      path.join(sourceRoot, "devin", "credentials.toml"),
      path.join(target, "credentials.toml"),
    )
    .catch(() => {});
}

async function writeIsolatedConfig(sourcePath: string, targetPath: string): Promise<void> {
  let userConfig: Record<string, unknown> = {};
  try {
    // Devin config files allow comments (JSONC).
    const parsed = JSON5.parse(await fs.readFile(sourcePath, "utf8")) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      userConfig = parsed as Record<string, unknown>;
    }
  } catch {
    // No readable user config; the isolated config still enforces our rules.
  }
  const userDeny = (() => {
    const permissions = userConfig.permissions;
    if (!permissions || typeof permissions !== "object") return [];
    const deny = (permissions as Record<string, unknown>).deny;
    return Array.isArray(deny) ? deny.filter((v): v is string => typeof v === "string") : [];
  })();
  const userShell =
    userConfig.shell && typeof userConfig.shell === "object" && !Array.isArray(userConfig.shell)
      ? (userConfig.shell as Record<string, unknown>)
      : {};
  const config: Record<string, unknown> = {
    ...userConfig,
    auto_update: false,
    subagents_enabled: false,
    disable_plugins: true,
    show_hints: false,
    shell: { ...userShell, setup_complete: true },
    // Suppress auto-imported rules from other agent tools (e.g. ~/.claude/CLAUDE.md).
    // Unknown keys are tolerated, so plausible importers are disabled defensively.
    read_config_from: {
      claude: false,
      cursor: false,
      windsurf: false,
      vscode: false,
      opencode: false,
      zed: false,
      copilot: false,
      agents_standard: false,
      gemini: false,
      antigravity: false,
      cline: false,
      kiro: false,
      amazonq: false,
      amp: false,
    },
    permissions: { deny: [...new Set([...DEVIN_ALL_TOOLS, ...userDeny])] },
  };
  delete config.mcpServers;
  // Command hooks run in the CLI host regardless of the tool deny list.
  delete config.hooks;
  await fs.mkdir(path.dirname(targetPath), { recursive: true });
  await fs.writeFile(targetPath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
}

export async function runDevinCli(options: ResolvedCliRunOptions): Promise<CliRunResult> {
  // Tool-enabled runs keep the caller's environment so attachments and the
  // user's own Devin config/rules apply. Tool-free summaries get a fabricated
  // XDG home (fresh sessions, no user rules/MCP config/hooks, all tools denied).
  // Isolated text summaries never load project config, even with an explicit cwd.
  const shouldIsolate = !options.allowTools && options.providerConfig?.isolated !== false;
  const workDir = await fs.mkdtemp(path.join(tmpdir(), "summarize-devin-"));
  const promptPath = path.join(workDir, "prompt.txt");
  const atifPath = path.join(workDir, "atif.json");
  const isolatedCwd = shouldIsolate ? path.join(workDir, "cwd") : null;
  // On Windows Devin keeps config.json and credentials.toml in one Roaming
  // %APPDATA%\devin dir, so a single root backs both app-data vars.
  const unifiedHome = shouldIsolate && process.platform === "win32";
  const isolatedConfigRoot = shouldIsolate
    ? path.join(workDir, unifiedHome ? "home" : "config")
    : null;
  const isolatedDataRoot = shouldIsolate ? path.join(workDir, unifiedHome ? "home" : "data") : null;
  try {
    if (isolatedCwd) {
      await fs.mkdir(isolatedCwd, { recursive: true });
      // Devin walks upwards for project config; a fresh child directory is not a boundary.
      await assertNoProjectAncestor(isolatedCwd);
    }
    // Mirror the env the child actually sees when locating the user's real
    // config/credentials to copy.
    const lookupEnv = { ...process.env, ...options.env };
    if (isolatedConfigRoot && isolatedDataRoot) {
      await Promise.all([
        copyDevinAuth(devinDataRoot(lookupEnv), isolatedDataRoot),
        writeIsolatedConfig(
          path.join(devinConfigRoot(lookupEnv), "devin", "config.json"),
          path.join(isolatedConfigRoot, "devin", "config.json"),
        ),
      ]);
    }
    const prompt = options.systemPrompt
      ? `${options.systemPrompt.trim()}\n\n${options.prompt}`
      : options.prompt;
    await fs.writeFile(promptPath, prompt, { mode: 0o600 });
    // Everything after a `--` sentinel is prompt text for devin, so managed
    // flags must be inserted before it.
    const sentinelAt = options.providerExtraArgs.indexOf("--");
    const postSentinel = sentinelAt < 0 ? [] : options.providerExtraArgs.slice(sentinelAt);
    const args =
      sentinelAt < 0
        ? [...options.providerExtraArgs]
        : options.providerExtraArgs.slice(0, sentinelAt);
    if (shouldIsolate && hasAnyFlag(args, ["--config"])) {
      throw new Error(
        'cli.devin.extraArgs "--config" replaces the hardened isolated config; ' +
          "set cli.devin.isolated to false to supply a custom Devin config.",
      );
    }
    if (!hasAnyFlag(args, ["--prompt-file"])) args.push("--prompt-file", promptPath);
    if (!hasAnyFlag(args, ["-p", "--print"])) args.push("--print");
    if (hasAnyFlag(args, ["--export"])) {
      throw new Error(
        "cli.devin.extraArgs cannot override --export; Summarize requires a private result file for each run.",
      );
    }
    args.push("--export", atifPath);
    // Only our private empty cwd can bypass trust. Project hooks execute before
    // tool permissions, so caller directories must retain Devin's trust check.
    if (!hasAnyFlag(args, ["--permission-mode"])) args.push("--permission-mode", "auto");
    if (!hasAnyFlag(args, ["--respect-workspace-trust"])) {
      args.push("--respect-workspace-trust", isolatedCwd ? "false" : "true");
    }
    // A user --model in extraArgs wins over the requested model: devin rejects
    // duplicate flags, and configured extras are the documented last word.
    if (options.requestedModel && !hasAnyFlag(args, ["-m", "--model"])) {
      args.push("--model", options.requestedModel);
    }
    args.push(...postSentinel);
    const env =
      isolatedConfigRoot && isolatedDataRoot
        ? {
            ...options.env,
            XDG_CONFIG_HOME: isolatedConfigRoot,
            XDG_DATA_HOME: isolatedDataRoot,
            ...(unifiedHome
              ? { APPDATA: isolatedConfigRoot, LOCALAPPDATA: isolatedConfigRoot }
              : {}),
          }
        : options.env;
    const { stdout } = await execCliWithInput({
      execFileImpl: options.execFileImpl,
      cmd: options.binary,
      args,
      input: "",
      timeoutMs: options.timeoutMs,
      env,
      cwd: isolatedCwd ?? options.cwd,
      signal: options.signal,
    });
    const atifRaw = await fs.readFile(atifPath, "utf8").catch(() => "");
    if (atifRaw.trim()) {
      const parsed = (() => {
        try {
          return parseDevinOutputFromAtif(atifRaw);
        } catch {
          return null;
        }
      })();
      if (parsed?.text) return parsed;
    }
    // Only trusted-mode stdout is a usable fallback: an isolated run has a
    // fresh home, which prints a "Welcome to Devin CLI!" banner on every run.
    // The trusted path can hit that banner on a genuinely fresh install too,
    // so it is stripped along with ANSI escapes.
    if (!shouldIsolate) {
      const stdoutText = stdout
        .replace(/\u001b\[[0-9;?]*[a-zA-Z]/g, "")
        .split("\n")
        .filter((line) => !DEVIN_BANNER_LINE.test(line))
        .join("\n")
        .trim();
      if (stdoutText) return { text: stdoutText, usage: null, costUsd: null };
    }
    throw new Error("CLI returned empty output");
  } finally {
    await fs.rm(workDir, { recursive: true, force: true }).catch(() => {});
  }
}
