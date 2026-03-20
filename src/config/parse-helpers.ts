import type { CliProvider, LoggingFormat, LoggingLevel } from "./types.js";

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseOptionalBaseUrl(raw: unknown): string | undefined {
  return typeof raw === "string" && raw.trim().length > 0 ? raw.trim() : undefined;
}

export function parseCliProvider(value: unknown, path: string): CliProvider {
  const trimmed = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (
    trimmed === "claude" ||
    trimmed === "codex" ||
    trimmed === "gemini" ||
    trimmed === "agent" ||
    trimmed === "openclaw" ||
    trimmed === "opencode"
  ) {
    return trimmed as CliProvider;
  }
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
