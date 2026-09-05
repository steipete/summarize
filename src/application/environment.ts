import { accessSync, constants as fsConstants } from "node:fs";
import path from "node:path";
import type { CliProvider, SummarizeConfig } from "../config.js";
import { isCliDisabled, resolveCliBinary } from "../llm/cli.js";

function isExecutable(filePath: string): boolean {
  try {
    accessSync(filePath, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export function resolveExecutableInPath(
  binary: string,
  env: Record<string, string | undefined>,
  explicitEnvKey?: string,
): string | null {
  const explicit =
    explicitEnvKey && typeof env[explicitEnvKey] === "string" ? env[explicitEnvKey]?.trim() : "";
  if (explicit) binary = explicit;
  if (!binary) return null;
  if (path.isAbsolute(binary)) {
    return isExecutable(binary) ? binary : null;
  }
  const pathEnv = env.PATH ?? "";
  for (const entry of pathEnv.split(path.delimiter)) {
    if (!entry) continue;
    const candidate = path.join(entry, binary);
    if (isExecutable(candidate)) return candidate;
  }
  return null;
}

export function resolveCliAvailability({
  env,
  config,
}: {
  env: Record<string, string | undefined>;
  config: SummarizeConfig | null;
}): Partial<Record<CliProvider, boolean>> {
  const cliConfig = config?.cli ?? null;
  const providers: CliProvider[] = [
    "claude",
    "codex",
    "gemini",
    "agent",
    "openclaw",
    "opencode",
    "copilot",
    "agy",
    "pi",
  ];
  const availability: Partial<Record<CliProvider, boolean>> = {};
  for (const provider of providers) {
    if (isCliDisabled(provider, cliConfig)) {
      availability[provider] = false;
      continue;
    }
    const binary = resolveCliBinary(provider, cliConfig, env);
    availability[provider] = resolveExecutableInPath(binary, env) !== null;
  }
  return availability;
}

export function parseBooleanEnv(value: string | null | undefined): boolean | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  if (normalized.length === 0) return null;
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return null;
}
