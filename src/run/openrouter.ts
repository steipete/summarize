import { fetchWithTimeout } from './fetch-with-timeout.js'

function truncateList(items: string[], max: number): string {
  const normalized = items.map((item) => item.trim()).filter(Boolean)
  if (normalized.length <= max) return normalized.join(', ')
  return `${normalized.slice(0, max).join(', ')} (+${normalized.length - max} more)`
}

function parseOpenRouterModelId(modelId: string): { author: string; slug: string } | null {
  const normalized = modelId.trim()
  if (!normalized.startsWith('openrouter/')) return null
  const rest = normalized.slice('openrouter/'.length)
  const [author, ...slugParts] = rest.split('/')
  if (!author || slugParts.length === 0) return null
  return { author, slug: slugParts.join('/') }
}

async function resolveOpenRouterProvidersForModels({
  modelIds,
  fetchImpl,
  timeoutMs,
}: {
  modelIds: string[]
  fetchImpl: typeof fetch
  timeoutMs: number
}): Promise<Map<string, string[]>> {
  const results = new Map<string, string[]>()
  const unique = Array.from(new Set(modelIds.map((id) => id.trim()).filter(Boolean)))

  await Promise.all(
    unique.map(async (modelId) => {
      const parsed = parseOpenRouterModelId(modelId)
      if (!parsed) return
      const url = `https://openrouter.ai/api/v1/models/${encodeURIComponent(parsed.author)}/${encodeURIComponent(parsed.slug)}/endpoints`
      try {
        const response = await fetchWithTimeout(
          fetchImpl,
          url,
          { headers: { Accept: 'application/json' } },
          Math.min(timeoutMs, 15_000)
        )
        if (!response.ok) return
        const payload = (await response.json()) as {
          data?: { endpoints?: Array<{ provider_name?: unknown } | null> }
        }
        const endpoints = Array.isArray(payload.data?.endpoints) ? payload.data?.endpoints : []
        const providers = endpoints
          .map((endpoint) =>
            endpoint && typeof endpoint.provider_name === 'string'
              ? endpoint.provider_name.trim()
              : null
          )
          .filter((value): value is string => Boolean(value))
        const uniqueProviders = Array.from(new Set(providers)).sort((a, b) => a.localeCompare(b))
        if (uniqueProviders.length > 0) results.set(modelId, uniqueProviders)
      } catch {
        // best-effort only
      }
    })
  )

  return results
}

export async function buildOpenRouterNoAllowedProvidersMessage({
  attempts,
  fetchImpl,
  timeoutMs,
}: {
  attempts: Array<{ userModelId: string }>
  fetchImpl: typeof fetch
  timeoutMs: number
}): Promise<string> {
  const modelIds = attempts
    .map((attempt) => attempt.userModelId)
    .filter((id) => id.startsWith('openrouter/'))
  const tried = truncateList(modelIds, 6)

  const providerMap = await resolveOpenRouterProvidersForModels({ modelIds, fetchImpl, timeoutMs })
  const allProviders = Array.from(new Set(Array.from(providerMap.values()).flat())).sort((a, b) =>
    a.localeCompare(b)
  )

  const providersHint =
    allProviders.length > 0 ? ` Providers to allow: ${truncateList(allProviders, 10)}.` : ''

  return `OpenRouter could not route any models with this API key (no allowed providers). Tried: ${tried}.${providersHint} Hint: increase --timeout (e.g. 10m) and/or use --debug/--verbose to see per-model failures. (OpenRouter: Settings → API Keys → edit key → Allowed providers.)`
}
