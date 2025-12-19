import path from 'node:path'

import {
  type LiteLlmCatalog,
  type LiteLlmLoadResult,
  loadLiteLlmCatalog as loadLiteLlmCatalogTokentally,
  resolveLiteLlmMaxOutputTokens as resolveLiteLlmMaxOutputTokensTokentally,
  resolveLiteLlmPricing as resolveLiteLlmPricingTokentally,
} from 'tokentally/node'

function withDefaultCacheDir(
  env: Record<string, string | undefined>
): Record<string, string | undefined> {
  if (typeof env.TOKENTALLY_CACHE_DIR === 'string' && env.TOKENTALLY_CACHE_DIR.trim().length > 0) {
    return env
  }
  const home = env.HOME?.trim()
  if (!home) return env
  return { ...env, TOKENTALLY_CACHE_DIR: path.join(home, '.summarize', 'cache') }
}

export type { LiteLlmCatalog, LiteLlmLoadResult }

export async function loadLiteLlmCatalog({
  env,
  fetchImpl,
  nowMs = Date.now(),
}: {
  env: Record<string, string | undefined>
  fetchImpl: typeof fetch
  nowMs?: number
}): Promise<LiteLlmLoadResult> {
  return loadLiteLlmCatalogTokentally({
    env: withDefaultCacheDir(env),
    fetchImpl,
    nowMs,
  })
}

export type LlmPerTokenPricing = { inputUsdPerToken: number; outputUsdPerToken: number }

export function resolveLiteLlmPricingForModelId(
  catalog: LiteLlmCatalog,
  modelId: string
): LlmPerTokenPricing | null {
  return resolveLiteLlmPricingTokentally(catalog, modelId)
}

export function resolveLiteLlmMaxOutputTokensForModelId(
  catalog: LiteLlmCatalog,
  modelId: string
): number | null {
  return resolveLiteLlmMaxOutputTokensTokentally(catalog, modelId)
}
