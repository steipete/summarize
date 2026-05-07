import fs from "node:fs/promises";
import path from "node:path";
import { DAEMON_CONFIG_DIR, DAEMON_CONFIG_FILENAME, DAEMON_PORT_DEFAULT } from "./constants.js";
import type { EnvSnapshot } from "./env-snapshot.js";

export type DaemonConfigV1 = {
  version: 1;
  token: string;
  port: number;
  env: EnvSnapshot;
  installedAt: string;
};

export type DaemonConfigV2 = {
  version: 2;
  token: string;
  tokens: string[];
  port: number;
  env: EnvSnapshot;
  installedAt: string;
};

export type DaemonConfig = DaemonConfigV1 | DaemonConfigV2;

function trimDaemonToken(raw: string): string {
  const token = raw.trim();
  if (!token) throw new Error("Missing token");
  return token;
}

function resolveHomeDir(env: Record<string, string | undefined>): string {
  const home = env.HOME?.trim() || env.USERPROFILE?.trim();
  if (!home) throw new Error("Missing HOME (required for daemon config)");
  return home;
}

export function resolveDaemonConfigPath(env: Record<string, string | undefined>): string {
  const home = resolveHomeDir(env);
  return path.join(home, DAEMON_CONFIG_DIR, DAEMON_CONFIG_FILENAME);
}

export function normalizeDaemonToken(raw: string): string {
  const token = trimDaemonToken(raw);
  if (token.length < 16) throw new Error("Token too short (expected >= 16 chars)");
  return token;
}

export function normalizeDaemonTokens(raw: unknown): string[] {
  if (!Array.isArray(raw)) throw new Error("Missing tokens");
  const seen = new Set<string>();
  const tokens: string[] = [];
  for (const item of raw) {
    if (typeof item !== "string") continue;
    const normalized = normalizeDaemonToken(item);
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    tokens.push(normalized);
  }
  if (tokens.length === 0) throw new Error("Missing tokens");
  return tokens;
}

export function daemonConfigPrimaryToken(config: DaemonConfig): string {
  if (config.version === 2) return trimDaemonToken(config.token);
  return trimDaemonToken(config.token);
}

export function daemonConfigTokens(config: DaemonConfig): string[] {
  if (config.version === 2) {
    const tokens = Array.from(
      new Set(
        config.tokens
          .filter((token): token is string => typeof token === "string")
          .map((token) => trimDaemonToken(token)),
      ),
    );
    const primary = trimDaemonToken(config.token);
    return tokens.includes(primary) ? tokens : [primary, ...tokens];
  }
  return [trimDaemonToken(config.token)];
}

export function normalizeDaemonPort(raw: unknown): number {
  const port = typeof raw === "number" ? raw : DAEMON_PORT_DEFAULT;
  if (!Number.isFinite(port) || port <= 0 || port >= 65535) {
    throw new Error(`Invalid port: ${String(raw)}`);
  }
  return Math.floor(port);
}

export async function readDaemonConfig({
  env,
}: {
  env: Record<string, string | undefined>;
}): Promise<DaemonConfig | null> {
  const configPath = resolveDaemonConfigPath(env);
  let text: string;
  try {
    text = await fs.readFile(configPath, "utf8");
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid daemon config JSON at ${configPath}: ${message}`);
  }
  if (!parsed || typeof parsed !== "object") {
    throw new Error(`Invalid daemon config at ${configPath}: expected object`);
  }
  const obj = parsed as Record<string, unknown>;
  const version = typeof obj.version === "number" ? obj.version : Number.NaN;
  if (version !== 1 && version !== 2) {
    throw new Error(`Invalid daemon config at ${configPath}: version`);
  }
  const port = normalizeDaemonPort(typeof obj.port === "number" ? obj.port : DAEMON_PORT_DEFAULT);
  const envRaw = obj.env && typeof obj.env === "object" ? (obj.env as Record<string, unknown>) : {};
  const envSnapshot: EnvSnapshot = {};
  for (const [k, v] of Object.entries(envRaw)) {
    if (typeof v !== "string") continue;
    const trimmed = v.trim();
    if (!trimmed) continue;
    envSnapshot[k as keyof EnvSnapshot] = trimmed;
  }
  const installedAt =
    typeof obj.installedAt === "string" ? obj.installedAt : new Date().toISOString();
  if (version === 1) {
    const tokenRaw = typeof obj.token === "string" ? obj.token : "";
    const token = normalizeDaemonToken(tokenRaw);
    return { version: 2, token, tokens: [token], port, env: envSnapshot, installedAt };
  }
  const tokens = normalizeDaemonTokens(
    Array.isArray(obj.tokens) ? obj.tokens : typeof obj.token === "string" ? [obj.token] : [],
  );
  const token =
    typeof obj.token === "string" && obj.token.trim().length > 0
      ? normalizeDaemonToken(obj.token)
      : tokens[0]!;
  return {
    version: 2,
    token: tokens.includes(token) ? token : tokens[0]!,
    tokens: tokens.includes(token) ? tokens : [token, ...tokens],
    port,
    env: envSnapshot,
    installedAt,
  };
}

export async function writeDaemonConfig({
  env,
  config,
}: {
  env: Record<string, string | undefined>;
  config: Omit<DaemonConfigV2, "version" | "installedAt"> &
    Partial<Pick<DaemonConfigV2, "installedAt">>;
}): Promise<string> {
  const configPath = resolveDaemonConfigPath(env);
  const dir = path.dirname(configPath);
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  await fs.chmod(dir, 0o700).catch(() => {
    // Best effort: Windows and some filesystems do not support POSIX modes.
  });
  const primaryToken = normalizeDaemonToken(config.token);
  const tokens = normalizeDaemonTokens(
    Array.isArray(config.tokens) ? [primaryToken, ...config.tokens] : [primaryToken],
  );
  const payload: DaemonConfigV2 = {
    version: 2,
    token: primaryToken,
    tokens,
    port: normalizeDaemonPort(config.port),
    env: config.env ?? {},
    installedAt: config.installedAt ?? new Date().toISOString(),
  };
  await fs.writeFile(configPath, `${JSON.stringify(payload, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  await fs.chmod(configPath, 0o600).catch(() => {
    // Best effort: Windows and some filesystems do not support POSIX modes.
  });
  return configPath;
}
