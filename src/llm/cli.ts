import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { CliConfig, CliProvider } from "../config.js";
import type { ExecFileFn } from "../markitdown.js";
import { execCliWithInput } from "./cli-exec.js";
import {
  parseCodexOutputFromJsonl,
  isJsonCliProvider,
  parseCodexUsageFromJsonl,
  parseOpenCodeOutputFromJsonl,
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
  opencode: "opencode",
  copilot: "copilot",
};

const OPENCLAW_MAX_MESSAGE_ARG_BYTES = 120 * 1024;
const CODEX_GPT_FAST_MODEL = "gpt-5.5";
const CODEX_GPT_FAST_ALIASES = new Set(["gpt-fast", "gpt-5.5-fast"]);

const PROVIDER_PATH_ENV: Record<CliProvider, string> = {
  claude: "CLAUDE_PATH",
  codex: "CODEX_PATH",
  gemini: "GEMINI_PATH",
  agent: "AGENT_PATH",
  openclaw: "OPENCLAW_PATH",
  opencode: "OPENCODE_PATH",
  copilot: "COPILOT_PATH",
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
  if (provider === "agent") return config.agent;
  if (provider === "openclaw") return config.openclaw;
  if (provider === "opencode") return config.opencode;
  return config.copilot;
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

function hasCodexConfigOverride(args: string[], key: string): boolean {
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] !== "-c" && args[i] !== "--config") continue;
    const next = args[i + 1] ?? "";
    if (next.trim().startsWith(`${key}=`)) return true;
  }
  return false;
}

function resolveCodexModelAndArgs(
  requestedModel: string | null,
  providerExtraArgs: string[],
): { model: string | null; extraArgs: string[] } {
  const normalized = requestedModel?.trim().toLowerCase() ?? "";
  if (!CODEX_GPT_FAST_ALIASES.has(normalized)) {
    return { model: requestedModel, extraArgs: providerExtraArgs };
  }

  const extraArgs = [...providerExtraArgs];
  if (!hasCodexConfigOverride(extraArgs, "service_tier")) {
    extraArgs.push("-c", 'service_tier="fast"');
  }
  return { model: CODEX_GPT_FAST_MODEL, extraArgs };
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
  const requestedModel = isNonEmptyString(model)
    ? model.trim()
    : isNonEmptyString(providerConfig?.model)
      ? providerConfig.model.trim()
      : null;
  const providerExtraArgs: string[] = [];
  if (providerConfig?.extraArgs?.length) {
    providerExtraArgs.push(...providerConfig.extraArgs);
  }
  if (extraArgs?.length) {
    providerExtraArgs.push(...extraArgs);
  }
  if (provider === "openclaw") {
    const promptBytes = Buffer.byteLength(prompt, "utf8");
    if (promptBytes > OPENCLAW_MAX_MESSAGE_ARG_BYTES) {
      throw new Error(
        `OpenClaw CLI requires --message and cannot safely receive large prompts over argv (${promptBytes} bytes). ` +
          "Use a different CLI provider for this input, reduce extracted content, or update OpenClaw to support stdin/file input.",
      );
    }
    const openclawArgs = [
      ...providerExtraArgs,
      "agent",
      "--agent",
      requestedModel ?? "main",
      "-m",
      prompt,
      "--json",
      "--timeout",
      String(Math.max(1, Math.ceil(timeoutMs / 1000))),
    ];
    const { stdout } = await execCliWithInput({
      execFileImpl: execFileFn,
      cmd: binary,
      args: openclawArgs,
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
    const usage =
      parsed?.result?.meta?.agentMeta?.lastCallUsage ??
      parsed?.result?.meta?.agentMeta?.usage ??
      null;
    return { text: text.trim(), usage, costUsd: null };
  }

  if (provider === "opencode") {
    const isolatedCwd =
      !allowTools && !cwd ? await fs.mkdtemp(path.join(tmpdir(), "summarize-opencode-")) : null;
    try {
      args.push("run", ...providerExtraArgs, "--format", "json");
      if (requestedModel) {
        args.push("--model", requestedModel);
      }
      const { stdout } = await execCliWithInput({
        execFileImpl: execFileFn,
        cmd: binary,
        args,
        input: prompt,
        timeoutMs,
        env: effectiveEnv,
        cwd: isolatedCwd ?? cwd,
      });
      return parseOpenCodeOutputFromJsonl(stdout);
    } finally {
      if (isolatedCwd) {
        await fs.rm(isolatedCwd, { recursive: true, force: true }).catch(() => {});
      }
    }
  }

  if (provider === "codex") {
    const { model: codexModel, extraArgs: codexExtraArgs } = resolveCodexModelAndArgs(
      requestedModel,
      providerExtraArgs,
    );
    const outputDir = await fs.mkdtemp(path.join(tmpdir(), "summarize-codex-"));
    const outputPath = path.join(outputDir, "last-message.txt");
    args.push(...codexExtraArgs);
    args.push("exec", "--output-last-message", outputPath, "--skip-git-repo-check", "--json");
    if (codexModel) {
      args.push("-m", codexModel);
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
    const parsedStdout = parseCodexOutputFromJsonl(stdout);
    if (parsedStdout.text) {
      return { text: parsedStdout.text, usage, costUsd };
    }
    if (parsedStdout.sawStructuredEvent) {
      throw new Error("CLI returned empty output");
    }
    const stdoutText = stdout.trim();
    if (stdoutText) {
      return { text: stdoutText, usage, costUsd };
    }
    throw new Error("CLI returned empty output");
  }

  if (provider === "copilot") {
    const copilotArgs: string[] = [...providerExtraArgs, "-p", prompt];
    if (allowTools) {
      copilotArgs.push("--allow-all-tools");
    }
    if (requestedModel) {
      copilotArgs.push("--model", requestedModel);
    }
    const { stdout } = await execCliWithInput({
      execFileImpl: execFileFn,
      cmd: binary,
      args: copilotArgs,
      input: "",
      timeoutMs,
      env: effectiveEnv,
      cwd,
    });
    const text = stdout.trim();
    if (!text) throw new Error("CLI returned empty output");
    return { text, usage: null, costUsd: null };
  }

  if (!isJsonCliProvider(provider)) {
    throw new Error(`Unsupported CLI provider "${provider}".`);
  }
  args.push(...providerExtraArgs);
  const input = appendJsonProviderArgs({
    provider,
    args,
    allowTools,
    model: requestedModel,
    prompt,
  });

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
