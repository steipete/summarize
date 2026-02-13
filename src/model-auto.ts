import * as piAi from '@mariozechner/pi-ai'
import type { AutoRule, AutoRuleKind, CliProvider, SummarizeConfig } from './config.js'
import { normalizeGatewayStyleModelId, parseGatewayStyleModelId } from './llm/model-id.js'
import type { LiteLlmCatalog } from './pricing/litellm.js'
import {
  resolveLiteLlmMaxInputTokensForModelId,
  resolveLiteLlmPricingForModelId,
} from './pricing/litellm.js'

export type AutoSelectionInput = {
  kind: AutoRuleKind
  promptTokens: number | null
  desiredOutputTokens: number | null
  requiresVideoUnderstanding: boolean
  env: Record<string, string | undefined>
  config: SummarizeConfig | null
  catalog: LiteLlmCatalog | null
  openrouterProvidersFromEnv: string[] | null
  openrouterModelIds?: string[] | null
  cliAvailability?: Partial<Record<CliProvider, boolean>>
}

export type AutoModelAttempt = {
  transport: 'native' | 'openrouter' | 'cli'
  userModelId: string
  llmModelId: string | null
  openrouterProviders: string[] | null
  forceOpenRouter: boolean
  requiredEnv:
    | 'XAI_API_KEY'
    | 'OPENAI_API_KEY'
    | 'GEMINI_API_KEY'
    | 'ANTHROPIC_API_KEY'
    | 'OPENROUTER_API_KEY'
    | 'Z_AI_API_KEY'
    | 'CLI_CLAUDE'
    | 'CLI_CODEX'
    | 'CLI_GEMINI'
  debug: string
}

type OpenRouterModelIndex = {
  byId: Map<string, string>
  bySlug: Map<string, Set<string>>
  bySlugNormalized: Map<string, Set<string>>
}

let cachedOpenRouterIndex: OpenRouterModelIndex | null = null
let cachedOpenRouterIndexReady = false

function buildOpenRouterModelIndex(modelIds: string[]): OpenRouterModelIndex {
  const byId = new Map<string, string>()
  const bySlug = new Map<string, Set<string>>()
  const bySlugNormalized = new Map<string, Set<string>>()
  for (const raw of modelIds) {
    const trimmed = raw.trim()
    if (trimmed.length === 0) continue
    if (!trimmed.includes('/')) continue
    const normalized = trimmed.toLowerCase()
    // Preserve original casing for display while indexing by lowercase.
    if (!byId.has(normalized)) byId.set(normalized, trimmed)
    const slash = normalized.indexOf('/')
    if (slash === -1 || slash === normalized.length - 1) continue
    const slug = normalized.slice(slash + 1)
    let matches = bySlug.get(slug)
    if (!matches) {
      matches = new Set()
      bySlug.set(slug, matches)
    }
    matches.add(normalized)
    const normalizedSlug = normalizeSlugForMatch(slug)
    if (normalizedSlug.length > 0) {
      let normalizedMatches = bySlugNormalized.get(normalizedSlug)
      if (!normalizedMatches) {
        normalizedMatches = new Set()
        bySlugNormalized.set(normalizedSlug, normalizedMatches)
      }
      normalizedMatches.add(normalized)
    }
  }
  return { byId, bySlug, bySlugNormalized }
}

function getOpenRouterModelIndex(
  override: string[] | null | undefined
): OpenRouterModelIndex | null {
  // Tests can inject a deterministic OpenRouter model list to avoid SDK coupling.
  if (Array.isArray(override)) return buildOpenRouterModelIndex(override)
  // Lazy, process-wide cache to avoid recomputing the SDK catalog.
  if (cachedOpenRouterIndexReady) return cachedOpenRouterIndex
  cachedOpenRouterIndexReady = true
  const ids =
    typeof piAi.getModels === 'function'
      ? piAi.getModels('openrouter').map((model) => model.id)
      : []
  cachedOpenRouterIndex = ids.length > 0 ? buildOpenRouterModelIndex(ids) : null
  return cachedOpenRouterIndex
}

function resolveOpenRouterModelIdForNative({
  nativeModelId,
  index,
}: {
  nativeModelId: string
  index: OpenRouterModelIndex | null
}): string | null {
  if (!index) return null
  const canonical = normalizeGatewayStyleModelId(nativeModelId)
  const canonicalLower = canonical.toLowerCase()
  // Prefer exact match on canonical <provider>/<model> when OpenRouter mirrors the id.
  const direct = index.byId.get(canonicalLower)
  if (direct) return direct
  const slash = canonicalLower.indexOf('/')
  if (slash === -1 || slash === canonicalLower.length - 1) return null
  // Fall back to a unique slug match (author differs, e.g. xai → x-ai).
  const slug = canonicalLower.slice(slash + 1)
  const matches = index.bySlug.get(slug)
  if (matches && matches.size === 1) {
    const only = matches.values().next().value as string | undefined
    const exactMatch = only ? (index.byId.get(only) ?? null) : null
    if (exactMatch) return exactMatch
  }
  // Retry with punctuation-insensitive slug (e.g. grok-4-1-fast → grok-4.1-fast).
  const normalizedSlug = normalizeSlugForMatch(slug)
  if (!normalizedSlug) return null
  const normalizedMatches = index.bySlugNormalized.get(normalizedSlug)
  if (!normalizedMatches || normalizedMatches.size !== 1) return null
  const normalizedOnly = normalizedMatches.values().next().value as string | undefined
  return normalizedOnly ? (index.byId.get(normalizedOnly) ?? null) : null
}

function normalizeSlugForMatch(slug: string): string {
  return slug.toLowerCase().replace(/[^a-z0-9]+/g, '')
}

const DEFAULT_RULES: AutoRule[] = [
  {
    when: ['video'],
    candidates: ['google/gemini-3-flash-preview', 'google/gemini-2.5-flash-lite-preview-09-2025'],
  },
  {
    when: ['image'],
    candidates: [
      'google/gemini-3-flash-preview',
      'openai/gpt-5-mini',
      'anthropic/claude-sonnet-4-5',
    ],
  },
  {
    when: ['website', 'youtube', 'text'],
    bands: [
      {
        token: { max: 50_000 },
        candidates: [
          'google/gemini-3-flash-preview',
          'openai/gpt-5-mini',
          'anthropic/claude-sonnet-4-5',
        ],
      },
      {
        token: { max: 200_000 },
        candidates: [
          'google/gemini-3-flash-preview',
          'openai/gpt-5-mini',
          'anthropic/claude-sonnet-4-5',
        ],
      },
      {
        candidates: [
          'xai/grok-4-fast-non-reasoning',
          'google/gemini-3-flash-preview',
          'openai/gpt-5-mini',
          'anthropic/claude-sonnet-4-5',
        ],
      },
    ],
  },
  {
    when: ['file'],
    candidates: [
      'google/gemini-3-flash-preview',
      'openai/gpt-5-mini',
      'anthropic/claude-sonnet-4-5',
    ],
  },
  {
    candidates: [
      'google/gemini-3-flash-preview',
      'openai/gpt-5-mini',
      'anthropic/claude-sonnet-4-5',
      'xai/grok-4-fast-non-reasoning',
    ],
  },
]

const DEFAULT_CLI_MODELS: Record<CliProvider, string> = {
  claude: 'sonnet',
  codex: 'gpt-5.2',
  gemini: 'gemini-3-flash-preview',
}

function isCliProviderEnabled(provider: CliProvider, config: SummarizeConfig | null): boolean {
  const cli = config?.cli
  if (!Array.isArray(cli?.enabled) || cli.enabled.length === 0) return false
  return cli.enabled.includes(provider)
}

function isCandidateOpenRouter(modelId: string): boolean {
  return modelId.trim().toLowerCase().startsWith('openrouter/')
}

function isCandidateCli(modelId: string): boolean {
  return modelId.trim().toLowerCase().startsWith('cli/')
}

function parseCliCandidate(
  modelId: string
): { provider: CliProvider; model: string | null } | null {
  if (!isCandidateCli(modelId)) return null
  const parts = modelId
    .trim()
    .split('/')
    .map((entry) => entry.trim())
  if (parts.length < 2) return null
  const provider = parts[1]?.toLowerCase()
  if (provider !== 'claude' && provider !== 'codex' && provider !== 'gemini') return null
  const model = parts.slice(2).join('/').trim()
  return { provider, model: model.length > 0 ? model : null }
}

function normalizeOpenRouterModelId(raw: string): string | null {
  const trimmed = raw.trim()
  if (trimmed.length === 0) return null
  if (!trimmed.includes('/')) return null
  return trimmed.toLowerCase()
}

function requiredEnvForCandidate(modelId: string): AutoModelAttempt['requiredEnv'] {
  if (isCandidateCli(modelId)) {
    const parsed = parseCliCandidate(modelId)
    if (!parsed) return 'CLI_CLAUDE'
    return parsed.provider === 'codex'
      ? 'CLI_CODEX'
      : parsed.provider === 'gemini'
        ? 'CLI_GEMINI'
        : 'CLI_CLAUDE'
  }
  if (isCandidateOpenRouter(modelId)) return 'OPENROUTER_API_KEY'
  const parsed = parseGatewayStyleModelId(normalizeGatewayStyleModelId(modelId))
  return parsed.provider === 'xai'
    ? 'XAI_API_KEY'
    : parsed.provider === 'google'
      ? 'GEMINI_API_KEY'
      : parsed.provider === 'anthropic'
        ? 'ANTHROPIC_API_KEY'
        : parsed.provider === 'zai'
          ? 'Z_AI_API_KEY'
          : 'OPENAI_API_KEY'
}

export function envHasKey(
  env: Record<string, string | undefined>,
  requiredEnv: AutoModelAttempt['requiredEnv']
): boolean {
  if (requiredEnv === 'GEMINI_API_KEY') {
    return Boolean(
      env.GEMINI_API_KEY?.trim() ||
        env.GOOGLE_GENERATIVE_AI_API_KEY?.trim() ||
        env.GOOGLE_API_KEY?.trim()
    )
  }
  if (requiredEnv === 'Z_AI_API_KEY') {
    return Boolean(env.Z_AI_API_KEY?.trim() || env.ZAI_API_KEY?.trim())
  }
  return Boolean(env[requiredEnv]?.trim())
}

function tokenMatchesBand({
  promptTokens,
  band,
}: {
  promptTokens: number | null
  band: NonNullable<AutoRule['bands']>[number]
}): boolean {
  const token = band.token
  if (!token) return true
  if (typeof promptTokens !== 'number' || !Number.isFinite(promptTokens)) {
    return typeof token.min !== 'number' && typeof token.max !== 'number'
  }
  const min = typeof token.min === 'number' ? token.min : 0
  const max = typeof token.max === 'number' ? token.max : Number.POSITIVE_INFINITY
  return promptTokens >= min && promptTokens <= max
}

function resolveRuleCandidates({
  kind,
  promptTokens,
  config,
}: {
  kind: AutoRuleKind
  promptTokens: number | null
  config: SummarizeConfig | null
}): string[] {
  const rules = (() => {
    const model = config?.model
    if (
      model &&
      'mode' in model &&
      model.mode === 'auto' &&
      Array.isArray(model.rules) &&
      model.rules.length > 0
    ) {
      return model.rules
    }
    return DEFAULT_RULES
  })()

  for (const rule of rules) {
    const when = rule.when
    if (Array.isArray(when) && when.length > 0 && !when.includes(kind)) {
      continue
    }

    if (Array.isArray(rule.candidates) && rule.candidates.length > 0) {
      return rule.candidates
    }

    const bands = rule.bands
    if (Array.isArray(bands) && bands.length > 0) {
      for (const band of bands) {
        if (tokenMatchesBand({ promptTokens, band })) {
          return band.candidates
        }
      }
    }
  }

  const fallback = rules[rules.length - 1]
  return fallback?.candidates ?? []
}

function prependCliCandidates({
  candidates,
  config,
}: {
  candidates: string[]
  config: SummarizeConfig | null
}): string[] {
  const cli = config?.cli
  if (!Array.isArray(cli?.enabled) || cli.enabled.length === 0) return candidates
  const cliCandidates: string[] = []
  const add = (provider: CliProvider, modelOverride?: string) => {
    if (!isCliProviderEnabled(provider, config)) return
    const model = modelOverride?.trim() || DEFAULT_CLI_MODELS[provider]
    if (!model) return
    const id = `cli/${provider}/${model}`
    if (!cliCandidates.includes(id)) cliCandidates.push(id)
  }

  const enabledOrder: CliProvider[] = cli.enabled

  for (const provider of enabledOrder) {
    const modelOverride =
      provider === 'gemini'
        ? cli?.gemini?.model
        : provider === 'codex'
          ? cli?.codex?.model
          : cli?.claude?.model
    add(provider, modelOverride)
  }
  if (cliCandidates.length === 0) return candidates
  return [...cliCandidates, ...candidates]
}

function estimateCostUsd({
  pricing,
  promptTokens,
  outputTokens,
}: {
  pricing: { inputUsdPerToken: number; outputUsdPerToken: number } | null
  promptTokens: number | null
  outputTokens: number | null
}): number | null {
  if (!pricing) return null
  if (typeof pricing.inputUsdPerToken !== 'number' || typeof pricing.outputUsdPerToken !== 'number')
    return null
  const inTok =
    typeof promptTokens === 'number' && Number.isFinite(promptTokens) && promptTokens > 0
      ? promptTokens
      : 0
  const outTok =
    typeof outputTokens === 'number' && Number.isFinite(outputTokens) && outputTokens > 0
      ? outputTokens
      : 0
  const cost = inTok * pricing.inputUsdPerToken + outTok * pricing.outputUsdPerToken
  return Number.isFinite(cost) ? cost : null
}

function isVideoUnderstandingCapable(modelId: string): boolean {
  try {
    const parsed = parseGatewayStyleModelId(normalizeGatewayStyleModelId(modelId))
    return parsed.provider === 'google'
  } catch {
    return false
  }
}

export function buildAutoModelAttempts(input: AutoSelectionInput): AutoModelAttempt[] {
  const baseCandidates = resolveRuleCandidates({
    kind: input.kind,
    promptTokens: input.promptTokens,
    config: input.config,
  })
  const candidates = prependCliCandidates({ candidates: baseCandidates, config: input.config })
  const shouldResolveOpenRouterIndex =
    !input.requiresVideoUnderstanding && envHasKey(input.env, 'OPENROUTER_API_KEY')
  // Resolve OpenRouter ids once per run (or use injected test list).
  const openrouterIndex = shouldResolveOpenRouterIndex
    ? getOpenRouterModelIndex(input.openrouterModelIds)
    : null

  const attempts: AutoModelAttempt[] = []
  for (const modelRawEntry of candidates) {
    const modelRaw = modelRawEntry.trim()
    if (modelRaw.length === 0) continue

    const explicitCli = isCandidateCli(modelRaw)
    const explicitOpenRouter = isCandidateOpenRouter(modelRaw)

    const shouldSkipForVideo =
      input.requiresVideoUnderstanding &&
      (explicitOpenRouter || explicitCli || !isVideoUnderstandingCapable(modelRaw))
    if (shouldSkipForVideo) {
      continue
    }

    const addAttempt = (
      modelId: string,
      options: {
        openrouter: boolean
        openrouterProviders: string[] | null
        transport: AutoModelAttempt['transport']
      }
    ) => {
      const required = requiredEnvForCandidate(modelId)
      const hasKey =
        options.transport === 'cli'
          ? Boolean(
              input.cliAvailability?.[parseCliCandidate(modelId)?.provider ?? 'claude'] ?? false
            )
          : envHasKey(input.env, required)
      if (options.transport === 'cli' && !hasKey) {
        return
      }

      const catalog = options.transport === 'cli' ? null : input.catalog
      const catalogModelId = options.openrouter ? modelId.slice('openrouter/'.length) : modelId
      const maxIn = catalog ? resolveLiteLlmMaxInputTokensForModelId(catalog, catalogModelId) : null
      const promptTokens = input.promptTokens
      if (
        options.transport !== 'cli' &&
        typeof promptTokens === 'number' &&
        Number.isFinite(promptTokens) &&
        typeof maxIn === 'number' &&
        Number.isFinite(maxIn) &&
        maxIn > 0 &&
        promptTokens > maxIn
      ) {
        return
      }

      const pricing = catalog ? resolveLiteLlmPricingForModelId(catalog, catalogModelId) : null
      const estimated = estimateCostUsd({
        pricing,
        promptTokens: input.promptTokens,
        outputTokens: input.desiredOutputTokens,
      })

      const userModelId =
        options.transport === 'cli'
          ? modelId
          : options.openrouter
            ? modelId
            : normalizeGatewayStyleModelId(modelId)
      const openrouterModelId = options.openrouter
        ? normalizeOpenRouterModelId(modelId.slice('openrouter/'.length))
        : null
      if (options.openrouter && !openrouterModelId) {
        return
      }
      const llmModelId =
        options.transport === 'cli'
          ? null
          : options.openrouter
            ? `openai/${openrouterModelId}`
            : normalizeGatewayStyleModelId(modelId)
      const debugParts = [
        `model=${
          options.transport === 'cli'
            ? userModelId
            : options.openrouter
              ? `openrouter/${openrouterModelId}`
              : userModelId
        }`,
        `transport=${options.transport}`,
        `order=${attempts.length + 1}`,
        `key=${hasKey ? 'yes' : 'no'}(${required})`,
        `promptTok=${typeof input.promptTokens === 'number' ? input.promptTokens : 'unknown'}`,
        `maxIn=${typeof maxIn === 'number' ? maxIn : 'unknown'}`,
        `estUsd=${typeof estimated === 'number' ? estimated.toExponential(2) : 'unknown'}`,
      ]

      attempts.push({
        transport: options.transport,
        userModelId: options.openrouter ? `openrouter/${openrouterModelId}` : userModelId,
        llmModelId,
        openrouterProviders: options.openrouterProviders,
        forceOpenRouter: options.openrouter,
        requiredEnv: required,
        debug: debugParts.join(' '),
      })
    }

    if (explicitCli) {
      addAttempt(modelRaw, {
        openrouter: false,
        openrouterProviders: null,
        transport: 'cli',
      })
      continue
    }

    if (explicitOpenRouter) {
      addAttempt(modelRaw, {
        openrouter: true,
        openrouterProviders: input.openrouterProvidersFromEnv,
        transport: 'openrouter',
      })
      continue
    }

    addAttempt(modelRaw, {
      openrouter: false,
      openrouterProviders: input.openrouterProvidersFromEnv,
      transport: 'native',
    })

    const canAddOpenRouterFallback =
      !input.requiresVideoUnderstanding && envHasKey(input.env, 'OPENROUTER_API_KEY')
    if (canAddOpenRouterFallback) {
      // Map native provider/model to OpenRouter author/slug; skip when ambiguous.
      const openrouterModelId = resolveOpenRouterModelIdForNative({
        nativeModelId: modelRaw,
        index: openrouterIndex,
      })
      if (openrouterModelId) {
        addAttempt(`openrouter/${openrouterModelId}`, {
          openrouter: true,
          openrouterProviders: input.openrouterProvidersFromEnv,
          transport: 'openrouter',
        })
      }
    }
  }

  const seen = new Set<string>()
  const unique: AutoModelAttempt[] = []
  for (const a of attempts) {
    const key = `${a.transport}:${a.forceOpenRouter ? 'or' : 'native'}:${a.userModelId}:${a.openrouterProviders?.join(',') ?? ''}`
    if (seen.has(key)) continue
    seen.add(key)
    unique.push(a)
  }
  return unique
}
