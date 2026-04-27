import { promises as fs } from "node:fs";
import path from "node:path";
import type { CliProvider } from "../config.js";

const STATE_FILE_NAME = "cli-state.json";

function resolveStatePath(env: Record<string, string | undefined>): string | null {
  const home = env.HOME?.trim() || env.USERPROFILE?.trim();
  if (!home) return null;
  return path.join(home, ".summarize", STATE_FILE_NAME);
}

function parseCliProvider(value: unknown): CliProvider | null {
  if (
    value === "claude" ||
    value === "codex" ||
    value === "gemini" ||
    value === "agent" ||
    value === "openclaw" ||
    value === "opencode" ||
    value === "copilot"
  ) {
    return value;
  }
  return null;
}

export async function readLastSuccessfulCliProvider(
  env: Record<string, string | undefined>,
): Promise<CliProvider | null> {
  const statePath = resolveStatePath(env);
  if (!statePath) return null;
  try {
    const raw = await fs.readFile(statePath, "utf8");
    const parsed = JSON.parse(raw) as { lastSuccessfulProvider?: unknown };
    return parseCliProvider(parsed.lastSuccessfulProvider);
  } catch {
    return null;
  }
}

export async function writeLastSuccessfulCliProvider({
  env,
  provider,
}: {
  env: Record<string, string | undefined>;
  provider: CliProvider;
}): Promise<void> {
  const statePath = resolveStatePath(env);
  if (!statePath) return;
  try {
    await fs.mkdir(path.dirname(statePath), { recursive: true });
    const payload = {
      lastSuccessfulProvider: provider,
      updatedAt: new Date().toISOString(),
    };
    await fs.writeFile(statePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  } catch {
    // Best-effort cache; failures should not affect summary output.
  }
}
