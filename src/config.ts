import JSON5 from "json5";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { isCliThemeName, listCliThemes } from "./tty/theme.js";

export type AutoRuleKind = "text" | "website" | "youtube" | "image" | "video" | "file";
export type VideoMode = "auto" | "transcript" | "understand";
export type CliProvider = "claude" | "codex" | "gemini" | "agent";
export type CliProviderConfig = {
  binary?: string;
  extraArgs?: string[];
  model?: string;
};
export type CliAutoFallbackConfig = {
  enabled?: boolean;
  onlyWhenNoApiKeys?: boolean;
  order?: CliProvider[];
};
export type CliMagicAutoConfig = CliAutoFallbackConfig;
export type CliConfig = {
  enabled?: CliProvider[];
  claude?: CliProviderConfig;
  codex?: CliProviderConfig;
  gemini?: CliProviderConfig;
  agent?: CliProviderConfig;
  autoFallback?: CliAutoFallbackConfig;
  magicAuto?: CliAutoFallbackConfig;
  promptOverride?: string;
  allowTools?: boolean;
  cwd?: string;
  extraArgs?: string[];
};

export type OpenAiConfig = {
  /**
   * Override the OpenAI-compatible API base URL (e.g. a proxy, OpenRouter, or a local gateway).
   *
   * Prefer env `OPENAI_BASE_URL` when you need per-run overrides.
   */
  baseUrl?: string;
  useChatCompletions?: boolean;
  /**
   * USD per minute for OpenAI Whisper transcription cost estimation.
   *
   * Default: 0.006 (per OpenAI pricing as of 2025-12-24).
   */
  whisperUsdPerMinute?: number;
};

export type MediaCacheVerifyMode = "none" | "size" | "hash";
export type MediaCacheConfig = {
  enabled?: boolean;
  maxMb?: number;
  ttlDays?: number;
  path?: string;
  verify?: MediaCacheVerifyMode;
};

export type AnthropicConfig = {
  /**
   * Override the Anthropic API base URL (e.g. a proxy).
   *
   * Prefer env `ANTHROPIC_BASE_URL` when you need per-run overrides.
   */
  baseUrl?: string;
};

export type GoogleConfig = {
  /**
   * Override the Google Generative Language API base URL (e.g. a proxy).
   *
   * Prefer env `GOOGLE_BASE_URL` / `GEMINI_BASE_URL` when you need per-run overrides.
   */
  baseUrl?: string;
};

export type NvidiaConfig = {
  /**
   * Override the NVIDIA OpenAI-compatible API base URL.
   *
   * Default: https://integrate.api.nvidia.com/v1
   *
   * Prefer env `NVIDIA_BASE_URL` when you need per-run overrides.
   */
  baseUrl?: string;
};

export type ApiKeysConfig = {
  openai?: string;
  nvidia?: string;
  anthropic?: string;
  google?: string;
  xai?: string;
  openrouter?: string;
  zai?: string;
  apify?: string;
  firecrawl?: string;
  fal?: string;
};

export type EnvConfig = Record<string, string>;

export type LoggingLevel = "debug" | "info" | "warn" | "error";
export type LoggingFormat = "json" | "pretty";
export type LoggingConfig = {
  enabled?: boolean;
  level?: LoggingLevel;
  format?: LoggingFormat;
  file?: string;
  maxMb?: number;
  maxFiles?: number;
};

export type XaiConfig = {
  /**
   * Override the xAI API base URL (e.g. a proxy).
   *
   * Prefer env `XAI_BASE_URL` when you need per-run overrides.
   */
  baseUrl?: string;
};

export type ZaiConfig = {
  /**
   * Override the Z.AI API base URL (e.g. use China endpoint).
   *
   * Default: https://api.z.ai/api/paas/v4
   * China: https://api.zhipuai.cn/paas/v4
   *
   * Prefer env `Z_AI_BASE_URL` when you need per-run overrides.
   */
  baseUrl?: string;
};

export type AutoRule = {
  /**
   * Input kinds this rule applies to.
   *
   * Omit for "catch-all".
   */
  when?: AutoRuleKind[];

  /**
   * Candidate model ids (ordered).
   *
   * - Native: `openai/...`, `google/...`, `xai/...`, `anthropic/...`, `zai/...`
   * - OpenRouter (forced): `openrouter/<provider>/<model>` (e.g. `openrouter/openai/gpt-5-mini`)
   */
  candidates?: string[];

  /**
   * Token-based candidate selection (ordered).
   *
   * First matching band wins.
   */
  bands?: Array<{
    token?: { min?: number; max?: number };
    candidates: string[];
  }>;
};

export type ModelConfig =
  | {
      id: string;
    }
  | {
      mode: "auto";
      rules?: AutoRule[];
    }
  | { name: string };

export type SummarizeConfig = {
  model?: ModelConfig;
  /**
   * Output language for summaries (default: auto = match source content language).
   *
   * Examples: "en", "de", "english", "german", "pt-BR".
   */
  language?: string;
  /**
   * Summary prompt override (replaces the built-in instruction block).
   */
  prompt?: string;
  /**
   * Cache settings for extracted content, transcripts, and summaries.
   */
  cache?: {
    enabled?: boolean;
    maxMb?: number;
    ttlDays?: number;
    path?: string;
    media?: MediaCacheConfig;
  };
  /**
   * Named model presets selectable via `--model <name>`.
   *
   * Note: `auto` is reserved and cannot be defined here.
   */
  models?: Record<string, ModelConfig>;
  media?: {
    videoMode?: VideoMode;
  };
  slides?: {
    enabled?: boolean;
    ocr?: boolean;
    dir?: string;
    sceneThreshold?: number;
    max?: number;
    minDuration?: number;
  };
  output?: {
    /**
     * Output language for the summary (e.g. "auto", "en", "de", "English").
     *
     * - "auto": match the source language (default behavior when unset)
     * - otherwise: translate the output into the requested language
     */
    language?: string;
  };
  ui?: {
    /**
     * CLI theme name (e.g. "aurora", "ember", "moss", "mono").
     */
    theme?: string;
  };
  cli?: CliConfig;
  openai?: OpenAiConfig;
  nvidia?: NvidiaConfig;
  anthropic?: AnthropicConfig;
  google?: GoogleConfig;
  xai?: XaiConfig;
  zai?: ZaiConfig;
  logging?: LoggingConfig;
  /**
   * Generic environment variable defaults.
   *
   * Precedence: process env > config file env.
   */
  env?: EnvConfig;
  /**
   * Legacy API key shortcuts. Prefer `env` for new configs.
   *
   * Precedence: environment variables > config file apiKeys.
   */
  apiKeys?: ApiKeysConfig;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseOptionalBaseUrl(raw: unknown): string | undefined {
  return typeof raw === "string" && raw.trim().length > 0 ? raw.trim() : undefined;
}

function resolveLegacyApiKeysEnv(apiKeys: ApiKeysConfig | undefined): EnvConfig {
  if (!apiKeys) return {};
  const mapped: EnvConfig = {};
  if (typeof apiKeys.openai === "string") mapped.OPENAI_API_KEY = apiKeys.openai;
  if (typeof apiKeys.nvidia === "string") mapped.NVIDIA_API_KEY = apiKeys.nvidia;
  if (typeof apiKeys.anthropic === "string") mapped.ANTHROPIC_API_KEY = apiKeys.anthropic;
  if (typeof apiKeys.google === "string") mapped.GEMINI_API_KEY = apiKeys.google;
  if (typeof apiKeys.xai === "string") mapped.XAI_API_KEY = apiKeys.xai;
  if (typeof apiKeys.openrouter === "string") mapped.OPENROUTER_API_KEY = apiKeys.openrouter;
  if (typeof apiKeys.zai === "string") mapped.Z_AI_API_KEY = apiKeys.zai;
  if (typeof apiKeys.apify === "string") mapped.APIFY_API_TOKEN = apiKeys.apify;
  if (typeof apiKeys.firecrawl === "string") mapped.FIRECRAWL_API_KEY = apiKeys.firecrawl;
  if (typeof apiKeys.fal === "string") mapped.FAL_KEY = apiKeys.fal;
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

function parseProviderBaseUrlConfig(
  raw: unknown,
  path: string,
  providerName: string,
): { baseUrl: string } | undefined {
  if (typeof raw === "undefined") return undefined;
  if (!isRecord(raw)) {
    throw new Error(`Invalid config file ${path}: "${providerName}" must be an object.`);
  }
  const baseUrl = parseOptionalBaseUrl(raw.baseUrl);
  return typeof baseUrl === "string" ? { baseUrl } : undefined;
}

function parseAutoRuleKind(value: unknown): AutoRuleKind | null {
  return value === "text" ||
    value === "website" ||
    value === "youtube" ||
    value === "image" ||
    value === "video" ||
    value === "file"
    ? (value as AutoRuleKind)
    : null;
}

function parseCliProvider(value: unknown, path: string): CliProvider {
  const trimmed = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (trimmed === "claude" || trimmed === "codex" || trimmed === "gemini" || trimmed === "agent") {
    return trimmed as CliProvider;
  }
  throw new Error(`Invalid config file ${path}: unknown CLI provider "${String(value)}".`);
}

function parseStringArray(raw: unknown, path: string, label: string): string[] {
  if (!Array.isArray(raw)) {
    throw new Error(`Invalid config file ${path}: "${label}" must be an array of strings.`);
  }
  const items: string[] = [];
  for (const entry of raw) {
    if (typeof entry !== "string") {
      throw new Error(`Invalid config file ${path}: "${label}" must be an array of strings.`);
    }
    const trimmed = entry.trim();
    if (!trimmed) continue;
    items.push(trimmed);
  }
  return items;
}

function parseLoggingLevel(raw: unknown, path: string): LoggingLevel {
  if (typeof raw !== "string") {
    throw new Error(`Invalid config file ${path}: "logging.level" must be a string.`);
  }
  const trimmed = raw.trim().toLowerCase();
  if (trimmed === "debug" || trimmed === "info" || trimmed === "warn" || trimmed === "error") {
    return trimmed as LoggingLevel;
  }
  throw new Error(
    `Invalid config file ${path}: "logging.level" must be one of "debug", "info", "warn", "error".`,
  );
}

function parseLoggingFormat(raw: unknown, path: string): LoggingFormat {
  if (typeof raw !== "string") {
    throw new Error(`Invalid config file ${path}: "logging.format" must be a string.`);
  }
  const trimmed = raw.trim().toLowerCase();
  if (trimmed === "json" || trimmed === "pretty") {
    return trimmed as LoggingFormat;
  }
  throw new Error(
    `Invalid config file ${path}: "logging.format" must be one of "json" or "pretty".`,
  );
}

function parseCliProviderList(
  raw: unknown,
  path: string,
  label: string,
): CliProvider[] | undefined {
  if (!Array.isArray(raw)) {
    throw new Error(`Invalid config file ${path}: "${label}" must be an array.`);
  }
  const providers: CliProvider[] = [];
  for (const entry of raw) {
    const parsed = parseCliProvider(entry, path);
    if (!providers.includes(parsed)) providers.push(parsed);
  }
  return providers.length > 0 ? providers : undefined;
}

function parseCliProviderConfig(raw: unknown, path: string, label: string): CliProviderConfig {
  if (!isRecord(raw)) {
    throw new Error(`Invalid config file ${path}: "cli.${label}" must be an object.`);
  }
  if (typeof raw.enabled !== "undefined") {
    throw new Error(
      `Invalid config file ${path}: "cli.${label}.enabled" is not supported. Use "cli.enabled" instead.`,
    );
  }
  const binaryValue = typeof raw.binary === "string" ? raw.binary.trim() : undefined;
  const modelValue = typeof raw.model === "string" ? raw.model.trim() : undefined;
  const extraArgs =
    typeof raw.extraArgs === "undefined"
      ? undefined
      : parseStringArray(raw.extraArgs, path, `cli.${label}.extraArgs`);
  return {
    ...(binaryValue ? { binary: binaryValue } : {}),
    ...(modelValue ? { model: modelValue } : {}),
    ...(extraArgs && extraArgs.length > 0 ? { extraArgs } : {}),
  };
}

function parseCliAutoFallbackConfig(
  raw: unknown,
  path: string,
  label: string,
): CliAutoFallbackConfig {
  if (!isRecord(raw)) {
    throw new Error(`Invalid config file ${path}: "cli.${label}" must be an object.`);
  }
  const enabled =
    typeof raw.enabled === "boolean"
      ? raw.enabled
      : typeof raw.enabled === "undefined"
        ? undefined
        : (() => {
            throw new Error(
              `Invalid config file ${path}: "cli.${label}.enabled" must be a boolean.`,
            );
          })();
  const onlyWhenNoApiKeys =
    typeof raw.onlyWhenNoApiKeys === "boolean"
      ? raw.onlyWhenNoApiKeys
      : typeof raw.onlyWhenNoApiKeys === "undefined"
        ? undefined
        : (() => {
            throw new Error(
              `Invalid config file ${path}: "cli.${label}.onlyWhenNoApiKeys" must be a boolean.`,
            );
          })();
  const order =
    typeof raw.order === "undefined"
      ? undefined
      : parseCliProviderList(raw.order, path, `cli.${label}.order`);
  return {
    ...(typeof enabled === "boolean" ? { enabled } : {}),
    ...(typeof onlyWhenNoApiKeys === "boolean" ? { onlyWhenNoApiKeys } : {}),
    ...(Array.isArray(order) && order.length > 0 ? { order } : {}),
  };
}

function parseWhenKinds(raw: unknown, path: string): AutoRuleKind[] {
  if (!Array.isArray(raw)) {
    throw new Error(`Invalid config file ${path}: "model.rules[].when" must be an array of kinds.`);
  }

  if (raw.length === 0) {
    throw new Error(`Invalid config file ${path}: "model.rules[].when" must not be empty.`);
  }

  const kinds: AutoRuleKind[] = [];
  for (const entry of raw) {
    const kind = parseAutoRuleKind(entry);
    if (!kind) {
      throw new Error(`Invalid config file ${path}: unknown "when" kind "${String(entry)}".`);
    }
    if (!kinds.includes(kind)) kinds.push(kind);
  }

  return kinds;
}

function parseModelCandidates(raw: unknown, path: string): string[] {
  if (!Array.isArray(raw)) {
    throw new Error(
      `Invalid config file ${path}: "model.rules[].candidates" must be an array of strings.`,
    );
  }
  const candidates: string[] = [];
  for (const entry of raw) {
    if (typeof entry !== "string") {
      throw new Error(
        `Invalid config file ${path}: "model.rules[].candidates" must be an array of strings.`,
      );
    }
    const trimmed = entry.trim();
    if (trimmed.length === 0) continue;
    candidates.push(trimmed);
  }
  if (candidates.length === 0) {
    throw new Error(`Invalid config file ${path}: "model.rules[].candidates" must not be empty.`);
  }
  return candidates;
}

function parseTokenBand(
  raw: unknown,
  path: string,
): { token?: { min?: number; max?: number }; candidates: string[] } {
  if (!isRecord(raw)) {
    throw new Error(`Invalid config file ${path}: "model.rules[].bands[]" must be an object.`);
  }

  const candidates = parseModelCandidates(raw.candidates, path);

  const token = (() => {
    if (typeof raw.token === "undefined") return undefined;
    if (!isRecord(raw.token)) {
      throw new Error(
        `Invalid config file ${path}: "model.rules[].bands[].token" must be an object.`,
      );
    }
    const min = typeof raw.token.min === "number" ? raw.token.min : undefined;
    const max = typeof raw.token.max === "number" ? raw.token.max : undefined;

    if (typeof min === "number" && (!Number.isFinite(min) || min < 0)) {
      throw new Error(
        `Invalid config file ${path}: "model.rules[].bands[].token.min" must be >= 0.`,
      );
    }
    if (typeof max === "number" && (!Number.isFinite(max) || max < 0)) {
      throw new Error(
        `Invalid config file ${path}: "model.rules[].bands[].token.max" must be >= 0.`,
      );
    }
    if (typeof min === "number" && typeof max === "number" && min > max) {
      throw new Error(
        `Invalid config file ${path}: "model.rules[].bands[].token.min" must be <= "token.max".`,
      );
    }

    return typeof min === "number" || typeof max === "number" ? { min, max } : undefined;
  })();

  return { ...(token ? { token } : {}), candidates };
}

function assertNoComments(raw: string, path: string): void {
  let inString: '"' | "'" | null = null;
  let escaped = false;
  let line = 1;
  let col = 1;

  for (let i = 0; i < raw.length; i += 1) {
    const ch = raw[i] ?? "";
    const next = raw[i + 1] ?? "";

    if (inString) {
      if (escaped) {
        escaped = false;
        col += 1;
        continue;
      }
      if (ch === "\\") {
        escaped = true;
        col += 1;
        continue;
      }
      if (ch === inString) {
        inString = null;
      }
      if (ch === "\n") {
        line += 1;
        col = 1;
      } else {
        col += 1;
      }
      continue;
    }

    if (ch === '"' || ch === "'") {
      inString = ch as '"' | "'";
      escaped = false;
      col += 1;
      continue;
    }

    if (ch === "/" && next === "/") {
      throw new Error(
        `Invalid config file ${path}: comments are not allowed (found // at ${line}:${col}).`,
      );
    }

    if (ch === "/" && next === "*") {
      throw new Error(
        `Invalid config file ${path}: comments are not allowed (found /* at ${line}:${col}).`,
      );
    }

    if (ch === "\n") {
      line += 1;
      col = 1;
    } else {
      col += 1;
    }
  }
}

export function loadSummarizeConfig({ env }: { env: Record<string, string | undefined> }): {
  config: SummarizeConfig | null;
  path: string | null;
} {
  const home = env.HOME?.trim() || env.USERPROFILE?.trim() || null;
  if (!home) return { config: null, path: null };
  const path = join(home, ".summarize", "config.json");

  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return { config: null, path };
  }

  let parsed: unknown;
  assertNoComments(raw, path);
  try {
    parsed = JSON5.parse(raw);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid JSON in config file ${path}: ${message}`);
  }

  if (!isRecord(parsed)) {
    throw new Error(`Invalid config file ${path}: expected an object at the top level`);
  }

  const parseModelConfig = (raw: unknown, label: string): ModelConfig | undefined => {
    if (typeof raw === "undefined") return undefined;

    // Shorthand:
    // - "auto" -> { mode: "auto" }
    // - "<provider>/<model>" or "openrouter/<provider>/<model>" -> { id: "..." }
    // - "<name>" -> { name: "<name>" }
    if (typeof raw === "string") {
      const value = raw.trim();
      if (value.length === 0) {
        throw new Error(`Invalid config file ${path}: "${label}" must not be empty.`);
      }
      if (value.toLowerCase() === "auto") {
        return { mode: "auto" } satisfies ModelConfig;
      }
      if (value.includes("/")) {
        return { id: value } satisfies ModelConfig;
      }
      return { name: value } satisfies ModelConfig;
    }

    if (!isRecord(raw)) {
      throw new Error(`Invalid config file ${path}: "${label}" must be an object.`);
    }

    if (typeof raw.name === "string") {
      const name = raw.name.trim();
      if (name.length === 0) {
        throw new Error(`Invalid config file ${path}: "${label}.name" must not be empty.`);
      }
      if (name.toLowerCase() === "auto") {
        throw new Error(`Invalid config file ${path}: "${label}.name" must not be "auto".`);
      }
      return { name } satisfies ModelConfig;
    }

    if (typeof raw.id === "string") {
      const id = raw.id.trim();
      if (id.length === 0) {
        throw new Error(`Invalid config file ${path}: "${label}.id" must not be empty.`);
      }
      if (!id.includes("/")) {
        throw new Error(
          `Invalid config file ${path}: "${label}.id" must be provider-prefixed (e.g. "openai/gpt-5-mini").`,
        );
      }
      return { id } satisfies ModelConfig;
    }

    const hasRules = typeof raw.rules !== "undefined";
    if (raw.mode === "auto" || (!("mode" in raw) && hasRules)) {
      const rules = (() => {
        if (typeof raw.rules === "undefined") return undefined;
        if (!Array.isArray(raw.rules)) {
          throw new Error(`Invalid config file ${path}: "${label}.rules" must be an array.`);
        }
        const rulesParsed: AutoRule[] = [];
        for (const entry of raw.rules) {
          if (!isRecord(entry)) continue;
          const when =
            typeof entry.when === "undefined" ? undefined : parseWhenKinds(entry.when, path);

          const hasCandidates = typeof entry.candidates !== "undefined";
          const hasBands = typeof entry.bands !== "undefined";
          if (hasCandidates && hasBands) {
            throw new Error(
              `Invalid config file ${path}: "${label}.rules[]" must use either "candidates" or "bands" (not both).`,
            );
          }

          if (hasCandidates) {
            const candidates = parseModelCandidates(entry.candidates, path);
            rulesParsed.push({ ...(when ? { when } : {}), candidates });
            continue;
          }

          if (hasBands) {
            if (!Array.isArray(entry.bands) || entry.bands.length === 0) {
              throw new Error(
                `Invalid config file ${path}: "${label}.rules[].bands" must be a non-empty array.`,
              );
            }
            const bands = entry.bands.map((b) => parseTokenBand(b, path));
            rulesParsed.push({ ...(when ? { when } : {}), bands });
            continue;
          }

          throw new Error(
            `Invalid config file ${path}: "${label}.rules[]" must include "candidates" or "bands".`,
          );
        }
        return rulesParsed;
      })();
      return { mode: "auto", ...(rules ? { rules } : {}) } satisfies ModelConfig;
    }

    throw new Error(
      `Invalid config file ${path}: "${label}" must include either "id", "name", or { "mode": "auto" }.`,
    );
  };

  const model = (() => {
    return parseModelConfig(parsed.model, "model");
  })();

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

  const models = (() => {
    const root = parsed as Record<string, unknown>;
    if (typeof root.bags !== "undefined") {
      throw new Error(
        `Invalid config file ${path}: legacy key "bags" is no longer supported. Use "models" instead.`,
      );
    }
    const raw = root.models;
    if (typeof raw === "undefined") return undefined;
    if (!isRecord(raw)) {
      throw new Error(`Invalid config file ${path}: "models" must be an object.`);
    }

    const out: Record<string, ModelConfig> = {};
    const seen = new Set<string>();
    for (const [keyRaw, value] of Object.entries(raw)) {
      const key = keyRaw.trim();
      if (!key) continue;
      const keyLower = key.toLowerCase();
      if (keyLower === "auto") {
        throw new Error(`Invalid config file ${path}: model name "auto" is reserved.`);
      }
      if (seen.has(keyLower)) {
        throw new Error(`Invalid config file ${path}: duplicate model name "${key}".`);
      }
      if (/\s/.test(key)) {
        throw new Error(
          `Invalid config file ${path}: model name "${key}" must not contain spaces.`,
        );
      }
      if (key.includes("/")) {
        throw new Error(`Invalid config file ${path}: model name "${key}" must not include "/".`);
      }
      const parsedModel = parseModelConfig(value, `models.${key}`);
      if (!parsedModel) continue;
      if ("name" in parsedModel) {
        throw new Error(
          `Invalid config file ${path}: "models.${key}" must not reference another model.`,
        );
      }
      seen.add(keyLower);
      out[key] = parsedModel;
    }

    return Object.keys(out).length > 0 ? out : undefined;
  })();

  const cache = (() => {
    const value = (parsed as Record<string, unknown>).cache;
    if (typeof value === "undefined") return undefined;
    if (!isRecord(value)) {
      throw new Error(`Invalid config file ${path}: "cache" must be an object.`);
    }
    const enabled = typeof value.enabled === "boolean" ? (value.enabled as boolean) : undefined;
    const maxMbRaw = value.maxMb;
    const maxMb =
      typeof maxMbRaw === "number" && Number.isFinite(maxMbRaw) && maxMbRaw > 0
        ? maxMbRaw
        : typeof maxMbRaw === "undefined"
          ? undefined
          : (() => {
              throw new Error(`Invalid config file ${path}: "cache.maxMb" must be a number.`);
            })();
    const ttlDaysRaw = value.ttlDays;
    const ttlDays =
      typeof ttlDaysRaw === "number" && Number.isFinite(ttlDaysRaw) && ttlDaysRaw > 0
        ? ttlDaysRaw
        : typeof ttlDaysRaw === "undefined"
          ? undefined
          : (() => {
              throw new Error(`Invalid config file ${path}: "cache.ttlDays" must be a number.`);
            })();
    const pathValue =
      typeof value.path === "string" && value.path.trim().length > 0
        ? value.path.trim()
        : typeof value.path === "undefined"
          ? undefined
          : (() => {
              throw new Error(`Invalid config file ${path}: "cache.path" must be a string.`);
            })();

    const media = (() => {
      const mediaValue = (value as Record<string, unknown>).media;
      if (typeof mediaValue === "undefined") return undefined;
      if (!isRecord(mediaValue)) {
        throw new Error(`Invalid config file ${path}: "cache.media" must be an object.`);
      }
      const mediaEnabled =
        typeof mediaValue.enabled === "boolean" ? (mediaValue.enabled as boolean) : undefined;
      const mediaMaxRaw = mediaValue.maxMb;
      const mediaMaxMb =
        typeof mediaMaxRaw === "number" && Number.isFinite(mediaMaxRaw) && mediaMaxRaw > 0
          ? mediaMaxRaw
          : typeof mediaMaxRaw === "undefined"
            ? undefined
            : (() => {
                throw new Error(
                  `Invalid config file ${path}: "cache.media.maxMb" must be a number.`,
                );
              })();
      const mediaTtlRaw = mediaValue.ttlDays;
      const mediaTtlDays =
        typeof mediaTtlRaw === "number" && Number.isFinite(mediaTtlRaw) && mediaTtlRaw > 0
          ? mediaTtlRaw
          : typeof mediaTtlRaw === "undefined"
            ? undefined
            : (() => {
                throw new Error(
                  `Invalid config file ${path}: "cache.media.ttlDays" must be a number.`,
                );
              })();
      const mediaPath =
        typeof mediaValue.path === "string" && mediaValue.path.trim().length > 0
          ? mediaValue.path.trim()
          : typeof mediaValue.path === "undefined"
            ? undefined
            : (() => {
                throw new Error(
                  `Invalid config file ${path}: "cache.media.path" must be a string.`,
                );
              })();
      const verifyRaw =
        typeof mediaValue.verify === "string" ? mediaValue.verify.trim().toLowerCase() : "";
      const verify =
        verifyRaw === "none" || verifyRaw === "size" || verifyRaw === "hash"
          ? (verifyRaw as MediaCacheVerifyMode)
          : verifyRaw.length > 0
            ? (() => {
                throw new Error(
                  `Invalid config file ${path}: "cache.media.verify" must be one of "none", "size", "hash".`,
                );
              })()
            : undefined;

      return mediaEnabled || mediaMaxMb || mediaTtlDays || mediaPath || typeof verify === "string"
        ? {
            ...(typeof mediaEnabled === "boolean" ? { enabled: mediaEnabled } : {}),
            ...(typeof mediaMaxMb === "number" ? { maxMb: mediaMaxMb } : {}),
            ...(typeof mediaTtlDays === "number" ? { ttlDays: mediaTtlDays } : {}),
            ...(typeof mediaPath === "string" ? { path: mediaPath } : {}),
            ...(typeof verify === "string" ? { verify } : {}),
          }
        : undefined;
    })();

    return enabled || maxMb || ttlDays || pathValue || media
      ? {
          ...(typeof enabled === "boolean" ? { enabled } : {}),
          ...(typeof maxMb === "number" ? { maxMb } : {}),
          ...(typeof ttlDays === "number" ? { ttlDays } : {}),
          ...(typeof pathValue === "string" ? { path: pathValue } : {}),
          ...(media ? { media } : {}),
        }
      : undefined;
  })();

  const media = (() => {
    const value = parsed.media;
    if (!isRecord(value)) return undefined;
    const videoMode =
      value.videoMode === "auto" ||
      value.videoMode === "transcript" ||
      value.videoMode === "understand"
        ? (value.videoMode as VideoMode)
        : undefined;
    return videoMode ? { videoMode } : undefined;
  })();

  const slides = (() => {
    const value = (parsed as Record<string, unknown>).slides;
    if (typeof value === "undefined") return undefined;
    if (!isRecord(value)) {
      throw new Error(`Invalid config file ${path}: "slides" must be an object.`);
    }
    const enabled = typeof value.enabled === "boolean" ? value.enabled : undefined;
    const ocr = typeof value.ocr === "boolean" ? value.ocr : undefined;
    const dir =
      typeof value.dir === "string" && value.dir.trim().length > 0
        ? value.dir.trim()
        : typeof value.dir === "undefined"
          ? undefined
          : (() => {
              throw new Error(`Invalid config file ${path}: "slides.dir" must be a string.`);
            })();
    const sceneRaw = value.sceneThreshold;
    const sceneThreshold =
      typeof sceneRaw === "number" && Number.isFinite(sceneRaw) && sceneRaw >= 0.1 && sceneRaw <= 1
        ? sceneRaw
        : typeof sceneRaw === "undefined"
          ? undefined
          : (() => {
              throw new Error(
                `Invalid config file ${path}: "slides.sceneThreshold" must be a number between 0.1 and 1.0.`,
              );
            })();
    const maxRaw = value.max;
    const max =
      typeof maxRaw === "number" &&
      Number.isFinite(maxRaw) &&
      Number.isInteger(maxRaw) &&
      maxRaw > 0
        ? maxRaw
        : typeof maxRaw === "undefined"
          ? undefined
          : (() => {
              throw new Error(`Invalid config file ${path}: "slides.max" must be an integer.`);
            })();
    const minRaw = value.minDuration;
    const minDuration =
      typeof minRaw === "number" && Number.isFinite(minRaw) && minRaw >= 0
        ? minRaw
        : typeof minRaw === "undefined"
          ? undefined
          : (() => {
              throw new Error(
                `Invalid config file ${path}: "slides.minDuration" must be a number.`,
              );
            })();
    return enabled ||
      typeof ocr === "boolean" ||
      dir ||
      typeof sceneThreshold === "number" ||
      typeof max === "number" ||
      typeof minDuration === "number"
      ? {
          ...(typeof enabled === "boolean" ? { enabled } : {}),
          ...(typeof ocr === "boolean" ? { ocr } : {}),
          ...(typeof dir === "string" ? { dir } : {}),
          ...(typeof sceneThreshold === "number" ? { sceneThreshold } : {}),
          ...(typeof max === "number" ? { max } : {}),
          ...(typeof minDuration === "number" ? { minDuration } : {}),
        }
      : undefined;
  })();

  const cli = (() => {
    const value = parsed.cli;
    if (!isRecord(value)) return undefined;

    if (typeof value.disabled !== "undefined") {
      throw new Error(
        `Invalid config file ${path}: "cli.disabled" is not supported. Use "cli.enabled" instead.`,
      );
    }
    const enabled =
      typeof value.enabled !== "undefined"
        ? parseCliProviderList(value.enabled, path, "cli.enabled")
        : undefined;
    const claude = value.claude ? parseCliProviderConfig(value.claude, path, "claude") : undefined;
    const codex = value.codex ? parseCliProviderConfig(value.codex, path, "codex") : undefined;
    const gemini = value.gemini ? parseCliProviderConfig(value.gemini, path, "gemini") : undefined;
    const agent = value.agent ? parseCliProviderConfig(value.agent, path, "agent") : undefined;
    if (typeof value.autoFallback !== "undefined" && typeof value.magicAuto !== "undefined") {
      throw new Error(
        `Invalid config file ${path}: use only one of "cli.autoFallback" or legacy "cli.magicAuto".`,
      );
    }
    const autoFallback = (() => {
      if (typeof value.autoFallback !== "undefined") {
        return parseCliAutoFallbackConfig(value.autoFallback, path, "autoFallback");
      }
      if (typeof value.magicAuto !== "undefined") {
        return parseCliAutoFallbackConfig(value.magicAuto, path, "magicAuto");
      }
      return undefined;
    })();
    const promptOverride =
      typeof value.promptOverride === "string" && value.promptOverride.trim().length > 0
        ? value.promptOverride.trim()
        : undefined;
    const allowTools = typeof value.allowTools === "boolean" ? value.allowTools : undefined;
    const cwd =
      typeof value.cwd === "string" && value.cwd.trim().length > 0 ? value.cwd.trim() : undefined;
    const extraArgs =
      typeof value.extraArgs === "undefined"
        ? undefined
        : parseStringArray(value.extraArgs, path, "cli.extraArgs");

    return enabled ||
      claude ||
      codex ||
      gemini ||
      agent ||
      autoFallback ||
      promptOverride ||
      typeof allowTools === "boolean" ||
      cwd ||
      (extraArgs && extraArgs.length > 0)
      ? {
          ...(enabled ? { enabled } : {}),
          ...(claude ? { claude } : {}),
          ...(codex ? { codex } : {}),
          ...(gemini ? { gemini } : {}),
          ...(agent ? { agent } : {}),
          ...(autoFallback ? { autoFallback } : {}),
          ...(promptOverride ? { promptOverride } : {}),
          ...(typeof allowTools === "boolean" ? { allowTools } : {}),
          ...(cwd ? { cwd } : {}),
          ...(extraArgs && extraArgs.length > 0 ? { extraArgs } : {}),
        }
      : undefined;
  })();

  const output = (() => {
    const value = (parsed as Record<string, unknown>).output;
    if (typeof value === "undefined") return undefined;
    if (!isRecord(value)) {
      throw new Error(`Invalid config file ${path}: "output" must be an object.`);
    }
    const language =
      typeof value.language === "string" && value.language.trim().length > 0
        ? value.language.trim()
        : undefined;
    return typeof language === "string" ? { language } : undefined;
  })();

  const ui = (() => {
    const value = (parsed as Record<string, unknown>).ui;
    if (typeof value === "undefined") return undefined;
    if (!isRecord(value)) {
      throw new Error(`Invalid config file ${path}: "ui" must be an object.`);
    }
    const themeRaw = typeof value.theme === "string" ? value.theme.trim().toLowerCase() : "";
    if (themeRaw && !isCliThemeName(themeRaw)) {
      throw new Error(
        `Invalid config file ${path}: "ui.theme" must be one of ${listCliThemes().join(", ")}.`,
      );
    }
    const theme = themeRaw.length > 0 ? themeRaw : undefined;
    return theme ? { theme } : undefined;
  })();

  const logging = (() => {
    const value = (parsed as Record<string, unknown>).logging;
    if (typeof value === "undefined") return undefined;
    if (!isRecord(value)) {
      throw new Error(`Invalid config file ${path}: "logging" must be an object.`);
    }
    const enabled = typeof value.enabled === "boolean" ? value.enabled : undefined;
    const level =
      typeof value.level === "undefined" ? undefined : parseLoggingLevel(value.level, path);
    const format =
      typeof value.format === "undefined" ? undefined : parseLoggingFormat(value.format, path);
    const file =
      typeof value.file === "string" && value.file.trim().length > 0
        ? value.file.trim()
        : typeof value.file === "undefined"
          ? undefined
          : (() => {
              throw new Error(`Invalid config file ${path}: "logging.file" must be a string.`);
            })();
    const maxMbRaw = value.maxMb;
    const maxMb =
      typeof maxMbRaw === "number" && Number.isFinite(maxMbRaw) && maxMbRaw > 0
        ? maxMbRaw
        : typeof maxMbRaw === "undefined"
          ? undefined
          : (() => {
              throw new Error(`Invalid config file ${path}: "logging.maxMb" must be a number.`);
            })();
    const maxFilesRaw = value.maxFiles;
    const maxFiles =
      typeof maxFilesRaw === "number" && Number.isFinite(maxFilesRaw) && maxFilesRaw > 0
        ? Math.trunc(maxFilesRaw)
        : typeof maxFilesRaw === "undefined"
          ? undefined
          : (() => {
              throw new Error(`Invalid config file ${path}: "logging.maxFiles" must be a number.`);
            })();
    return enabled ||
      level ||
      format ||
      file ||
      typeof maxMb === "number" ||
      typeof maxFiles === "number"
      ? {
          ...(typeof enabled === "boolean" ? { enabled } : {}),
          ...(level ? { level } : {}),
          ...(format ? { format } : {}),
          ...(file ? { file } : {}),
          ...(typeof maxMb === "number" ? { maxMb } : {}),
          ...(typeof maxFiles === "number" ? { maxFiles } : {}),
        }
      : undefined;
  })();

  const openai = (() => {
    const value = parsed.openai;
    if (typeof value === "undefined") return undefined;
    if (!isRecord(value)) {
      throw new Error(`Invalid config file ${path}: "openai" must be an object.`);
    }
    const baseUrl = parseOptionalBaseUrl(value.baseUrl);
    const useChatCompletions =
      typeof value.useChatCompletions === "boolean" ? value.useChatCompletions : undefined;
    const whisperUsdPerMinuteRaw = (value as { whisperUsdPerMinute?: unknown }).whisperUsdPerMinute;
    const whisperUsdPerMinute =
      typeof whisperUsdPerMinuteRaw === "number" &&
      Number.isFinite(whisperUsdPerMinuteRaw) &&
      whisperUsdPerMinuteRaw > 0
        ? whisperUsdPerMinuteRaw
        : undefined;

    return typeof baseUrl === "string" ||
      typeof useChatCompletions === "boolean" ||
      typeof whisperUsdPerMinute === "number"
      ? {
          ...(typeof baseUrl === "string" ? { baseUrl } : {}),
          ...(typeof useChatCompletions === "boolean" ? { useChatCompletions } : {}),
          ...(typeof whisperUsdPerMinute === "number" ? { whisperUsdPerMinute } : {}),
        }
      : undefined;
  })();

  const nvidia = parseProviderBaseUrlConfig(
    (parsed as Record<string, unknown>).nvidia,
    path,
    "nvidia",
  );
  const anthropic = parseProviderBaseUrlConfig(parsed.anthropic, path, "anthropic");
  const google = parseProviderBaseUrlConfig(parsed.google, path, "google");
  const xai = parseProviderBaseUrlConfig(parsed.xai, path, "xai");
  const zai = parseProviderBaseUrlConfig(
    (parsed as Record<string, unknown>).zai,
    path,
    "zai",
  );

  const configEnv = (() => {
    const value = (parsed as Record<string, unknown>).env;
    if (typeof value === "undefined") return undefined;
    if (!isRecord(value)) {
      throw new Error(`Invalid config file ${path}: "env" must be an object.`);
    }
    const env: EnvConfig = {};
    for (const [rawKey, rawValue] of Object.entries(value)) {
      const key = rawKey.trim();
      if (key.length === 0) {
        throw new Error(`Invalid config file ${path}: "env" contains an empty key.`);
      }
      if (typeof rawValue !== "string") {
        throw new Error(`Invalid config file ${path}: "env.${rawKey}" must be a string.`);
      }
      env[key] = rawValue;
    }
    return Object.keys(env).length > 0 ? env : undefined;
  })();

  const apiKeys = (() => {
    const value = (parsed as Record<string, unknown>).apiKeys;
    if (typeof value === "undefined") return undefined;
    if (!isRecord(value)) {
      throw new Error(`Invalid config file ${path}: "apiKeys" must be an object.`);
    }
    const keys: Record<string, string> = {};
    const allowed = [
      "openai",
      "nvidia",
      "anthropic",
      "google",
      "xai",
      "openrouter",
      "zai",
      "apify",
      "firecrawl",
      "fal",
    ];
    for (const [key, val] of Object.entries(value)) {
      const k = key.trim().toLowerCase();
      if (!allowed.includes(k)) {
        throw new Error(`Invalid config file ${path}: unknown apiKeys provider "${key}".`);
      }
      if (typeof val !== "string" || val.trim().length === 0) {
        throw new Error(
          `Invalid config file ${path}: "apiKeys.${key}" must be a non-empty string.`,
        );
      }
      keys[k] = val.trim();
    }
    return Object.keys(keys).length > 0 ? (keys as ApiKeysConfig) : undefined;
  })();

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
