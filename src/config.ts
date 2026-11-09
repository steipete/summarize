import { parseModelConfig, parseModelsConfig } from "./config/model.js";
import { readParsedConfigFile, resolveSummarizeConfigPath } from "./config/read.js";
import {
  parseApiKeysConfig,
  parseCacheConfig,
  parseCliConfig,
  parseEnvConfig,
  parseLoggingConfig,
  parseMediaConfig,
  parseOpenAiConfig,
  parseOutputConfig,
  parseProviderBaseUrlConfig,
  parseSlidesConfig,
  parseUiConfig,
} from "./config/sections.js";
import { parseSpeakersConfig } from "./config/speakers.js";
import type { SummarizeConfig } from "./config/types.js";
import { CliError } from "./locale.js";

export type {
  AnthropicConfig,
  ApiKeysConfig,
  AutoRule,
  AutoRuleKind,
  CliAutoFallbackConfig,
  CliConfig,
  CliMagicAutoConfig,
  CliProvider,
  CliProviderConfig,
  EnvConfig,
  GoogleConfig,
  LoggingConfig,
  LoggingFormat,
  LoggingLevel,
  MediaCacheConfig,
  MediaCacheVerifyMode,
  ModelConfig,
  NvidiaConfig,
  OllamaConfig,
  OpenAiConfig,
  SpeakerAnchorConfig,
  SpeakerProfileConfig,
  SpeakerSourceConfig,
  SpeakersConfig,
  SummarizeConfig,
  VideoMode,
  XaiConfig,
  ZaiConfig,
} from "./config/types.js";

export { mergeConfigEnv, resolveConfigEnv } from "./config/env.js";

export function loadSummarizeConfig({ env }: { env: Record<string, string | undefined> }): {
  config: SummarizeConfig | null;
  path: string | null;
} {
  const path = resolveSummarizeConfigPath(env);
  if (!path) return { config: null, path: null };
  const parsed = readParsedConfigFile(path);
  if (!parsed) return { config: null, path };

  const model = parseModelConfig(parsed.model, path, "model");

  const language = (() => {
    const value = parsed.language;
    if (typeof value === "undefined") return undefined;
    if (typeof value !== "string") {
      throw new CliError("error.configField", { path, field: "language", constraint: "string" });
    }
    const trimmed = value.trim();
    if (!trimmed) {
      throw new CliError("error.configField", { path, field: "language", constraint: "empty" });
    }
    return trimmed;
  })();

  const prompt = (() => {
    const value = (parsed as Record<string, unknown>).prompt;
    if (typeof value === "undefined") return undefined;
    if (typeof value !== "string") {
      throw new CliError("error.configField", { path, field: "prompt", constraint: "string" });
    }
    const trimmed = value.trim();
    if (!trimmed) {
      throw new CliError("error.configField", { path, field: "prompt", constraint: "empty" });
    }
    return trimmed;
  })();

  const models = parseModelsConfig(parsed, path);
  const cache = parseCacheConfig(parsed, path);
  const media = parseMediaConfig(parsed);
  const slides = parseSlidesConfig(parsed, path);
  const speakers = parseSpeakersConfig(parsed, path);
  const cli = parseCliConfig(parsed, path);
  const output = parseOutputConfig(parsed, path);
  const ui = parseUiConfig(parsed, path);
  const logging = parseLoggingConfig(parsed, path);
  const openai = parseOpenAiConfig(parsed, path);

  const providerConfigs: Partial<SummarizeConfig> = {};
  for (const provider of [
    "nvidia",
    "minimax",
    "anthropic",
    "google",
    "xai",
    "zai",
    "ollama",
  ] as const) {
    const providerConfig = parseProviderBaseUrlConfig(parsed[provider], path, provider);
    if (providerConfig) providerConfigs[provider] = providerConfig;
  }

  const configEnv = parseEnvConfig(parsed, path);
  const apiKeys = parseApiKeysConfig(parsed, path);

  return {
    config: {
      ...(model ? { model } : {}),
      ...(language ? { language } : {}),
      ...(prompt ? { prompt } : {}),
      ...(cache ? { cache } : {}),
      ...(models ? { models } : {}),
      ...(media ? { media } : {}),
      ...(slides ? { slides } : {}),
      ...(speakers ? { speakers } : {}),
      ...(output ? { output } : {}),
      ...(ui ? { ui } : {}),
      ...(cli ? { cli } : {}),
      ...(openai ? { openai } : {}),
      ...providerConfigs,
      ...(logging ? { logging } : {}),
      ...(configEnv ? { env: configEnv } : {}),
      ...(apiKeys ? { apiKeys } : {}),
    },
    path,
  };
}
