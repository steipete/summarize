export type LlmProvider = 'xai' | 'openai' | 'google'

export type ParsedModelId = {
  provider: LlmProvider
  /**
   * Provider-native model id (no prefix), e.g. `grok-4-fast-non-reasoning`.
   */
  model: string
  /**
   * Canonical gateway-style id, e.g. `xai/grok-4-fast-non-reasoning`.
   */
  canonical: string
}

const PROVIDERS: LlmProvider[] = ['xai', 'openai', 'google']

export function normalizeGatewayStyleModelId(raw: string): string {
  const trimmed = raw.trim()
  if (trimmed.length === 0) {
    throw new Error('Missing model id')
  }

  // Common historical alias (used in prompts/docs earlier)
  if (trimmed === 'grok-4-1-fast-non-reasoning') return 'xai/grok-4-fast-non-reasoning'
  if (trimmed === 'grok-4.1-fast-non-reasoning') return 'xai/grok-4-fast-non-reasoning'
  if (trimmed === 'xai/grok-4-1-fast-non-reasoning') return 'xai/grok-4-fast-non-reasoning'
  if (trimmed === 'xai/grok-4.1-fast-non-reasoning') return 'xai/grok-4-fast-non-reasoning'

  const slash = trimmed.indexOf('/')
  if (slash === -1) {
    // Best-effort inference for backwards-compat CLI usage.
    if (trimmed.startsWith('grok-')) return `xai/${trimmed}`
    if (trimmed.startsWith('gemini-')) return `google/${trimmed}`
    return `openai/${trimmed}`
  }

  const provider = trimmed.slice(0, slash).toLowerCase()
  const model = trimmed.slice(slash + 1)
  if (!PROVIDERS.includes(provider as LlmProvider)) {
    throw new Error(
      `Unsupported model provider "${provider}". Use xai/..., openai/..., or google/...`
    )
  }
  if (model.trim().length === 0) {
    throw new Error('Missing model id after provider prefix')
  }
  return `${provider}/${model}`
}

export function parseGatewayStyleModelId(raw: string): ParsedModelId {
  const canonical = normalizeGatewayStyleModelId(raw)
  const slash = canonical.indexOf('/')
  const provider = canonical.slice(0, slash) as LlmProvider
  const model = canonical.slice(slash + 1)
  return { provider, model, canonical }
}
