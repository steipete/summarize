import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, rmSync, statSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve as resolvePath } from 'node:path'

import type { TranscriptCache, TranscriptSource } from './content/index.js'
import type { LengthArg } from './flags.js'
import type { OutputLanguage } from './language.js'

export type CacheKind = 'extract' | 'summary' | 'transcript' | 'chat'

export type CacheConfig = {
  enabled?: boolean
  maxMb?: number
  ttlDays?: number
  path?: string
}

export const CACHE_FORMAT_VERSION = 1
export const DEFAULT_CACHE_MAX_MB = 512
export const DEFAULT_CACHE_TTL_DAYS = 30

type SqliteStatement = {
  get: (...args: unknown[]) => unknown
  all: (...args: unknown[]) => unknown[]
  run: (...args: unknown[]) => { changes?: number } | unknown
}

type SqliteDatabase = {
  exec: (sql: string) => void
  prepare: (sql: string) => SqliteStatement
  close?: () => void
}

type CacheRow = {
  value: string
  expires_at: number | null
  size_bytes: number
}

const TRANSCRIPT_SOURCES: readonly TranscriptSource[] = [
  'youtubei',
  'captionTracks',
  'yt-dlp',
  'podcastTranscript',
  'whisper',
  'apify',
  'html',
  'unavailable',
  'unknown',
]

function normalizeTranscriptSource(value: unknown): TranscriptSource | null {
  if (typeof value !== 'string') return null
  return TRANSCRIPT_SOURCES.includes(value as TranscriptSource) ? (value as TranscriptSource) : null
}

export type CacheStore = {
  getText: (kind: CacheKind, key: string) => string | null
  getJson: <T>(kind: CacheKind, key: string) => T | null
  setText: (kind: CacheKind, key: string, value: string, ttlMs: number | null) => void
  setJson: (kind: CacheKind, key: string, value: unknown, ttlMs: number | null) => void
  clear: () => void
  close: () => void
  transcriptCache: TranscriptCache
}

export type CacheState = {
  mode: 'default' | 'bypass'
  store: CacheStore | null
  ttlMs: number
  maxBytes: number
  path: string | null
}

export type CacheStats = {
  path: string
  sizeBytes: number
  totalEntries: number
  counts: Record<CacheKind, number>
}

const isBun = typeof (globalThis as { Bun?: unknown }).Bun !== 'undefined'
let warningFilterInstalled = false

const installSqliteWarningFilter = () => {
  if (warningFilterInstalled) return
  warningFilterInstalled = true
  const original = process.emitWarning.bind(process)
  process.emitWarning = ((warning: unknown, ...args: unknown[]) => {
    const message =
      typeof warning === 'string'
        ? warning
        : warning && typeof (warning as { message?: unknown }).message === 'string'
          ? String((warning as { message?: unknown }).message)
          : ''
    const type =
      typeof args[0] === 'string' ? args[0] : (args[0] as { type?: unknown } | undefined)?.type
    const name = (warning as { name?: unknown } | undefined)?.name
    const normalizedType = typeof type === 'string' ? type : typeof name === 'string' ? name : ''
    if (normalizedType === 'ExperimentalWarning' && message.toLowerCase().includes('sqlite')) {
      return
    }
    return original(warning as never, ...(args as [never]))
  }) as typeof process.emitWarning
}

async function openSqlite(path: string): Promise<SqliteDatabase> {
  if (isBun) {
    const mod = (await import('bun:sqlite')) as { Database: new (path: string) => SqliteDatabase }
    return new mod.Database(path)
  }
  installSqliteWarningFilter()
  const mod = (await import('node:sqlite')) as unknown as {
    DatabaseSync: new (path: string) => SqliteDatabase
  }
  return new mod.DatabaseSync(path)
}

function ensureDir(path: string) {
  mkdirSync(path, { recursive: true })
}

function resolveHomeDir(env: Record<string, string | undefined>): string | null {
  const home = env.HOME?.trim() || env.USERPROFILE?.trim()
  return home || null
}

export function resolveCachePath({
  env,
  cachePath,
}: {
  env: Record<string, string | undefined>
  cachePath: string | null
}): string | null {
  const home = resolveHomeDir(env)
  const raw = cachePath?.trim()
  if (raw && raw.length > 0) {
    if (raw.startsWith('~')) {
      if (!home) return null
      const expanded = raw === '~' ? home : join(home, raw.slice(2))
      return resolvePath(expanded)
    }
    return isAbsolute(raw) ? raw : home ? resolvePath(join(home, raw)) : null
  }
  if (!home) return null
  return join(home, '.summarize', 'cache.sqlite')
}

export async function createCacheStore({
  path,
  maxBytes,
  transcriptNamespace,
}: {
  path: string
  maxBytes: number
  transcriptNamespace?: string | null
}): Promise<CacheStore> {
  ensureDir(dirname(path))
  const db = await openSqlite(path)
  db.exec('PRAGMA journal_mode=WAL')
  db.exec('PRAGMA synchronous=NORMAL')
  db.exec('PRAGMA busy_timeout=5000')
  db.exec('PRAGMA auto_vacuum=INCREMENTAL')
  db.exec(`
    CREATE TABLE IF NOT EXISTS cache_entries (
      kind TEXT NOT NULL,
      key TEXT NOT NULL,
      value TEXT NOT NULL,
      size_bytes INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      last_accessed_at INTEGER NOT NULL,
      expires_at INTEGER,
      PRIMARY KEY (kind, key)
    )
  `)
  db.exec('CREATE INDEX IF NOT EXISTS idx_cache_accessed ON cache_entries(last_accessed_at)')
  db.exec('CREATE INDEX IF NOT EXISTS idx_cache_expires ON cache_entries(expires_at)')

  const stmtGet = db.prepare(
    'SELECT value, expires_at, size_bytes FROM cache_entries WHERE kind = ? AND key = ?'
  )
  const stmtTouch = db.prepare(
    'UPDATE cache_entries SET last_accessed_at = ? WHERE kind = ? AND key = ?'
  )
  const stmtDelete = db.prepare('DELETE FROM cache_entries WHERE kind = ? AND key = ?')
  const stmtDeleteExpired = db.prepare(
    'DELETE FROM cache_entries WHERE expires_at IS NOT NULL AND expires_at <= ?'
  )
  const stmtUpsert = db.prepare(`
    INSERT INTO cache_entries (
      kind, key, value, size_bytes, created_at, last_accessed_at, expires_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(kind, key) DO UPDATE SET
      value = excluded.value,
      size_bytes = excluded.size_bytes,
      created_at = excluded.created_at,
      last_accessed_at = excluded.last_accessed_at,
      expires_at = excluded.expires_at
  `)
  const stmtTotalSize = db.prepare(
    'SELECT COALESCE(SUM(size_bytes), 0) AS total FROM cache_entries'
  )
  const stmtOldest = db.prepare(
    'SELECT kind, key, size_bytes FROM cache_entries ORDER BY last_accessed_at ASC LIMIT ?'
  )
  const stmtClear = db.prepare('DELETE FROM cache_entries')

  const sweepExpired = (now: number) => {
    stmtDeleteExpired.run(now)
  }

  const enforceSize = () => {
    if (!Number.isFinite(maxBytes) || maxBytes <= 0) return
    const row = stmtTotalSize.get() as { total?: number | null } | undefined
    let total = typeof row?.total === 'number' ? row.total : 0
    if (total <= maxBytes) return
    const batchSize = 50
    while (total > maxBytes) {
      const rows = stmtOldest.all(batchSize) as Array<{
        kind: string
        key: string
        size_bytes: number
      }>
      if (rows.length === 0) break
      for (const row of rows) {
        if (total <= maxBytes) break
        stmtDelete.run(row.kind, row.key)
        total -= row.size_bytes ?? 0
      }
      if (total <= maxBytes) break
    }
    db.exec('PRAGMA incremental_vacuum')
  }

  const readEntry = (kind: CacheKind, key: string, now: number): CacheRow | null => {
    const row = stmtGet.get(kind, key) as CacheRow | undefined
    if (!row) return null
    const expiresAt = row.expires_at
    if (typeof expiresAt === 'number' && expiresAt <= now) {
      stmtDelete.run(kind, key)
      return { ...row, expires_at: expiresAt }
    }
    stmtTouch.run(now, kind, key)
    return row
  }

  const getText = (kind: CacheKind, key: string): string | null => {
    const now = Date.now()
    const row = readEntry(kind, key, now)
    if (!row) return null
    const expiresAt = row.expires_at
    if (typeof expiresAt === 'number' && expiresAt <= now) return null
    return row.value
  }

  const getJson = <T>(kind: CacheKind, key: string): T | null => {
    const text = getText(kind, key)
    if (!text) return null
    try {
      return JSON.parse(text) as T
    } catch {
      return null
    }
  }

  const setText = (kind: CacheKind, key: string, value: string, ttlMs: number | null) => {
    const now = Date.now()
    sweepExpired(now)
    const expiresAt = typeof ttlMs === 'number' ? now + ttlMs : null
    const sizeBytes = Buffer.byteLength(value, 'utf8')
    stmtUpsert.run(kind, key, value, sizeBytes, now, now, expiresAt)
    enforceSize()
  }

  const setJson = (kind: CacheKind, key: string, value: unknown, ttlMs: number | null) => {
    setText(kind, key, JSON.stringify(value), ttlMs)
  }

  const clear = () => {
    stmtClear.run()
    db.exec('PRAGMA incremental_vacuum')
  }

  const close = () => {
    try {
      db.exec('PRAGMA wal_checkpoint(TRUNCATE)')
    } catch {
      // ignore
    }
    db.close?.()
  }

  const normalizedTranscriptNamespace =
    typeof transcriptNamespace === 'string' && transcriptNamespace.trim().length > 0
      ? transcriptNamespace.trim()
      : null
  const getTranscriptKey = (url: string): string =>
    buildTranscriptCacheKey({
      url,
      namespace: normalizedTranscriptNamespace,
    })

  const transcriptCache: TranscriptCache = {
    get: async ({ url }) => {
      const now = Date.now()
      const key = getTranscriptKey(url)
      const row = readEntry('transcript', key, now)
      if (!row) return null
      const expired = typeof row.expires_at === 'number' && row.expires_at <= now
      let payload: {
        content?: string | null
        source?: TranscriptSource | string | null
        metadata?: unknown
      } | null = null
      try {
        payload = JSON.parse(row.value) as {
          content?: string | null
          source?: TranscriptSource | string | null
          metadata?: unknown
        }
      } catch {
        payload = null
      }
      return {
        content: payload?.content ?? null,
        source: normalizeTranscriptSource(payload?.source) ?? null,
        expired,
        metadata: (payload?.metadata as Record<string, unknown> | null | undefined) ?? null,
      }
    },
    set: async ({ url, content, source, ttlMs, metadata, service, resourceKey }) => {
      const key = getTranscriptKey(url)
      setJson(
        'transcript',
        key,
        {
          content,
          source,
          metadata: metadata ?? null,
          service,
          resourceKey,
          namespace: normalizedTranscriptNamespace,
          formatVersion: CACHE_FORMAT_VERSION,
        },
        ttlMs
      )
    },
  }

  return { getText, getJson, setText, setJson, clear, close, transcriptCache }
}

export function clearCacheFiles(path: string) {
  rmSync(path, { force: true })
  rmSync(`${path}-wal`, { force: true })
  rmSync(`${path}-shm`, { force: true })
}

export function hashString(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

export function hashJson(value: unknown): string {
  return hashString(JSON.stringify(value))
}

export function normalizeContentForHash(content: string): string {
  return content.replaceAll('\r\n', '\n').trim()
}

export function extractTaggedBlock(prompt: string, tag: 'instructions' | 'content'): string | null {
  const open = `<${tag}>`
  const close = `</${tag}>`
  const start = prompt.indexOf(open)
  if (start === -1) return null
  const end = prompt.indexOf(close, start + open.length)
  if (end === -1) return null
  return prompt.slice(start + open.length, end).trim()
}

export function buildPromptHash(prompt: string): string {
  const instructions = extractTaggedBlock(prompt, 'instructions') ?? prompt
  return hashString(instructions.trim())
}

export function buildLengthKey(lengthArg: LengthArg): string {
  return lengthArg.kind === 'preset'
    ? `preset:${lengthArg.preset}`
    : `chars:${lengthArg.maxCharacters}`
}

export function buildLanguageKey(outputLanguage: OutputLanguage): string {
  return outputLanguage.kind === 'auto' ? 'auto' : outputLanguage.tag
}

export function buildExtractCacheKey({
  url,
  options,
}: {
  url: string
  options: Record<string, unknown>
}): string {
  return hashJson({ url, options, formatVersion: CACHE_FORMAT_VERSION })
}

export function buildSummaryCacheKey({
  contentHash,
  promptHash,
  model,
  lengthKey,
  languageKey,
}: {
  contentHash: string
  promptHash: string
  model: string
  lengthKey: string
  languageKey: string
}): string {
  return hashJson({
    contentHash,
    promptHash,
    model,
    lengthKey,
    languageKey,
    formatVersion: CACHE_FORMAT_VERSION,
  })
}

export function buildTranscriptCacheKey({
  url,
  namespace,
  formatVersion,
}: {
  url: string
  namespace: string | null
  formatVersion?: number
}): string {
  return hashJson({
    url,
    namespace,
    formatVersion: formatVersion ?? CACHE_FORMAT_VERSION,
  })
}

export async function readCacheStats(path: string): Promise<CacheStats | null> {
  if (!existsSync(path)) return null
  const db = await openSqlite(path)
  try {
    db.exec('PRAGMA query_only = ON')
  } catch {
    // ignore
  }
  const counts: Record<CacheKind, number> = {
    extract: 0,
    summary: 0,
    transcript: 0,
    chat: 0,
  }
  const rows = db.prepare('SELECT kind, COUNT(*) AS count FROM cache_entries GROUP BY kind').all()
  for (const row of rows as Array<{ kind?: string; count?: number }>) {
    if (row?.kind && typeof row.count === 'number' && row.kind in counts) {
      counts[row.kind as CacheKind] = row.count
    }
  }
  const totalRow = db.prepare('SELECT COUNT(*) AS count FROM cache_entries').get() as
    | { count?: number }
    | undefined
  const totalEntries = typeof totalRow?.count === 'number' ? totalRow.count : 0
  db.close?.()
  return {
    path,
    sizeBytes: getSqliteFileSizeBytes(path),
    totalEntries,
    counts,
  }
}

export function getSqliteFileSizeBytes(path: string): number {
  let total = 0
  try {
    total += statSync(path).size
  } catch {
    // ignore
  }
  try {
    total += statSync(`${path}-wal`).size
  } catch {
    // ignore
  }
  try {
    total += statSync(`${path}-shm`).size
  } catch {
    // ignore
  }
  return total
}
