import { spawn } from "node:child_process";
import { resolveExecutableInPath } from "../application/environment.js";
import type { CliProvider } from "../config.js";
export { parseCliUserModelId } from "../engine/cli-model-id.js";

export async function canSpawnCommand({
  command,
  args = ["--help"],
  env,
}: {
  command: string;
  args?: string[];
  env: Record<string, string | undefined>;
}): Promise<boolean> {
  if (!command.trim()) return false;
  return new Promise((resolve) => {
    const proc = spawn(command, args, {
      stdio: ["ignore", "ignore", "ignore"],
      env,
      windowsHide: true,
    });
    proc.on("error", () => resolve(false));
    proc.on("close", (code) => resolve(code === 0));
  });
}

export function hasBirdCli(env: Record<string, string | undefined>): boolean {
  return resolveExecutableInPath("bird", env) !== null;
}

export function hasXurlCli(env: Record<string, string | undefined>): boolean {
  return resolveExecutableInPath("xurl", env) !== null;
}

export function hasUvxCli(env: Record<string, string | undefined>): boolean {
  if (typeof env.UVX_PATH === "string" && env.UVX_PATH.trim().length > 0) {
    return true;
  }
  return resolveExecutableInPath("uvx", env) !== null;
}

export function parseCliProviderArg(raw: string): CliProvider {
  const normalized = raw.trim().toLowerCase();
  if (
    normalized === "claude" ||
    normalized === "codex" ||
    normalized === "gemini" ||
    normalized === "agent" ||
    normalized === "openclaw" ||
    normalized === "opencode" ||
    normalized === "copilot" ||
    normalized === "agy" ||
    normalized === "pi" ||
    normalized === "devin" ||
    normalized === "grok"
  ) {
    return normalized as CliProvider;
  }
  throw new Error(`Unsupported --cli: ${raw}`);
}
