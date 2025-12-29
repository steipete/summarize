import path from 'node:path'

import { Logger } from 'tslog'

import type { SummarizeConfig } from '../config.js'
import { resolveDaemonLogPaths } from '../daemon/launchd.js'

import { createRingFileWriter } from './ring-file.js'

export type DaemonLogLevel = 'debug' | 'info' | 'warn' | 'error'
export type DaemonLogFormat = 'json' | 'pretty'

export type DaemonLoggingConfig = {
  enabled: true
  level: DaemonLogLevel
  format: DaemonLogFormat
  file: string
  maxBytes: number
  maxFiles: number
}

export type DaemonLogger = {
  enabled: boolean
  config: DaemonLoggingConfig | null
  logger: Logger<Record<string, unknown>> | null
  getSubLogger: (
    name: string,
    logObj?: Record<string, unknown>
  ) => Logger<Record<string, unknown>> | null
}

const DEFAULT_LOG_LEVEL: DaemonLogLevel = 'info'
const DEFAULT_LOG_FORMAT: DaemonLogFormat = 'json'
const DEFAULT_LOG_MAX_MB = 10
const DEFAULT_LOG_MAX_FILES = 3

const LOG_LEVEL_MAP: Record<DaemonLogLevel, number> = {
  debug: 2,
  info: 3,
  warn: 4,
  error: 5,
}

function safeJsonStringify(value: unknown): string {
  const seen = new WeakSet<object>()
  return JSON.stringify(value, (_key, val) => {
    if (typeof val === 'bigint') return val.toString()
    if (val instanceof Error) {
      return {
        name: val.name,
        message: val.message,
        stack: val.stack,
        cause: val.cause,
      }
    }
    if (typeof val === 'object' && val !== null) {
      const obj = val as object
      if (seen.has(obj)) return '[Circular]'
      seen.add(obj)
    }
    return val
  })
}

function formatPrettyLine({
  metaMarkup,
  args,
  errors,
}: {
  metaMarkup: string
  args: unknown[]
  errors: string[]
}): string {
  const parts: string[] = []
  const meta = metaMarkup.trim()
  if (meta) parts.push(meta)
  if (args.length > 0) {
    parts.push(
      args.map((arg) => (typeof arg === 'string' ? arg : safeJsonStringify(arg))).join(' ')
    )
  }
  const base = parts.join(' ')
  if (errors.length === 0) return base
  const errorBlock = errors.join('\n')
  return base ? `${base}\n${errorBlock}` : errorBlock
}

export function resolveDaemonLoggingConfig({
  env,
  config,
}: {
  env: Record<string, string | undefined>
  config: SummarizeConfig | null
}): DaemonLoggingConfig | null {
  const logging = config?.logging
  if (!logging || logging.enabled !== true) return null

  const { logDir } = resolveDaemonLogPaths(env)
  const file =
    typeof logging.file === 'string' && logging.file.trim()
      ? logging.file.trim()
      : path.join(logDir, 'daemon.jsonl')
  const maxMb =
    typeof logging.maxMb === 'number' && logging.maxMb > 0 ? logging.maxMb : DEFAULT_LOG_MAX_MB
  const maxFiles =
    typeof logging.maxFiles === 'number' && logging.maxFiles > 0
      ? Math.trunc(logging.maxFiles)
      : DEFAULT_LOG_MAX_FILES
  const level = logging.level ?? DEFAULT_LOG_LEVEL
  const format = logging.format ?? DEFAULT_LOG_FORMAT

  return {
    enabled: true,
    level,
    format,
    file,
    maxBytes: Math.trunc(maxMb * 1024 * 1024),
    maxFiles,
  }
}

export function createDaemonLogger({
  env,
  config,
}: {
  env: Record<string, string | undefined>
  config: SummarizeConfig | null
}): DaemonLogger {
  const resolved = resolveDaemonLoggingConfig({ env, config })
  if (!resolved) {
    return {
      enabled: false,
      config: null,
      logger: null,
      getSubLogger: () => null,
    }
  }

  const writer = createRingFileWriter({
    filePath: resolved.file,
    maxBytes: resolved.maxBytes,
    maxFiles: resolved.maxFiles,
  })

  const minLevel = LOG_LEVEL_MAP[resolved.level]
  const baseSettings = {
    name: 'summarize-daemon',
    minLevel,
    hideLogPositionForProduction: true,
    metaProperty: '_meta',
  }

  const logger =
    resolved.format === 'pretty'
      ? new Logger<Record<string, unknown>>({
          ...baseSettings,
          type: 'pretty',
          overwrite: {
            transportFormatted: (metaMarkup, args, errors) => {
              const line = formatPrettyLine({ metaMarkup, args, errors })
              writer.write(line)
            },
          },
        })
      : new Logger<Record<string, unknown>>({
          ...baseSettings,
          type: 'json',
          overwrite: {
            transportJSON: (json) => {
              writer.write(safeJsonStringify(json))
            },
          },
        })

  const getSubLogger = (name: string, logObj?: Record<string, unknown>) =>
    logger.getSubLogger({ name }, logObj)

  return {
    enabled: true,
    config: resolved,
    logger,
    getSubLogger,
  }
}
