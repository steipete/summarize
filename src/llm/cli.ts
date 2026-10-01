import { execFile } from "node:child_process";
import type { CliConfig, CliProvider } from "../config.js";
import type { ExecFileFn } from "../markitdown.js";
import { runCodexCli } from "./cli-runners/codex.js";
import { runDevinCli } from "./cli-runners/devin.js";
import { runGrokCli } from "./cli-runners/grok.js";
import { runJsonCli } from "./cli-runners/json.js";
import { runOpenClawCli } from "./cli-runners/openclaw.js";
import { runOpenCodeCli } from "./cli-runners/opencode.js";
import { runPiCli } from "./cli-runners/pi.js";
import { runAgyCli, runCopilotCli } from "./cli-runners/plain.js";
import type { CliRunResult, ResolvedCliRunOptions } from "./cli-runners/types.js";

const DEFAULT_BINARIES: Record<CliProvider, string> = {
  claude: "claude",
  codex: "codex",
  gemini: "gemini",
  agent: "agent",
  openclaw: "openclaw",
  opencode: "opencode",
  copilot: "copilot",
  agy: "agy",
  pi: "pi",
  devin: "devin",
  grok: "grok",
};

const PROVIDER_PATH_ENV: Record<CliProvider, string> = {
  claude: "CLAUDE_PATH",
  codex: "CODEX_PATH",
  gemini: "GEMINI_PATH",
  agent: "AGENT_PATH",
  openclaw: "OPENCLAW_PATH",
  opencode: "OPENCODE_PATH",
  copilot: "COPILOT_PATH",
  agy: "AGY_PATH",
  pi: "PI_PATH",
  devin: "DEVIN_PATH",
  grok: "GROK_PATH",
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
  systemPrompt?: string | null;
  signal?: AbortSignal;
};

const isNonEmptyString = (value: unknown): value is string =>
  typeof value === "string" && value.trim().length > 0;

function getCliProviderConfig(
  provider: CliProvider,
  config: CliConfig | null | undefined,
): CliConfig[CliProvider] | undefined {
  if (!config) return undefined;
  return config[provider];
}

export function isCliDisabled(
  provider: CliProvider,
  config: CliConfig | null | undefined,
): boolean {
  return Boolean(config && Array.isArray(config.enabled) && !config.enabled.includes(provider));
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
  systemPrompt,
  signal,
}: RunCliModelOptions): Promise<CliRunResult> {
  const providerConfig = getCliProviderConfig(provider, config);
  const requestedModel = isNonEmptyString(model)
    ? model.trim()
    : isNonEmptyString(providerConfig?.model)
      ? providerConfig.model.trim()
      : null;
  const providerExtraArgs = [...(providerConfig?.extraArgs ?? []), ...(extraArgs ?? [])];
  const effectiveEnv =
    provider === "gemini" && !isNonEmptyString(env.GEMINI_CLI_NO_RELAUNCH)
      ? { ...env, GEMINI_CLI_NO_RELAUNCH: "true" }
      : env;
  const options: ResolvedCliRunOptions = {
    binary: resolveCliBinary(provider, config, env),
    prompt,
    requestedModel,
    allowTools,
    timeoutMs,
    env: effectiveEnv,
    execFileImpl: execFileImpl ?? execFile,
    providerConfig,
    providerExtraArgs,
    cwd,
    systemPrompt,
    signal,
  };

  if (provider === "openclaw") return await runOpenClawCli(options);
  if (provider === "opencode") return await runOpenCodeCli(options);
  if (provider === "codex") return await runCodexCli(options);
  if (provider === "copilot") return await runCopilotCli(options);
  if (provider === "agy") return await runAgyCli(options);
  if (provider === "pi") return await runPiCli(options);
  if (provider === "devin") return await runDevinCli(options);
  if (provider === "grok") return await runGrokCli(options);
  return await runJsonCli(provider, options);
}
