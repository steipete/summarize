import type { ApiKeysConfig, EnvConfig, SummarizeConfig } from "./types.js";

const LEGACY_API_KEY_ENV_MAP = {
  openai: "OPENAI_API_KEY",
  nvidia: "NVIDIA_API_KEY",
  anthropic: "ANTHROPIC_API_KEY",
  google: "GEMINI_API_KEY",
  xai: "XAI_API_KEY",
  openrouter: "OPENROUTER_API_KEY",
  zai: "Z_AI_API_KEY",
  apify: "APIFY_API_TOKEN",
  firecrawl: "FIRECRAWL_API_KEY",
  fal: "FAL_KEY",
  groq: "GROQ_API_KEY",
  assemblyai: "ASSEMBLYAI_API_KEY",
} as const satisfies Record<keyof ApiKeysConfig, string>;

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
