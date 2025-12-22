import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

import JSON5 from 'json5'

export type AutoRuleKind = 'text' | 'website' | 'youtube' | 'image' | 'video' | 'file'
export type VideoMode = 'auto' | 'transcript' | 'understand'

export type AutoRuleCandidate = {
  /**
   * Model id.
   *
   * - Native: `openai/...`, `google/...`, `xai/...`, `anthropic/...`
   * - OpenRouter (forced): `openrouter/<openrouter-model-id>` (e.g. `openrouter/openai/gpt-5-nano`)
   */
  model: string
  openrouterProviders?: string[]
  score?: {
    quality?: number
    speed?: number
    cost?: number
  }
}

export type AutoRule = {
  when?: { kind?: AutoRuleKind }
  candidates: AutoRuleCandidate[]
}

export type SummarizeConfig = {
  /**
   * Gateway-style model id, e.g.:
   * - google/gemini-3-flash-preview
   * - openai/gpt-5.2
   * - google/gemini-2.0-flash
   */
  model?: string
  auto?: {
    rules?: AutoRule[]
  }
  media?: {
    videoMode?: VideoMode
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function parseAutoRuleKind(value: unknown): AutoRuleKind | null {
  return value === 'text' ||
    value === 'website' ||
    value === 'youtube' ||
    value === 'image' ||
    value === 'video' ||
    value === 'file'
    ? (value as AutoRuleKind)
    : null
}

function parseWhenKinds(text: string, path: string): AutoRuleKind[] {
  const rawParts = text
    .split(/[,\s]+/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0)

  if (rawParts.length === 0) {
    throw new Error(`Invalid config file ${path}: "when" must not be empty.`)
  }

  const kinds: AutoRuleKind[] = []
  for (const part of rawParts) {
    const kind = parseAutoRuleKind(part)
    if (!kind) {
      throw new Error(`Invalid config file ${path}: unknown "when" kind "${part}".`)
    }
    if (!kinds.includes(kind)) kinds.push(kind)
  }

  return kinds
}

function assertNoComments(raw: string, path: string): void {
  let inString: '"' | "'" | null = null
  let escaped = false
  let line = 1
  let col = 1

  for (let i = 0; i < raw.length; i += 1) {
    const ch = raw[i] ?? ''
    const next = raw[i + 1] ?? ''

    if (inString) {
      if (escaped) {
        escaped = false
        col += 1
        continue
      }
      if (ch === '\\') {
        escaped = true
        col += 1
        continue
      }
      if (ch === inString) {
        inString = null
      }
      if (ch === '\n') {
        line += 1
        col = 1
      } else {
        col += 1
      }
      continue
    }

    if (ch === '"' || ch === "'") {
      inString = ch as '"' | "'"
      escaped = false
      col += 1
      continue
    }

    if (ch === '/' && next === '/') {
      throw new Error(
        `Invalid config file ${path}: comments are not allowed (found // at ${line}:${col}).`
      )
    }

    if (ch === '/' && next === '*') {
      throw new Error(
        `Invalid config file ${path}: comments are not allowed (found /* at ${line}:${col}).`
      )
    }

    if (ch === '\n') {
      line += 1
      col = 1
    } else {
      col += 1
    }
  }
}

export function loadSummarizeConfig({ env }: { env: Record<string, string | undefined> }): {
  config: SummarizeConfig | null
  path: string | null
} {
  const home = env.HOME?.trim() || homedir()
  if (!home) return { config: null, path: null }
  const path = join(home, '.summarize', 'config.json')

  let raw: string
  try {
    raw = readFileSync(path, 'utf8')
  } catch {
    return { config: null, path }
  }

  let parsed: unknown
  assertNoComments(raw, path)
  try {
    parsed = JSON5.parse(raw)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(`Invalid JSON in config file ${path}: ${message}`)
  }

  if (!isRecord(parsed)) {
    throw new Error(`Invalid config file ${path}: expected an object at the top level`)
  }

  const model = typeof parsed.model === 'string' ? parsed.model : undefined

  const auto = (() => {
    const value = parsed.auto

    if (typeof value === 'undefined') return undefined
    if (!Array.isArray(value)) {
      throw new Error(`Invalid config file ${path}: "auto" must be an array.`)
    }

    const rules: AutoRule[] = []
    for (const entry of value) {
      if (!isRecord(entry)) continue
      const candidatesRaw = entry.candidates
      if (!Array.isArray(candidatesRaw) || candidatesRaw.length === 0) continue
      const candidates: AutoRuleCandidate[] = []
      for (const c of candidatesRaw) {
        const modelId =
          typeof c === 'string'
            ? c
            : isRecord(c) && typeof c.model === 'string'
              ? c.model
              : null
        if (!modelId || modelId.trim().length === 0) continue

        const openrouterProviders =
          isRecord(c) && Array.isArray(c.openrouterProviders)
            ? c.openrouterProviders.filter((p) => typeof p === 'string' && p.trim().length > 0)
            : undefined
        const score =
          isRecord(c) && isRecord(c.score)
            ? {
                quality: typeof c.score.quality === 'number' ? c.score.quality : undefined,
                speed: typeof c.score.speed === 'number' ? c.score.speed : undefined,
                cost: typeof c.score.cost === 'number' ? c.score.cost : undefined,
              }
            : undefined

        candidates.push({
          model: modelId,
          ...(openrouterProviders ? { openrouterProviders } : {}),
          ...(score ? { score } : {}),
        })
      }
      if (candidates.length === 0) continue

      if (typeof entry.when === 'undefined') {
        rules.push({ candidates })
        continue
      }

      if (typeof entry.when !== 'string') {
        throw new Error(`Invalid config file ${path}: "auto[].when" must be a string.`)
      }

      const whenKinds = parseWhenKinds(entry.when, path)
      for (const kind of whenKinds) {
        rules.push({ when: { kind }, candidates })
      }
    }
    return rules.length > 0 ? { rules } : undefined
  })()

  const media = (() => {
    const value = parsed.media
    if (!isRecord(value)) return undefined
    const videoMode =
      value.videoMode === 'auto' || value.videoMode === 'transcript' || value.videoMode === 'understand'
        ? (value.videoMode as VideoMode)
        : undefined
    return videoMode ? { videoMode } : undefined
  })()

  return { config: { model, ...(auto ? { auto } : {}), ...(media ? { media } : {}) }, path }
}
