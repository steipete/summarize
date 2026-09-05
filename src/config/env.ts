import { LEGACY_API_KEY_ENV_MAP } from "./legacy-api-keys.js";
import type { ApiKeysConfig, EnvConfig, SummarizeConfig } from "./types.js";

function resolveLegacyApiKeysEnv(apiKeys: ApiKeysConfig | undefined): EnvConfig {
  if (!apiKeys) return {};
  const mapped: EnvConfig = {};
  for (const [key, envKey] of Object.entries(LEGACY_API_KEY_ENV_MAP) as Array<
    [keyof typeof LEGACY_API_KEY_ENV_MAP, string]
  >) {
    const value = apiKeys[key];
    if (typeof value === "string") mapped[envKey] = value;
  }
  return mapped;
}

export function resolveConfigEnv(config: SummarizeConfig | null | undefined): EnvConfig {
  if (!config) return {};
  return {
    ...resolveLegacyApiKeysEnv(config.apiKeys),
    ...(config.env ?? {}),
  };
}

export function mergeConfigEnv({
  env,
  config,
}: {
  env: Record<string, string | undefined>;
  config: SummarizeConfig | null | undefined;
}): Record<string, string | undefined> {
  const configEnv = resolveConfigEnv(config);
  if (Object.keys(configEnv).length === 0) return env;
  let changed = false;
  const merged: Record<string, string | undefined> = { ...env };
  for (const [key, value] of Object.entries(configEnv)) {
    const current = merged[key];
    if (typeof current === "string" && current.trim().length > 0) continue;
    merged[key] = value;
    changed = true;
  }
  return changed ? merged : env;
}
