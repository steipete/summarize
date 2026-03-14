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
};

const PROVIDER_PATH_ENV: Record<CliProvider, string> = {
  claude: "CLAUDE_PATH",
  codex: "CODEX_PATH",
  gemini: "GEMINI_PATH",
  agent: "AGENT_PATH",
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

const CODEX_META_ONLY_OUTPUT_ERROR =
  "Codex returned no assistant text; stdout only contained session/meta events.";

const CODEX_FOOTER_LINE_PATTERN = /\bcli\/codex(?:\/\S+)?$/;
const CODEX_TEXT_PAYLOAD_KEYS = [
  "result",
  "response",
  "output",
  "message",
  "text",
  "content",
] as const;

function hasTextPayloadValue(value: unknown): boolean {
  if (typeof value === "string") return value.trim().length > 0;
  if (Array.isArray(value)) return value.some((entry) => hasTextPayloadValue(entry));
  if (!value || typeof value !== "object") return false;
  return hasTextPayload(value as Record<string, unknown>);
}

function hasTextPayload(payload: Record<string, unknown>): boolean {
  return CODEX_TEXT_PAYLOAD_KEYS.some((key) => hasTextPayloadValue(payload[key]));
}

function parseJsonRecord(line: string): Record<string, unknown> | null {
  if (!line.startsWith("{")) return null;
  try {
    const parsed = JSON.parse(line) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

function isCodexFooterLine(line: string): boolean {
  return line.includes("·") && CODEX_FOOTER_LINE_PATTERN.test(line);
}

function isCodexMetaOnlyOutput(output: string): boolean {
  const lines = output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  if (lines.length === 0) return false;
  let sawMeta = false;
  for (const line of lines) {
    if (isCodexFooterLine(line)) {
      sawMeta = true;
      continue;
    }
    const payload = parseJsonRecord(line);
    if (!payload) return false;
    if (typeof payload.type !== "string" || hasTextPayload(payload)) {
      return false;
    }
    sawMeta = true;
  }
  return sawMeta;
}

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
      if (isCodexMetaOnlyOutput(stdoutText)) {
        throw new Error(CODEX_META_ONLY_OUTPUT_ERROR);
      }
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
