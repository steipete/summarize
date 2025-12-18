import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export type SummarizeConfig = {
  /**
   * Gateway-style model id, e.g.:
   * - xai/grok-4-fast-non-reasoning
   * - openai/gpt-5.2
   * - google/gemini-2.0-flash
   */
  model?: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function resolveDefaultConfigPath(env: Record<string, string | undefined>): string | null {
  const xdg = env.XDG_CONFIG_HOME?.trim()
  if (xdg) {
    return join(xdg, 'summarize', 'config.json')
  }

  const home = env.HOME?.trim() || homedir()
  if (!home) return null
  return join(home, '.config', 'summarize', 'config.json')
}

export function loadSummarizeConfig({
  env,
  configPathArg,
}: {
  env: Record<string, string | undefined>
  configPathArg: string | null
}): { config: SummarizeConfig | null; path: string | null } {
  const fromEnv = env.SUMMARIZE_CONFIG?.trim() || null
  const path = configPathArg?.trim() || fromEnv || resolveDefaultConfigPath(env)
  if (!path) return { config: null, path: null }

  let raw: string
  try {
    raw = readFileSync(path, 'utf8')
  } catch {
    return { config: null, path }
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(`Invalid JSON in config file ${path}: ${message}`)
  }

  if (!isRecord(parsed)) {
    throw new Error(`Invalid config file ${path}: expected an object at the top level`)
  }

  const model = typeof parsed.model === 'string' ? parsed.model : undefined
  return { config: { model }, path }
}
