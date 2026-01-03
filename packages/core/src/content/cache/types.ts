import type { TranscriptSource } from '../link-preview/types.js'

/** Public shape returned by transcript cache implementations. */
export interface TranscriptCacheGetResult {
  content: string | null
  source: TranscriptSource | null
  expired: boolean
  metadata?: Record<string, unknown> | null
}

/** Public write arguments for transcript cache implementations. */
export interface TranscriptCacheSetArgs {
  url: string
  service: string
  resourceKey: string | null
  content: string | null
  source: TranscriptSource | null
  ttlMs: number
  metadata?: Record<string, unknown> | null
  fileMtime?: number | null
}

/** Public interface for pluggable transcript caches (CLI, daemon, apps). */
export interface TranscriptCache {
  get(args: { url: string; fileMtime?: number | null }): Promise<TranscriptCacheGetResult | null>
  set(args: TranscriptCacheSetArgs): Promise<void>
}
