import { parseLengthArg } from "../flags.js";
import { parseOpenAiReasoningEffort, parseOpenAiTextVerbosity } from "../llm/model-options.js";
import { isCliThemeName, listCliThemes } from "../tty/theme.js";
import {
  isRecord,
  parseCliProvider,
  parseLoggingFormat,
  parseLoggingLevel,
  parseOptionalBaseUrl,
  parseStringArray,
} from "./parse-helpers.js";
import type {
  ApiKeysConfig,
  CliAutoFallbackConfig,
  CliConfig,
  CliProvider,
  CliProviderConfig,
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

function parseMediaCacheConfig(raw: unknown, path: string): MediaCacheConfig | undefined {
  if (typeof raw === "undefined") return undefined;
  if (!isRecord(raw)) {
    throw new Error(`Invalid config file ${path}: "cache.media" must be an object.`);
  }
  const mediaEnabled = typeof raw.enabled === "boolean" ? raw.enabled : undefined;
  const mediaMaxRaw = raw.maxMb;
  const mediaMaxMb =
    typeof mediaMaxRaw === "number" && Number.isFinite(mediaMaxRaw) && mediaMaxRaw > 0
      ? mediaMaxRaw
      : typeof mediaMaxRaw === "undefined"
        ? undefined
        : (() => {
            throw new Error(`Invalid config file ${path}: "cache.media.maxMb" must be a number.`);
          })();
  const mediaTtlRaw = raw.ttlDays;
  const mediaTtlDays =
    typeof mediaTtlRaw === "number" && Number.isFinite(mediaTtlRaw) && mediaTtlRaw > 0
      ? mediaTtlRaw
      : typeof mediaTtlRaw === "undefined"
        ? undefined
        : (() => {
            throw new Error(`Invalid config file ${path}: "cache.media.ttlDays" must be a number.`);
          })();
  const mediaPath =
    typeof raw.path === "string" && raw.path.trim().length > 0
      ? raw.path.trim()
      : typeof raw.path === "undefined"
        ? undefined
        : (() => {
            throw new Error(`Invalid config file ${path}: "cache.media.path" must be a string.`);
          })();
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

  return mediaEnabled || mediaMaxMb || mediaTtlDays || mediaPath || typeof verify === "string"
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
  const media = parseMediaCacheConfig(value.media, path);

  return enabled || maxMb || ttlDays || pathValue || media
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
  return videoMode ? { videoMode } : undefined;
}

export function parseSlidesConfig(root: Record<string, unknown>, path: string) {
  const value = root.slides;
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
    typeof maxRaw === "number" && Number.isFinite(maxRaw) && Number.isInteger(maxRaw) && maxRaw > 0
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
            throw new Error(`Invalid config file ${path}: "slides.minDuration" must be a number.`);
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
  const claude = value.claude ? parseCliProviderConfig(value.claude, path, "claude") : undefined;
  const codex = value.codex ? parseCliProviderConfig(value.codex, path, "codex") : undefined;
  const gemini = value.gemini ? parseCliProviderConfig(value.gemini, path, "gemini") : undefined;
  const agent = value.agent ? parseCliProviderConfig(value.agent, path, "agent") : undefined;
  const openclaw = value.openclaw
    ? parseCliProviderConfig(value.openclaw, path, "openclaw")
    : undefined;
  const opencode = value.opencode
    ? parseCliProviderConfig(value.opencode, path, "opencode")
    : undefined;
  const copilot = value.copilot
    ? parseCliProviderConfig(value.copilot, path, "copilot")
    : undefined;
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
    openclaw ||
    opencode ||
    copilot ||
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
        ...(openclaw ? { openclaw } : {}),
        ...(opencode ? { opencode } : {}),
        ...(copilot ? { copilot } : {}),
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
  const serviceTier =
    typeof value.serviceTier === "string" && value.serviceTier.trim().length > 0
      ? value.serviceTier.trim()
      : undefined;
  const reasoningRaw =
    typeof value.reasoningEffort === "string"
      ? value.reasoningEffort
      : typeof value.thinking === "string"
        ? value.thinking
        : undefined;
  if (
    typeof value.reasoningEffort !== "undefined" &&
    typeof value.thinking !== "undefined" &&
    String(value.reasoningEffort).trim().toLowerCase() !==
      String(value.thinking).trim().toLowerCase()
  ) {
    throw new Error(
      `Invalid config file ${path}: "openai.reasoningEffort" and "openai.thinking" must not conflict.`,
    );
  }
  const reasoningEffort =
    typeof reasoningRaw === "string"
      ? parseOpenAiReasoningEffort(reasoningRaw, "openai.reasoningEffort")
      : undefined;
  const textVerbosity =
    typeof value.textVerbosity === "string"
      ? parseOpenAiTextVerbosity(value.textVerbosity, "openai.textVerbosity")
      : undefined;
  const whisperUsdPerMinuteRaw = value.whisperUsdPerMinute;
  const whisperUsdPerMinute =
    typeof whisperUsdPerMinuteRaw === "number" &&
    Number.isFinite(whisperUsdPerMinuteRaw) &&
    whisperUsdPerMinuteRaw > 0
      ? whisperUsdPerMinuteRaw
      : undefined;

  return typeof baseUrl === "string" ||
    typeof useChatCompletions === "boolean" ||
    typeof serviceTier === "string" ||
    typeof reasoningEffort === "string" ||
    typeof textVerbosity === "string" ||
    typeof whisperUsdPerMinute === "number"
    ? {
        ...(typeof baseUrl === "string" ? { baseUrl } : {}),
        ...(typeof useChatCompletions === "boolean" ? { useChatCompletions } : {}),
        ...(typeof serviceTier === "string" ? { serviceTier } : {}),
        ...(typeof reasoningEffort === "string" ? { reasoningEffort } : {}),
        ...(typeof textVerbosity === "string" ? { textVerbosity } : {}),
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
    "groq",
    "assemblyai",
  ];
  for (const [key, val] of Object.entries(value)) {
    const normalizedKey = key.trim().toLowerCase();
    if (!allowed.includes(normalizedKey)) {
      throw new Error(`Invalid config file ${path}: unknown apiKeys provider "${key}".`);
    }
    if (typeof val !== "string" || val.trim().length === 0) {
      throw new Error(`Invalid config file ${path}: "apiKeys.${key}" must be a non-empty string.`);
    }
    keys[normalizedKey] = val.trim();
  }
  return Object.keys(keys).length > 0 ? (keys as ApiKeysConfig) : undefined;
}
