import type { SummarizeConfig } from "./config/types.js";
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
  OpenAiConfig,
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
      throw new Error(`Invalid config file ${path}: "language" must be a string.`);
    }
    const trimmed = value.trim();
    if (!trimmed) {
      throw new Error(`Invalid config file ${path}: "language" must not be empty.`);
    }
    return trimmed;
  })();

  const prompt = (() => {
    const value = (parsed as Record<string, unknown>).prompt;
    if (typeof value === "undefined") return undefined;
    if (typeof value !== "string") {
      throw new Error(`Invalid config file ${path}: "prompt" must be a string.`);
    }
    const trimmed = value.trim();
    if (!trimmed) {
      throw new Error(`Invalid config file ${path}: "prompt" must not be empty.`);
    }
    return trimmed;
  })();

  const models = parseModelsConfig(parsed, path);
  const cache = parseCacheConfig(parsed, path);
  const media = parseMediaConfig(parsed);
  const slides = parseSlidesConfig(parsed, path);
  const cli = parseCliConfig(parsed, path);
  const output = parseOutputConfig(parsed, path);
  const ui = parseUiConfig(parsed, path);
  const logging = parseLoggingConfig(parsed, path);
  const openai = parseOpenAiConfig(parsed, path);

  const nvidia = parseProviderBaseUrlConfig(
    (parsed as Record<string, unknown>).nvidia,
    path,
    "nvidia",
  );
  const anthropic = parseProviderBaseUrlConfig(parsed.anthropic, path, "anthropic");
  const google = parseProviderBaseUrlConfig(parsed.google, path, "google");
  const xai = parseProviderBaseUrlConfig(parsed.xai, path, "xai");
  const zai = parseProviderBaseUrlConfig((parsed as Record<string, unknown>).zai, path, "zai");

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
      ...(output ? { output } : {}),
      ...(ui ? { ui } : {}),
      ...(cli ? { cli } : {}),
      ...(openai ? { openai } : {}),
      ...(nvidia ? { nvidia } : {}),
      ...(anthropic ? { anthropic } : {}),
      ...(google ? { google } : {}),
      ...(xai ? { xai } : {}),
      ...(zai ? { zai } : {}),
      ...(logging ? { logging } : {}),
      ...(configEnv ? { env: configEnv } : {}),
      ...(apiKeys ? { apiKeys } : {}),
    },
    path,
  };
}
