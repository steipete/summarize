import {
  parseOpenAiReasoningEffort,
  parseOpenAiTextVerbosity,
  type ModelRequestOptions,
} from "../llm/model-options.js";
import { parseCliProviderName } from "../llm/provider-registry.js";
import type { CliProvider, LoggingFormat, LoggingLevel } from "./types.js";

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseModelRequestOptions(
  raw: Record<string, unknown>,
  path: string,
  label: string,
): ModelRequestOptions {
  const serviceTier =
    typeof raw.serviceTier === "string" && raw.serviceTier.trim().length > 0
      ? raw.serviceTier.trim()
      : undefined;
  const reasoningRaw =
    typeof raw.reasoningEffort === "string"
      ? raw.reasoningEffort
      : typeof raw.thinking === "string"
        ? raw.thinking
        : undefined;
  if (
    typeof raw.reasoningEffort !== "undefined" &&
    typeof raw.thinking !== "undefined" &&
    String(raw.reasoningEffort).trim().toLowerCase() !== String(raw.thinking).trim().toLowerCase()
  ) {
    throw new Error(
      `Invalid config file ${path}: "${label}.reasoningEffort" and "${label}.thinking" must not conflict.`,
    );
  }
  const reasoningEffort =
    typeof reasoningRaw === "string"
      ? parseOpenAiReasoningEffort(reasoningRaw, `${label}.reasoningEffort`)
      : undefined;
  const textVerbosity =
    typeof raw.textVerbosity === "string"
      ? parseOpenAiTextVerbosity(raw.textVerbosity, `${label}.textVerbosity`)
      : undefined;
  return {
    ...(serviceTier ? { serviceTier } : {}),
    ...(reasoningEffort ? { reasoningEffort } : {}),
    ...(textVerbosity ? { textVerbosity } : {}),
  };
}

export function parseOptionalBaseUrl(raw: unknown): string | undefined {
  return typeof raw === "string" && raw.trim().length > 0 ? raw.trim() : undefined;
}

export function parseOptionalBoolean(
  raw: unknown,
  path: string,
  label: string,
): boolean | undefined {
  if (typeof raw === "undefined") return undefined;
  if (typeof raw === "boolean") return raw;
  throw new Error(`Invalid config file ${path}: "${label}" must be a boolean.`);
}

export function parseOptionalNonEmptyString(
  raw: unknown,
  path: string,
  label: string,
): string | undefined {
  if (typeof raw === "undefined") return undefined;
  if (typeof raw === "string" && raw.trim().length > 0) return raw.trim();
  throw new Error(`Invalid config file ${path}: "${label}" must be a string.`);
}

export function parseOptionalNumber(
  raw: unknown,
  path: string,
  label: string,
  options: {
    validate?: (value: number) => boolean;
    expectation?: string;
  } = {},
): number | undefined {
  if (typeof raw === "undefined") return undefined;
  if (typeof raw === "number" && Number.isFinite(raw) && (options.validate?.(raw) ?? true)) {
    return raw;
  }
  throw new Error(
    `Invalid config file ${path}: "${label}" must be ${options.expectation ?? "a number"}.`,
  );
}

export function parseCliProvider(value: unknown, path: string): CliProvider {
  const provider = typeof value === "string" ? parseCliProviderName(value) : null;
  if (provider) return provider;
  throw new Error(`Invalid config file ${path}: unknown CLI provider "${String(value)}".`);
}

export function parseStringArray(raw: unknown, path: string, label: string): string[] {
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

export function parseLoggingLevel(raw: unknown, path: string): LoggingLevel {
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

export function parseLoggingFormat(raw: unknown, path: string): LoggingFormat {
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
