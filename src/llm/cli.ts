import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { CliConfig, CliProvider } from "../config.js";
import type { ExecFileFn } from "../markitdown.js";
import { execCliWithInput } from "./cli-exec.js";
import {
  isJsonCliProvider,
  parseCodexUsageFromJsonl,
  parseJsonProviderOutput,
  type JsonCliProvider,
} from "./cli-provider-output.js";
import type { LlmTokenUsage } from "./generate-text.js";

const DEFAULT_BINARIES: Record<CliProvider, string> = {
  claude: "claude",
  codex: "codex",
  gemini: "gemini",
  agent: "agent",
  openclaw: "openclaw",
};

const PROVIDER_PATH_ENV: Record<CliProvider, string> = {
  claude: "CLAUDE_PATH",
  codex: "CODEX_PATH",
  gemini: "GEMINI_PATH",
  agent: "AGENT_PATH",
  openclaw: "OPENCLAW_PATH",
};

type RunCliModelOptions = {
  provider: CliProvider;
  prompt: string;
  model: string | null;
  allowTools: boolean;
  timeoutMs: number;
  env: Record<string, string | undefined>;
  execFileImpl?: ExecFileFn;
  config: CliConfig | null;
  cwd?: string;
  extraArgs?: string[];
};

type CliRunResult = {
  text: string;
  usage: LlmTokenUsage | null;
  costUsd: number | null;
};

const isNonEmptyString = (value: unknown): value is string =>
  typeof value === "string" && value.trim().length > 0;

function getCliProviderConfig(
  provider: CliProvider,
  config: CliConfig | null | undefined,
): CliConfig[CliProvider] | undefined {
  if (!config) return undefined;
  if (provider === "claude") return config.claude;
  if (provider === "codex") return config.codex;
  if (provider === "gemini") return config.gemini;
  return config.agent;
}

export function isCliDisabled(
  provider: CliProvider,
  config: CliConfig | null | undefined,
): boolean {
  if (!config) return false;
  if (Array.isArray(config.enabled) && !config.enabled.includes(provider)) return true;
  return false;
}

export function resolveCliBinary(
  provider: CliProvider,
  config: CliConfig | null | undefined,
  env: Record<string, string | undefined>,
): string {
  const providerConfig = getCliProviderConfig(provider, config);
  if (isNonEmptyString(providerConfig?.binary)) return providerConfig.binary.trim();
  const pathKey = PROVIDER_PATH_ENV[provider];
  if (isNonEmptyString(env[pathKey])) return env[pathKey].trim();
  const envKey = `SUMMARIZE_CLI_${provider.toUpperCase()}`;
  if (isNonEmptyString(env[envKey])) return env[envKey].trim();
  return DEFAULT_BINARIES[provider];
}

function appendJsonProviderArgs({
  provider,
  args,
  allowTools,
  model,
  prompt,
}: {
  provider: JsonCliProvider;
  args: string[];
  allowTools: boolean;
  model: string | null;
  prompt: string;
}): string {
  if (provider === "claude" || provider === "agent") {
    args.push("--print");
  }
  args.push("--output-format", "json");
  if (provider === "agent" && !allowTools) {
    args.push("--mode", "ask");
  }
  if (model && model.trim().length > 0) {
    args.push("--model", model.trim());
  }
  if (allowTools) {
    if (provider === "claude") {
      args.push("--tools", "Read", "--dangerously-skip-permissions");
    }
    if (provider === "gemini") {
      args.push("--yolo");
    }
  }
  if (provider === "agent") {
    args.push(prompt);
    return "";
  }
  if (provider === "gemini") {
    args.push("--prompt", prompt);
    return "";
  }
  return prompt;
}

export async function runCliModel({
  provider,
  prompt,
  model,
  allowTools,
  timeoutMs,
  env,
  execFileImpl,
  config,
  cwd,
  extraArgs,
}: RunCliModelOptions): Promise<CliRunResult> {
  const execFileFn = execFileImpl ?? execFile;
  const binary = resolveCliBinary(provider, config, env);
  const args: string[] = [];

  const effectiveEnv =
    provider === "gemini" && !isNonEmptyString(env.GEMINI_CLI_NO_RELAUNCH)
      ? { ...env, GEMINI_CLI_NO_RELAUNCH: "true" }
      : env;

  const providerConfig = getCliProviderConfig(provider, config);

  if (providerConfig?.extraArgs?.length) {
    args.push(...providerConfig.extraArgs);
  }
  if (extraArgs?.length) {
    args.push(...extraArgs);
  }
  if (provider === "openclaw") {
    const args = [
      "agent",
      "--agent",
      model && model.trim().length > 0 ? model.trim() : "main",
      "--message",
      prompt,
      "--json",
      "--timeout",
      String(Math.max(1, Math.ceil(timeoutMs / 1000))),
    ];
    const { stdout } = await execCliWithInput({
      execFileImpl: execFileFn,
      cmd: binary,
      args,
      input: "",
      timeoutMs,
      env: effectiveEnv,
      cwd,
    });
    const parsed = JSON.parse(stdout);
    const payloads = parsed?.result?.payloads;
    const text = Array.isArray(payloads)
      ? payloads
          .map((p) => (typeof p?.text === "string" ? p.text : ""))
          .filter(Boolean)
          .join("\n\n")
      : "";
    if (!text.trim()) throw new Error("OpenClaw CLI returned empty output");
    const usage = parsed?.result?.meta?.agentMeta?.lastCallUsage ?? parsed?.result?.meta?.agentMeta?.usage ?? null;
    return { text: text.trim(), usage, costUsd: null };
  }

  if (provider === "codex") {
    const outputDir = await fs.mkdtemp(path.join(tmpdir(), "summarize-codex-"));
    const outputPath = path.join(outputDir, "last-message.txt");
    args.push("exec", "--output-last-message", outputPath, "--skip-git-repo-check", "--json");
    if (model && model.trim().length > 0) {
      args.push("-m", model.trim());
    }
    const hasVerbosityOverride = args.some((arg) => arg.includes("text.verbosity"));
    if (!hasVerbosityOverride) {
      args.push("-c", 'text.verbosity="medium"');
    }
    const { stdout } = await execCliWithInput({
      execFileImpl: execFileFn,
      cmd: binary,
      args,
      input: prompt,
      timeoutMs,
      env: effectiveEnv,
      cwd,
    });
    const { usage, costUsd } = parseCodexUsageFromJsonl(stdout);
    let fileText = "";
    try {
      fileText = (await fs.readFile(outputPath, "utf8")).trim();
    } catch {
      fileText = "";
    }
    if (fileText) {
      return { text: fileText, usage, costUsd };
    }
    const stdoutText = stdout.trim();
    if (stdoutText) {
      return { text: stdoutText, usage, costUsd };
    }
    throw new Error("CLI returned empty output");
  }

  if (!isJsonCliProvider(provider)) {
    throw new Error(`Unsupported CLI provider "${provider}".`);
  }
  const input = appendJsonProviderArgs({ provider, args, allowTools, model, prompt });

  const { stdout } = await execCliWithInput({
    execFileImpl: execFileFn,
    cmd: binary,
    args,
    input,
    timeoutMs,
    env: effectiveEnv,
    cwd,
  });
  return parseJsonProviderOutput({ provider, stdout });
}
