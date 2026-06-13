import path from "node:path";
import type { SummarizeConfig } from "../config.js";
import { resolveDaemonLogPaths } from "../daemon/launchd.js";
import { createRingFileWriter } from "./ring-file.js";

export type DaemonLogLevel = "debug" | "info" | "warn" | "error";
export type DaemonLogFormat = "json" | "pretty";

export type DaemonLoggingConfig = {
  enabled: true;
  level: DaemonLogLevel;
  format: DaemonLogFormat;
  file: string;
  maxBytes: number;
  maxFiles: number;
};

export type DaemonLogWriter = {
  debug: (payload: Record<string, unknown>) => void;
  info: (payload: Record<string, unknown>) => void;
  warn: (payload: Record<string, unknown>) => void;
  error: (payload: Record<string, unknown>) => void;
};

export type DaemonLogger = {
  enabled: boolean;
  config: DaemonLoggingConfig | null;
  logger: DaemonLogWriter | null;
  getSubLogger: (name: string, logObj?: Record<string, unknown>) => DaemonLogWriter | null;
};

const DEFAULT_LOG_LEVEL: DaemonLogLevel = "info";
const DEFAULT_LOG_FORMAT: DaemonLogFormat = "json";
const DEFAULT_LOG_MAX_MB = 10;
const DEFAULT_LOG_MAX_FILES = 3;
const ROOT_LOGGER_NAME = "summarize-daemon";

const LOG_LEVEL_MAP: Record<DaemonLogLevel, number> = {
  debug: 2,
  info: 3,
  warn: 4,
  error: 5,
};

function resolveLogFilePath(raw: string, home: string): string {
  if (raw === "~") return home;
  if (raw.startsWith("~/")) return path.resolve(path.join(home, raw.slice(2)));
  return raw;
}

function safeJsonStringify(value: unknown): string {
  const seen = new WeakSet<object>();
  return JSON.stringify(value, (_key, val) => {
    if (typeof val === "bigint") return val.toString();
    if (val instanceof Error) {
      return {
        name: val.name,
        message: val.message,
        stack: val.stack,
        cause: val.cause,
      };
    }
    if (typeof val === "object" && val !== null) {
      const obj = val as object;
      if (seen.has(obj)) return "[Circular]";
      seen.add(obj);
    }
    return val;
  });
}

function formatPrettyLine({
  timestamp,
  level,
  name,
  payload,
}: {
  timestamp: string;
  level: DaemonLogLevel;
  name: string;
  payload: Record<string, unknown>;
}): string {
  return `${timestamp} ${level.toUpperCase()} ${name} ${safeJsonStringify(payload)}`;
}

export function resolveDaemonLoggingConfig({
  env,
  config,
}: {
  env: Record<string, string | undefined>;
  config: SummarizeConfig | null;
}): DaemonLoggingConfig | null {
  const logging = config?.logging;
  if (!logging || logging.enabled !== true) return null;

  const { logDir } = resolveDaemonLogPaths(env);
  const home = env.HOME?.trim() || env.USERPROFILE?.trim() || "";
  const file =
    typeof logging.file === "string" && logging.file.trim()
      ? resolveLogFilePath(logging.file.trim(), home)
      : path.join(logDir, "daemon.jsonl");
  const maxMb =
    typeof logging.maxMb === "number" && logging.maxMb > 0 ? logging.maxMb : DEFAULT_LOG_MAX_MB;
  const maxFiles =
    typeof logging.maxFiles === "number" && logging.maxFiles > 0
      ? Math.trunc(logging.maxFiles)
      : DEFAULT_LOG_MAX_FILES;
  const level = logging.level ?? DEFAULT_LOG_LEVEL;
  const format = logging.format ?? DEFAULT_LOG_FORMAT;

  return {
    enabled: true,
    level,
    format,
    file,
    maxBytes: Math.trunc(maxMb * 1024 * 1024),
    maxFiles,
  };
}

export function createDaemonLogger({
  env,
  config,
}: {
  env: Record<string, string | undefined>;
  config: SummarizeConfig | null;
}): DaemonLogger {
  const resolved = resolveDaemonLoggingConfig({ env, config });
  if (!resolved) {
    return {
      enabled: false,
      config: null,
      logger: null,
      getSubLogger: () => null,
    };
  }

  const writer = createRingFileWriter({
    filePath: resolved.file,
    maxBytes: resolved.maxBytes,
    maxFiles: resolved.maxFiles,
  });

  const minLevel = LOG_LEVEL_MAP[resolved.level];
  const createWriter = (name: string, context: Record<string, unknown> = {}): DaemonLogWriter => {
    const write = (level: DaemonLogLevel, payload: Record<string, unknown>) => {
      if (LOG_LEVEL_MAP[level] < minLevel) return;
      const timestamp = new Date().toISOString();
      const entry = { ...payload, ...context };
      if (resolved.format === "pretty") {
        const displayName = name === ROOT_LOGGER_NAME ? name : `${ROOT_LOGGER_NAME}:${name}`;
        writer.write(formatPrettyLine({ timestamp, level, name: displayName, payload: entry }));
        return;
      }
      writer.write(
        safeJsonStringify({
          ...entry,
          _meta: {
            runtime: "node",
            runtimeVersion: process.version.replace(/^v/, ""),
            hostname: "unknown",
            name,
            ...(name === ROOT_LOGGER_NAME ? {} : { parentNames: [ROOT_LOGGER_NAME] }),
            date: timestamp,
            logLevelId: LOG_LEVEL_MAP[level],
            logLevelName: level.toUpperCase(),
          },
        }),
      );
    };
    return {
      debug: (payload) => write("debug", payload),
      info: (payload) => write("info", payload),
      warn: (payload) => write("warn", payload),
      error: (payload) => write("error", payload),
    };
  };

  const logger = createWriter(ROOT_LOGGER_NAME);
  const getSubLogger = (name: string, logObj?: Record<string, unknown>) =>
    createWriter(name, logObj);

  return {
    enabled: true,
    config: resolved,
    logger,
    getSubLogger,
  };
}
