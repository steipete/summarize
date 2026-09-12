import { parseLengthArg } from "../flags.js";
import { CLI_PROVIDERS } from "../llm/provider-registry.js";
import { isCliThemeName, listCliThemes } from "../tty/theme.js";
import { LEGACY_API_KEY_ENV_MAP } from "./legacy-api-keys.js";
import {
  isRecord,
  parseModelRequestOptions,
  parseCliProvider,
  parseLoggingFormat,
  parseLoggingLevel,
  parseOptionalBaseUrl,
  parseOptionalBoolean,
  parseOptionalNonEmptyString,
  parseOptionalNumber,
  parseStringArray,
} from "./parse-helpers.js";
import type {
  ApiKeysConfig,
  CliAutoFallbackConfig,
  CliConfig,
  CliProvider,
  CliProviderConfig,
  EmbeddedVideoMode,
  EnvConfig,
  LoggingConfig,
  MediaCacheConfig,
  MediaCacheVerifyMode,
  OpenAiConfig,
  VideoMode,
} from "./types.js";

export function parseProviderBaseUrlConfig(
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
  const isolated = parseOptionalBoolean(raw.isolated, path, `cli.${label}.isolated`);
  return {
    ...(binaryValue ? { binary: binaryValue } : {}),
    ...(modelValue ? { model: modelValue } : {}),
    ...(extraArgs && extraArgs.length > 0 ? { extraArgs } : {}),
    ...(typeof isolated === "boolean" ? { isolated } : {}),
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
  const enabled = parseOptionalBoolean(raw.enabled, path, `cli.${label}.enabled`);
  const onlyWhenNoApiKeys = parseOptionalBoolean(
    raw.onlyWhenNoApiKeys,
    path,
    `cli.${label}.onlyWhenNoApiKeys`,
  );
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

function parseMediaCacheConfig(raw: unknown, path: string): MediaCacheConfig | undefined {
  if (typeof raw === "undefined") return undefined;
  if (!isRecord(raw)) {
    throw new Error(`Invalid config file ${path}: "cache.media" must be an object.`);
  }
  const mediaEnabled = typeof raw.enabled === "boolean" ? raw.enabled : undefined;
  const mediaMaxMb = parseOptionalNumber(raw.maxMb, path, "cache.media.maxMb", {
    validate: (value) => value > 0,
  });
  const mediaTtlDays = parseOptionalNumber(raw.ttlDays, path, "cache.media.ttlDays", {
    validate: (value) => value > 0,
  });
  const mediaPath = parseOptionalNonEmptyString(raw.path, path, "cache.media.path");
  const verifyRaw = typeof raw.verify === "string" ? raw.verify.trim().toLowerCase() : "";
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

  return typeof mediaEnabled === "boolean" ||
    mediaMaxMb ||
    mediaTtlDays ||
    mediaPath ||
    typeof verify === "string"
    ? {
        ...(typeof mediaEnabled === "boolean" ? { enabled: mediaEnabled } : {}),
        ...(typeof mediaMaxMb === "number" ? { maxMb: mediaMaxMb } : {}),
        ...(typeof mediaTtlDays === "number" ? { ttlDays: mediaTtlDays } : {}),
        ...(typeof mediaPath === "string" ? { path: mediaPath } : {}),
        ...(typeof verify === "string" ? { verify } : {}),
      }
    : undefined;
}

export function parseCacheConfig(root: Record<string, unknown>, path: string) {
  const value = root.cache;
  if (typeof value === "undefined") return undefined;
  if (!isRecord(value)) {
    throw new Error(`Invalid config file ${path}: "cache" must be an object.`);
  }
  const enabled = typeof value.enabled === "boolean" ? value.enabled : undefined;
  const maxMb = parseOptionalNumber(value.maxMb, path, "cache.maxMb", {
    validate: (entry) => entry > 0,
  });
  const ttlDays = parseOptionalNumber(value.ttlDays, path, "cache.ttlDays", {
    validate: (entry) => entry > 0,
  });
  const pathValue = parseOptionalNonEmptyString(value.path, path, "cache.path");
  const media = parseMediaCacheConfig(value.media, path);

  return typeof enabled === "boolean" || maxMb || ttlDays || pathValue || media
    ? {
        ...(typeof enabled === "boolean" ? { enabled } : {}),
        ...(typeof maxMb === "number" ? { maxMb } : {}),
        ...(typeof ttlDays === "number" ? { ttlDays } : {}),
        ...(typeof pathValue === "string" ? { path: pathValue } : {}),
        ...(media ? { media } : {}),
      }
    : undefined;
}

export function parseMediaConfig(root: Record<string, unknown>) {
  const value = root.media;
  if (!isRecord(value)) return undefined;
  const videoMode =
    value.videoMode === "auto" ||
    value.videoMode === "transcript" ||
    value.videoMode === "understand"
      ? (value.videoMode as VideoMode)
      : undefined;
  const embeddedVideo =
    value.embeddedVideo === "auto" ||
    value.embeddedVideo === "off" ||
    value.embeddedVideo === "prefer" ||
    value.embeddedVideo === "both"
      ? (value.embeddedVideo as EmbeddedVideoMode)
      : undefined;
  return videoMode || embeddedVideo ? { videoMode, embeddedVideo } : undefined;
}

export function parseSlidesConfig(root: Record<string, unknown>, path: string) {
  const value = root.slides;
  if (typeof value === "undefined") return undefined;
  if (!isRecord(value)) {
    throw new Error(`Invalid config file ${path}: "slides" must be an object.`);
  }
  const enabled = typeof value.enabled === "boolean" ? value.enabled : undefined;
  const ocr = typeof value.ocr === "boolean" ? value.ocr : undefined;
  const dir = parseOptionalNonEmptyString(value.dir, path, "slides.dir");
  const sceneThreshold = parseOptionalNumber(value.sceneThreshold, path, "slides.sceneThreshold", {
    validate: (entry) => entry >= 0.1 && entry <= 1,
    expectation: "a number between 0.1 and 1.0",
  });
  const max = parseOptionalNumber(value.max, path, "slides.max", {
    validate: (entry) => Number.isInteger(entry) && entry > 0,
    expectation: "an integer",
  });
  const minDuration = parseOptionalNumber(value.minDuration, path, "slides.minDuration", {
    validate: (entry) => entry >= 0,
  });
  return typeof enabled === "boolean" ||
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
}

export function parseCliConfig(root: Record<string, unknown>, path: string): CliConfig | undefined {
  const value = root.cli;
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
  const providers: Partial<Record<CliProvider, CliProviderConfig>> = {};
  for (const provider of CLI_PROVIDERS) {
    if (value[provider]) {
      providers[provider] = parseCliProviderConfig(value[provider], path, provider);
    }
  }
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
    Object.keys(providers).length > 0 ||
    autoFallback ||
    promptOverride ||
    typeof allowTools === "boolean" ||
    cwd ||
    (extraArgs && extraArgs.length > 0)
    ? {
        ...(enabled ? { enabled } : {}),
        ...providers,
        ...(autoFallback ? { autoFallback } : {}),
        ...(promptOverride ? { promptOverride } : {}),
        ...(typeof allowTools === "boolean" ? { allowTools } : {}),
        ...(cwd ? { cwd } : {}),
        ...(extraArgs && extraArgs.length > 0 ? { extraArgs } : {}),
      }
    : undefined;
}

export function parseOutputConfig(root: Record<string, unknown>, path: string) {
  const value = root.output;
  if (typeof value === "undefined") return undefined;
  if (!isRecord(value)) {
    throw new Error(`Invalid config file ${path}: "output" must be an object.`);
  }
  const language =
    typeof value.language === "string" && value.language.trim().length > 0
      ? value.language.trim()
      : undefined;
  const length = (() => {
    if (typeof value.length === "undefined") return undefined;
    if (typeof value.length !== "string") {
      throw new Error(`Invalid config file ${path}: "output.length" must be a string.`);
    }
    const trimmed = value.length.trim();
    if (!trimmed) {
      throw new Error(`Invalid config file ${path}: "output.length" must not be empty.`);
    }
    try {
      parseLengthArg(trimmed);
    } catch (error) {
      throw new Error(
        `Invalid config file ${path}: "output.length" is invalid: ${(error as Error).message}`,
      );
    }
    return trimmed;
  })();
  return typeof language === "string" || typeof length === "string"
    ? {
        ...(typeof language === "string" ? { language } : {}),
        ...(typeof length === "string" ? { length } : {}),
      }
    : undefined;
}

export function parseUiConfig(root: Record<string, unknown>, path: string) {
  const value = root.ui;
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
}

export function parseLoggingConfig(
  root: Record<string, unknown>,
  path: string,
): LoggingConfig | undefined {
  const value = root.logging;
  if (typeof value === "undefined") return undefined;
  if (!isRecord(value)) {
    throw new Error(`Invalid config file ${path}: "logging" must be an object.`);
  }
  const enabled = typeof value.enabled === "boolean" ? value.enabled : undefined;
  const level =
    typeof value.level === "undefined" ? undefined : parseLoggingLevel(value.level, path);
  const format =
    typeof value.format === "undefined" ? undefined : parseLoggingFormat(value.format, path);
  const file = parseOptionalNonEmptyString(value.file, path, "logging.file");
  const maxMb = parseOptionalNumber(value.maxMb, path, "logging.maxMb", {
    validate: (entry) => entry > 0,
  });
  const parsedMaxFiles = parseOptionalNumber(value.maxFiles, path, "logging.maxFiles", {
    validate: (entry) => entry > 0,
  });
  const maxFiles = typeof parsedMaxFiles === "number" ? Math.trunc(parsedMaxFiles) : undefined;
  return typeof enabled === "boolean" ||
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
}

export function parseOpenAiConfig(
  root: Record<string, unknown>,
  path: string,
): OpenAiConfig | undefined {
  const value = root.openai;
  if (typeof value === "undefined") return undefined;
  if (!isRecord(value)) {
    throw new Error(`Invalid config file ${path}: "openai" must be an object.`);
  }
  const baseUrl = parseOptionalBaseUrl(value.baseUrl);
  const useChatCompletions =
    typeof value.useChatCompletions === "boolean" ? value.useChatCompletions : undefined;
  const requestOptions = parseModelRequestOptions(value, path, "openai");
  const whisperUsdPerMinuteRaw = value.whisperUsdPerMinute;
  const whisperUsdPerMinute =
    typeof whisperUsdPerMinuteRaw === "number" &&
    Number.isFinite(whisperUsdPerMinuteRaw) &&
    whisperUsdPerMinuteRaw > 0
      ? whisperUsdPerMinuteRaw
      : undefined;

  return typeof baseUrl === "string" ||
    typeof useChatCompletions === "boolean" ||
    Object.keys(requestOptions).length > 0 ||
    typeof whisperUsdPerMinute === "number"
    ? {
        ...(typeof baseUrl === "string" ? { baseUrl } : {}),
        ...(typeof useChatCompletions === "boolean" ? { useChatCompletions } : {}),
        ...requestOptions,
        ...(typeof whisperUsdPerMinute === "number" ? { whisperUsdPerMinute } : {}),
      }
    : undefined;
}

export function parseEnvConfig(root: Record<string, unknown>, path: string): EnvConfig | undefined {
  const value = root.env;
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
}

export function parseApiKeysConfig(
  root: Record<string, unknown>,
  path: string,
): ApiKeysConfig | undefined {
  const value = root.apiKeys;
  if (typeof value === "undefined") return undefined;
  if (!isRecord(value)) {
    throw new Error(`Invalid config file ${path}: "apiKeys" must be an object.`);
  }
  const keys: Record<string, string> = {};
  for (const [key, val] of Object.entries(value)) {
    const normalizedKey = key.trim().toLowerCase();
    if (!Object.hasOwn(LEGACY_API_KEY_ENV_MAP, normalizedKey)) {
      throw new Error(`Invalid config file ${path}: unknown apiKeys provider "${key}".`);
    }
    if (typeof val !== "string" || val.trim().length === 0) {
      throw new Error(`Invalid config file ${path}: "apiKeys.${key}" must be a non-empty string.`);
    }
    keys[normalizedKey] = val.trim();
  }
  return Object.keys(keys).length > 0 ? (keys as ApiKeysConfig) : undefined;
}
