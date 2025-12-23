import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

import JSON5 from 'json5'

import type { LlmApiKeys } from './llm/generate-text.js'
import { generateTextWithModelId } from './llm/generate-text.js'

type GenerateFreeOptions = {
  runs: number
  smart: number
  maxCandidates: number
  concurrency: number
  timeoutMs: number
}

function supportsColor(
  stream: NodeJS.WritableStream,
  env: Record<string, string | undefined>
): boolean {
  if (env.NO_COLOR) return false
  if (env.FORCE_COLOR && env.FORCE_COLOR !== '0') return true
  if (!Boolean((stream as unknown as { isTTY?: boolean }).isTTY)) return false
  const term = env.TERM?.toLowerCase()
  if (!term || term === 'dumb') return false
  return true
}

function ansi(code: string, input: string, enabled: boolean): string {
  if (!enabled) return input
  return `\u001b[${code}m${input}\u001b[0m`
}

function formatMs(ms: number): string {
  if (!Number.isFinite(ms)) return `${ms}`
  if (ms < 1000) return `${Math.round(ms)}ms`
  return `${Math.round(ms / 100) / 10}s`
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

function resolveConfigPath(env: Record<string, string | undefined>): string {
  const home = env.HOME?.trim() || homedir()
  if (!home) throw new Error('Missing HOME')
  return join(home, '.summarize', 'config.json')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

type OpenRouterModelEntry = {
  id: string
  contextLength: number | null
  maxCompletionTokens: number | null
  supportedParametersCount: number
}

async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const limit = Math.max(1, Math.floor(concurrency))
  const results: R[] = new Array(items.length)
  let nextIndex = 0

  const worker = async () => {
    while (true) {
      const current = nextIndex
      nextIndex += 1
      if (current >= items.length) return
      results[current] = await fn(items[current] as T, current)
    }
  }

  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()))
  return results
}

export async function generateFree({
  env,
  fetchImpl,
  stdout,
  stderr,
  verbose = false,
  options = {},
}: {
  env: Record<string, string | undefined>
  fetchImpl: typeof fetch
  stdout: NodeJS.WritableStream
  stderr: NodeJS.WritableStream
  verbose?: boolean
  options?: Partial<GenerateFreeOptions>
}): Promise<void> {
  const color = supportsColor(stderr, env)
  const okLabel = (text: string) => ansi('1;32', text, color)
  const dim = (text: string) => ansi('2', text, color)
  const heading = (text: string) => ansi('1;36', text, color)

  const openrouterKey =
    typeof env.OPENROUTER_API_KEY === 'string' && env.OPENROUTER_API_KEY.trim().length > 0
      ? env.OPENROUTER_API_KEY.trim()
      : null
  if (!openrouterKey) {
    throw new Error('Missing OPENROUTER_API_KEY (required for refresh-free)')
  }

  const resolved: GenerateFreeOptions = {
    runs: 3,
    smart: 3,
    maxCandidates: 8,
    concurrency: 4,
    timeoutMs: 10_000,
    ...options,
  }
  const RUNS = Math.max(1, Math.floor(resolved.runs))
  const SMART = Math.max(0, Math.floor(resolved.smart))
  const MAX_CANDIDATES = Math.max(1, Math.floor(resolved.maxCandidates))
  const CONCURRENCY = Math.max(1, Math.floor(resolved.concurrency))
  const TIMEOUT_MS = Math.max(1, Math.floor(resolved.timeoutMs))
  const TARGET_WORKING = Math.max(MAX_CANDIDATES, MAX_CANDIDATES * 3)

  stderr.write(`${heading('OpenRouter')}: fetching models…\n`)
  const response = await fetchImpl('https://openrouter.ai/api/v1/models', {
    headers: { Accept: 'application/json' },
  })
  if (!response.ok) {
    throw new Error(`OpenRouter /models failed: HTTP ${response.status}`)
  }
  const payload = (await response.json()) as { data?: unknown }
  const entries = (Array.isArray(payload.data) ? payload.data : []) as unknown[]

  const catalogModels: OpenRouterModelEntry[] = entries
    .map((entry) => {
      if (!entry || typeof entry !== 'object') return null
      const obj = entry as Record<string, unknown>
      const id = typeof obj.id === 'string' ? obj.id.trim() : ''
      if (!id) return null

      const contextLength =
        typeof obj.context_length === 'number' && Number.isFinite(obj.context_length)
          ? obj.context_length
          : null

      const topProvider =
        obj.top_provider && typeof obj.top_provider === 'object'
          ? (obj.top_provider as Record<string, unknown>)
          : null
      const maxCompletionTokens =
        typeof topProvider?.max_completion_tokens === 'number' &&
        Number.isFinite(topProvider.max_completion_tokens)
          ? (topProvider.max_completion_tokens as number)
          : null

      const supportedParametersCount = (() => {
        const sp = obj.supported_parameters
        if (!Array.isArray(sp)) return 0
        return sp.filter((v) => typeof v === 'string' && v.trim().length > 0).length
      })()

      return {
        id,
        contextLength,
        maxCompletionTokens,
        supportedParametersCount,
      } satisfies OpenRouterModelEntry
    })
    .filter((v): v is OpenRouterModelEntry => Boolean(v))

  const freeModels = catalogModels.filter((m) => m.id.endsWith(':free'))
  if (freeModels.length === 0) {
    throw new Error('OpenRouter /models returned no :free models')
  }

  const smartSorted = freeModels
    .slice()
    .sort((a, b) => {
      const aContext = a.contextLength ?? -1
      const bContext = b.contextLength ?? -1
      if (aContext !== bContext) return bContext - aContext
      const aOut = a.maxCompletionTokens ?? -1
      const bOut = b.maxCompletionTokens ?? -1
      if (aOut !== bOut) return bOut - aOut
      if (a.supportedParametersCount !== b.supportedParametersCount) {
        return b.supportedParametersCount - a.supportedParametersCount
      }
      return a.id.localeCompare(b.id)
    })

  const freeIds = smartSorted.map((m) => m.id)

  stderr.write(
    `${heading('OpenRouter')}: found ${freeIds.length} :free models; testing (runs=${RUNS}, concurrency=${CONCURRENCY}, timeout=${formatMs(TIMEOUT_MS)})…\n`
  )

  const apiKeys: LlmApiKeys = {
    xaiApiKey: null,
    openaiApiKey: null,
    googleApiKey: null,
    anthropicApiKey: null,
    openrouterApiKey: openrouterKey,
  }

  type Ok = {
    openrouterModelId: string
    initialLatencyMs: number
    medianLatencyMs: number
    totalLatencyMs: number
    successCount: number
    contextLength: number | null
    maxCompletionTokens: number | null
    supportedParametersCount: number
  }
  type Result = { ok: true; value: Ok } | { ok: false; openrouterModelId: string; error: string }

  const isTty = Boolean((stderr as unknown as { isTTY?: boolean }).isTTY)
  let done = 0
  let okCount = 0
  const startedAt = Date.now()
  let lastProgressPrint = 0

  const progress = (label: string) => {
    const now = Date.now()
    const everyMs = isTty ? 150 : 1500
    if (now - lastProgressPrint < everyMs) return
    lastProgressPrint = now
    const elapsedSec = Math.round((now - startedAt) / 100) / 10
    const line = `OpenRouter: ${label} ${done}/${freeIds.length}, ok=${okCount} (elapsed ${elapsedSec}s)…`
    if (isTty) {
      stderr.write(`\x1b[2K\r${line}`)
    } else {
      stderr.write(`${line}\n`)
    }
  }

  const note = (line: string) => {
    if (isTty) {
      // Clear current progress line, print note, then progress will redraw on next tick.
      stderr.write(`\x1b[2K\r${line}\n`)
      lastProgressPrint = 0
      return
    }
    stderr.write(`${line}\n`)
  }

  const results: Result[] = []
  const idToMeta = new Map(smartSorted.map((m) => [m.id, m] as const))

  // Pass 1: single run per model (avoid OpenRouter free rate limits)
  for (let i = 0; i < freeIds.length; i += TARGET_WORKING * 5) {
    const batch = freeIds.slice(i, i + TARGET_WORKING * 5)
    const batchResults = await mapWithConcurrency(batch, CONCURRENCY, async (openrouterModelId) => {
      const runStartedAt = Date.now()
      try {
        await generateTextWithModelId({
          modelId: `openai/${openrouterModelId}`,
          apiKeys,
          prompt: 'Reply with a single word: OK',
          temperature: 0,
          maxOutputTokens: 16,
          timeoutMs: TIMEOUT_MS,
          fetchImpl,
          forceOpenRouter: true,
          retries: 0,
        })

        const latencyMs = Date.now() - runStartedAt
        done += 1
        okCount += 1
        progress('tested')

        const meta = idToMeta.get(openrouterModelId) ?? null
        note(`${okLabel('ok')} ${openrouterModelId} ${dim(`(${formatMs(latencyMs)})`)}`)
        return {
          ok: true,
          value: {
            openrouterModelId,
            initialLatencyMs: latencyMs,
            medianLatencyMs: latencyMs,
            totalLatencyMs: latencyMs,
            successCount: 1,
            contextLength: meta?.contextLength ?? null,
            maxCompletionTokens: meta?.maxCompletionTokens ?? null,
            supportedParametersCount: meta?.supportedParametersCount ?? 0,
          },
        } satisfies Result
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        done += 1
        progress('tested')
        if (verbose) stderr.write(`${isTty ? '\n' : ''}fail ${openrouterModelId}: ${message}\n`)
        return { ok: false, openrouterModelId, error: message } satisfies Result
      }
    })

    for (const r of batchResults) results.push(r)
    const okCountSoFar = results.reduce((n, r) => n + (r.ok ? 1 : 0), 0)
    if (okCountSoFar >= TARGET_WORKING) break
  }

  if (isTty) stderr.write('\n')

  const ok = results
    .filter((r): r is Extract<Result, { ok: true }> => r.ok)
    .map((r) => r.value)
    .sort((a, b) => a.medianLatencyMs - b.medianLatencyMs)

  if (ok.length === 0) {
    throw new Error(`No working :free models found (tested ${results.length})`)
  }

  const buildSelection = (working: Ok[]) => {
    const smartFirst = working
      .slice()
      .sort((a, b) => {
        const aContext = a.contextLength ?? -1
        const bContext = b.contextLength ?? -1
        if (aContext !== bContext) return bContext - aContext
        const aOut = a.maxCompletionTokens ?? -1
        const bOut = b.maxCompletionTokens ?? -1
        if (aOut !== bOut) return bOut - aOut
        if (a.supportedParametersCount !== b.supportedParametersCount) {
          return b.supportedParametersCount - a.supportedParametersCount
        }
        if (a.successCount !== b.successCount) return b.successCount - a.successCount
        if (a.medianLatencyMs !== b.medianLatencyMs) return a.medianLatencyMs - b.medianLatencyMs
        return a.openrouterModelId.localeCompare(b.openrouterModelId)
      })

    const fastFirst = working
      .slice()
      .sort((a, b) => {
        if (a.successCount !== b.successCount) return b.successCount - a.successCount
        if (a.medianLatencyMs !== b.medianLatencyMs) return a.medianLatencyMs - b.medianLatencyMs
        return a.openrouterModelId.localeCompare(b.openrouterModelId)
      })

    const picked = new Set<string>()
    const ordered: string[] = []

    for (const m of smartFirst) {
      if (ordered.length >= Math.min(SMART, MAX_CANDIDATES)) break
      if (picked.has(m.openrouterModelId)) continue
      picked.add(m.openrouterModelId)
      ordered.push(m.openrouterModelId)
    }
    for (const m of fastFirst) {
      if (ordered.length >= MAX_CANDIDATES) break
      if (picked.has(m.openrouterModelId)) continue
      picked.add(m.openrouterModelId)
      ordered.push(m.openrouterModelId)
    }

    return ordered
  }

  const selectedIdsInitial = buildSelection(ok)

  // Pass 2: refine timing for selected candidates only (RUNS total)
  const refined = ok.slice()
  if (RUNS > 1 && selectedIdsInitial.length > 0) {
    stderr.write(
      `${heading('OpenRouter')}: refining ${selectedIdsInitial.length} candidates (runs=${RUNS})…\n`
    )
    const byId = new Map(refined.map((m) => [m.openrouterModelId, m] as const))
    for (const openrouterModelId of selectedIdsInitial) {
      const entry = byId.get(openrouterModelId)
      if (!entry) continue
      const latencies = [entry.initialLatencyMs]
      let successCountForModel = entry.successCount
      let lastError: unknown = null

      for (let run = 1; run < RUNS; run += 1) {
        const runStartedAt = Date.now()
        try {
          await generateTextWithModelId({
            modelId: `openai/${openrouterModelId}`,
            apiKeys,
            prompt: 'Reply with a single word: OK',
            temperature: 0,
            maxOutputTokens: 16,
            timeoutMs: TIMEOUT_MS,
            fetchImpl,
            forceOpenRouter: true,
            retries: 0,
          })
          successCountForModel += 1
          const latencyMs = Date.now() - runStartedAt
          entry.totalLatencyMs += latencyMs
          latencies.push(latencyMs)
        } catch (error) {
          lastError = error
        }
      }

      if (successCountForModel === 0 && lastError) {
        if (verbose) stderr.write(`fail refine ${openrouterModelId}: ${String(lastError)}\n`)
        continue
      }

      latencies.sort((a, b) => a - b)
      entry.medianLatencyMs = latencies[Math.floor(latencies.length / 2)] ?? entry.medianLatencyMs
      entry.successCount = successCountForModel
    }
  }

  const selectedIds = buildSelection(refined)

  const selected =
    selectedIds.length > 0
      ? selectedIds.map((id) => `openrouter/${id}`)
      : refined.slice(0, MAX_CANDIDATES).map((r) => `openrouter/${r.openrouterModelId}`)
  stderr.write(`${heading('OpenRouter')}: selected ${selected.length} candidates.\n`)

  const configPath = resolveConfigPath(env)
  let root: Record<string, unknown> = {}
  try {
    const raw = await readFile(configPath, 'utf8')
    assertNoComments(raw, configPath)
    const parsed = JSON5.parse(raw) as unknown
    if (!isRecord(parsed)) {
      throw new Error(`Invalid config file ${configPath}: expected an object at the top level`)
    }
    root = parsed
  } catch (error) {
    const code = (error as { code?: unknown } | null)?.code
    if (code !== 'ENOENT') throw error
  }

  const configModelsRaw = root.models
  const configModels = (() => {
    if (typeof configModelsRaw === 'undefined') return {}
    if (!isRecord(configModelsRaw)) {
      throw new Error(`Invalid config file ${configPath}: "models" must be an object.`)
    }
    return { ...configModelsRaw }
  })()

  configModels.free = { rules: [{ candidates: selected }] }
  root.models = configModels

  await mkdir(dirname(configPath), { recursive: true })
  const next = `${JSON.stringify(root, null, 2)}\n`
  const tmp = `${configPath}.tmp-${process.pid}-${Date.now()}`
  await writeFile(tmp, next, 'utf8')
  await rename(tmp, configPath)

  stdout.write(`Wrote ${configPath} (models.free)\n`)

  const refinedById = new Map(refined.map((m) => [m.openrouterModelId, m] as const))
  stderr.write(`\n${heading('Selected')} (sorted, avg latency)\n`)
  for (const modelId of selectedIds) {
    const r = refinedById.get(modelId)
    if (!r) continue
    const avg = r.successCount > 0 ? r.totalLatencyMs / r.successCount : r.medianLatencyMs
    stderr.write(
      `- ${modelId} ${dim(`avg ${formatMs(avg)} (n=${r.successCount})`)}\n`
    )
  }
}
