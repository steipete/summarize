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

// Returns { value } when the flag carries a value (`--flag x` or `--flag=x`),
// { value: null } for a bare flag. `--export` takes an optional path, so a
// following flag-shaped token is not its value.
function findFlagValue(args: string[], flag: string): { present: boolean; value: string | null } {
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === flag) {
      const next = args[i + 1];
      return { present: true, value: next !== undefined && !next.startsWith("-") ? next : null };
    }
    if (arg.startsWith(`${flag}=`)) {
      return { present: true, value: arg.slice(flag.length + 1) || null };
    }
  }
  return { present: false, value: null };
}

function devinHomeDir(env: Record<string, string | undefined>): string {
  return env.HOME?.trim() || env.USERPROFILE?.trim() || homedir();
}

function devinConfigRoot(env: Record<string, string | undefined>): string {
  if (env.XDG_CONFIG_HOME?.trim()) return env.XDG_CONFIG_HOME.trim();
  // Devin keeps config.json and credentials.toml under Roaming %APPDATA%\devin.
  if (process.platform === "win32") {
    return env.APPDATA?.trim() || path.join(devinHomeDir(env), "AppData", "Roaming");
  }
  return path.join(devinHomeDir(env), ".config");
}

function devinDataRoot(env: Record<string, string | undefined>): string {
  if (env.XDG_DATA_HOME?.trim()) return env.XDG_DATA_HOME.trim();
  if (process.platform === "win32") {
    return env.APPDATA?.trim() || path.join(devinHomeDir(env), "AppData", "Roaming");
  }
  return path.join(devinHomeDir(env), ".local", "share");
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
  // Note: an explicit options.cwd is preserved under isolation (parity with
  // codex), which means project-level .devin/ config in that directory can
  // still apply — callers must treat cwd as trusted input.
  const shouldIsolate = !options.allowTools && options.providerConfig?.isolated !== false;
  const workDir = await fs.mkdtemp(path.join(tmpdir(), "summarize-devin-"));
  const promptPath = path.join(workDir, "prompt.txt");
  const atifPath = path.join(workDir, "atif.json");
  const isolatedCwd = shouldIsolate && !options.cwd ? path.join(workDir, "cwd") : null;
  // On Windows Devin keeps config.json and credentials.toml in one Roaming
  // %APPDATA%\devin dir, so a single root backs both app-data vars.
  const unifiedHome = shouldIsolate && process.platform === "win32";
  const isolatedConfigRoot = shouldIsolate
    ? path.join(workDir, unifiedHome ? "home" : "config")
    : null;
  const isolatedDataRoot = shouldIsolate ? path.join(workDir, unifiedHome ? "home" : "data") : null;
  try {
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
        ...(isolatedCwd ? [fs.mkdir(isolatedCwd, { recursive: true })] : []),
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
    // A user-supplied --export wins (devin rejects duplicate flags); their path
    // — or the agent_logs default for a bare --export — is read instead.
    const exportFlag = findFlagValue(args, "--export");
    if (!exportFlag.present) args.push("--export", atifPath);
    // Pin deterministic mode: inherited DEVIN_PERMISSION_MODE / trust settings
    // must not escalate or block a headless run.
    if (!hasAnyFlag(args, ["--permission-mode"])) args.push("--permission-mode", "auto");
    if (!hasAnyFlag(args, ["--respect-workspace-trust"])) {
      args.push("--respect-workspace-trust", "false");
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
    const effectiveCwd = isolatedCwd ?? options.cwd ?? process.cwd();
    // Bare `--export` lands in <dataRoot>/devin/cli/agent_logs/devin-*.json;
    // snapshot the dir so only files created by this run are candidates.
    const agentLogsDir =
      exportFlag.present && !exportFlag.value
        ? path.join(isolatedDataRoot ?? devinDataRoot(lookupEnv), "devin", "cli", "agent_logs")
        : null;
    const priorLogs = agentLogsDir
      ? new Set(await fs.readdir(agentLogsDir).catch(() => [] as string[]))
      : null;
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
    const readAtif = async (): Promise<string> => {
      const explicit = exportFlag.value ? path.resolve(effectiveCwd, exportFlag.value) : atifPath;
      const raw = await fs.readFile(explicit, "utf8").catch(() => "");
      if (raw.trim()) return raw;
      if (agentLogsDir && priorLogs) {
        const fresh = (await fs.readdir(agentLogsDir).catch(() => [] as string[]))
          .filter((name) => name.endsWith(".json") && !priorLogs.has(name))
          .sort();
        // In trusted mode a concurrent devin session can add logs too, so only
        // an unambiguous single new file is usable; the isolated dir is private.
        const candidate = shouldIsolate ? fresh.at(-1) : fresh.length === 1 ? fresh[0] : null;
        if (candidate) {
          return await fs.readFile(path.join(agentLogsDir, candidate), "utf8").catch(() => "");
        }
      }
      return "";
    };
    const atifRaw = await readAtif();
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
