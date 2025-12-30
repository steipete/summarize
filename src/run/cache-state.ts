import { existsSync } from 'node:fs'

import {
  type CacheState,
  createCacheStore,
  DEFAULT_CACHE_MAX_MB,
  DEFAULT_CACHE_TTL_DAYS,
  resolveCachePath,
} from '../cache.js'
import type { SummarizeConfig } from '../config.js'

export async function createCacheStateFromConfig({
  envForRun,
  config,
  noCacheFlag = false,
  transcriptNamespace = null,
}: {
  envForRun: Record<string, string | undefined>
  config: SummarizeConfig | null
  noCacheFlag?: boolean
  transcriptNamespace?: string | null
}): Promise<CacheState> {
  const cacheEnabled = config?.cache?.enabled !== false
  const cachePath = resolveCachePath({
    env: envForRun,
    cachePath: config?.cache?.path ?? null,
  })
  const cacheMaxMb =
    typeof config?.cache?.maxMb === 'number' ? config.cache.maxMb : DEFAULT_CACHE_MAX_MB
  const cacheTtlDays =
    typeof config?.cache?.ttlDays === 'number' ? config.cache.ttlDays : DEFAULT_CACHE_TTL_DAYS
  const cacheMaxBytes = Math.max(0, cacheMaxMb) * 1024 * 1024
  const cacheTtlMs = Math.max(0, cacheTtlDays) * 24 * 60 * 60 * 1000
  const cacheMode: CacheState['mode'] =
    !cacheEnabled || noCacheFlag || !cachePath ? 'bypass' : 'default'
  const cacheStore =
    cacheMode === 'default' && cachePath
      ? await createCacheStore({
          path: cachePath,
          maxBytes: cacheMaxBytes,
          transcriptNamespace,
        })
      : null

  return {
    mode: cacheMode,
    store: cacheStore,
    ttlMs: cacheTtlMs,
    maxBytes: cacheMaxBytes,
    path: cachePath,
  }
}

export async function refreshCacheStoreIfMissing({
  cacheState,
  transcriptNamespace = null,
}: {
  cacheState: CacheState
  transcriptNamespace?: string | null
}): Promise<boolean> {
  if (cacheState.mode !== 'default') return false
  const path = cacheState.path
  if (!path) return false
  const fileExists = existsSync(path)
  if (cacheState.store) {
    // Keep the existing store to avoid closing statements while requests are in flight.
    return false
  }
  cacheState.store = await createCacheStore({
    path,
    maxBytes: cacheState.maxBytes,
    transcriptNamespace,
  })
  return true
}
