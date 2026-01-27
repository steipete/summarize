import { accessSync, constants as fsConstants } from 'node:fs'
import path from 'node:path'
import type { CliProvider, SummarizeConfig } from '../config.js'
import { isCliDisabled, resolveCliBinary } from '../llm/cli.js'

type ConfigForCli = SummarizeConfig | null

function isExecutable(filePath: string): boolean {
  try {
    accessSync(filePath, fsConstants.X_OK)
    return true
  } catch {
    return false
  }
}

export function resolveExecutableInPath(
  binary: string,
  env: Record<string, string | undefined>
): string | null {
  if (!binary) return null
  if (path.isAbsolute(binary)) {
    return isExecutable(binary) ? binary : null
  }
  const pathEnv = env.PATH ?? ''
  for (const entry of pathEnv.split(path.delimiter)) {
    if (!entry) continue
    const candidate = path.join(entry, binary)
    if (isExecutable(candidate)) return candidate
  }
  return null
}

export function hasBirdCli(env: Record<string, string | undefined>): boolean {
  return resolveExecutableInPath('bird', env) !== null
}

export function hasUvxCli(env: Record<string, string | undefined>): boolean {
  if (typeof env.UVX_PATH === 'string' && env.UVX_PATH.trim().length > 0) {
    return true
  }
  return resolveExecutableInPath('uvx', env) !== null
}

export function resolveCliAvailability({
  env,
  config,
}: {
  env: Record<string, string | undefined>
  config: ConfigForCli
}): Partial<Record<CliProvider, boolean>> {
  const cliConfig = config?.cli ?? null
  const providers: CliProvider[] = ['claude', 'codex', 'gemini', 'agent']
  const availability: Partial<Record<CliProvider, boolean>> = {}
  for (const provider of providers) {
    if (isCliDisabled(provider, cliConfig)) {
      availability[provider] = false
      continue
    }
    const binary = resolveCliBinary(provider, cliConfig, env)
    availability[provider] = resolveExecutableInPath(binary, env) !== null
  }
  return availability
}

export function parseCliUserModelId(modelId: string): {
  provider: CliProvider
  model: string | null
} {
  const parts = modelId
    .trim()
    .split('/')
    .map((part) => part.trim())
  const provider = parts[1]?.toLowerCase()
  if (provider !== 'claude' && provider !== 'codex' && provider !== 'gemini' && provider !== 'agent') {
    throw new Error(`Invalid CLI model id "${modelId}". Expected cli/<provider>/<model>.`)
  }
  const model = parts.slice(2).join('/').trim()
  return { provider, model: model.length > 0 ? model : null }
}

export function parseCliProviderArg(raw: string): CliProvider {
  const normalized = raw.trim().toLowerCase()
  if (normalized === 'claude' || normalized === 'codex' || normalized === 'gemini' || normalized === 'agent') {
    return normalized as CliProvider
  }
  throw new Error(`Unsupported --cli: ${raw}`)
}

export function parseBooleanEnv(value: string | null | undefined): boolean | null {
  if (typeof value !== 'string') return null
  const normalized = value.trim().toLowerCase()
  if (normalized.length === 0) return null
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false
  return null
}
