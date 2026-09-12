import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import {
  CACHE_FORMAT_VERSION,
  buildPortableCacheRow,
  parseCacheJson,
  type CacheKind,
} from "@steipete/summarize-core/runtime";
import { openSqlite } from "./cache-database.js";
import { buildTranscriptCacheKey } from "./cache-keys.js";
import { cleanupSlidesPayload, collectSlidesPayloadArtifactPaths } from "./cache-slides-cleanup.js";
import {
  TRANSCRIPT_SOURCES,
  type TranscriptCache,
  type TranscriptSource,
} from "./content/index.js";

type CacheRow = {
  value: string;
  expires_at: number | null;
  size_bytes: number;
  created_at: number;
};

function normalizeTranscriptSource(value: unknown): TranscriptSource | null {
  return TRANSCRIPT_SOURCES.find((candidate) => candidate === value) ?? null;
}

export type CacheStore = {
  getText: (kind: CacheKind, key: string) => string | null;
  getJson: <T>(kind: CacheKind, key: string) => T | null;
  setText: (kind: CacheKind, key: string, value: string, ttlMs: number | null) => void;
  setJson: (kind: CacheKind, key: string, value: unknown, ttlMs: number | null) => void;
  clear: () => void;
  close: () => void;
  transcriptCache: TranscriptCache;
};

export async function createCacheStore({
  path,
  maxBytes,
  transcriptNamespace,
}: {
  path: string;
  maxBytes: number;
  transcriptNamespace?: string | null;
}): Promise<CacheStore> {
  mkdirSync(dirname(path), { recursive: true });
  const db = await openSqlite(path);
  db.exec("PRAGMA busy_timeout=5000");
  db.exec("PRAGMA journal_mode=WAL");
  db.exec("PRAGMA synchronous=NORMAL");
  db.exec("PRAGMA auto_vacuum=INCREMENTAL");
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
  `);
  db.exec("CREATE INDEX IF NOT EXISTS idx_cache_accessed ON cache_entries(last_accessed_at)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_cache_expires ON cache_entries(expires_at)");

  const stmtGet = db.prepare(
    "SELECT value, expires_at, size_bytes, created_at FROM cache_entries WHERE kind = ? AND key = ?",
  );
  const stmtTouch = db.prepare(
    "UPDATE cache_entries SET last_accessed_at = ? WHERE kind = ? AND key = ?",
  );
  const stmtDelete = db.prepare("DELETE FROM cache_entries WHERE kind = ? AND key = ?");
  const stmtSelectExpired = db.prepare(
    "SELECT kind, key, value, created_at FROM cache_entries WHERE expires_at IS NOT NULL AND expires_at <= ?",
  );
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
  `);
  const stmtTotalSize = db.prepare(
    "SELECT COALESCE(SUM(size_bytes), 0) AS total FROM cache_entries",
  );
  const stmtOldest = db.prepare(
    "SELECT kind, key, value, size_bytes, created_at FROM cache_entries ORDER BY last_accessed_at ASC LIMIT ?",
  );
  const stmtSlides = db.prepare("SELECT kind, key, value FROM cache_entries WHERE kind = 'slides'");
  const stmtClear = db.prepare("DELETE FROM cache_entries");

  const buildReferencedSlideArtifacts = (excludingKey: string): Set<string> => {
    const rows = stmtSlides.all() as Array<{ key: string; value: string }>;
    const referenced = new Set<string>();
    for (const row of rows) {
      if (row.key === excludingKey) continue;
      for (const filePath of collectSlidesPayloadArtifactPaths(row.value)) {
        referenced.add(filePath);
      }
    }
    return referenced;
  };

  const deleteEntry = (kind: string, key: string, value: string, createdAt?: number | null) => {
    if (kind === "slides") {
      const referenced = buildReferencedSlideArtifacts(key);
      cleanupSlidesPayload(value, { preservePaths: referenced, preserveNewerThanMs: createdAt });
    }
    stmtDelete.run(kind, key);
  };

  const sweepExpired = (now: number) => {
    const rows = stmtSelectExpired.all(now) as Array<{
      kind: string;
      key: string;
      value: string;
      created_at: number;
    }>;
    for (const row of rows) {
      deleteEntry(row.kind, row.key, row.value, row.created_at);
    }
  };

  const enforceSize = () => {
    if (!Number.isFinite(maxBytes) || maxBytes <= 0) return;
    const row = stmtTotalSize.get() as { total?: number | null } | undefined;
    let total = typeof row?.total === "number" ? row.total : 0;
    if (total <= maxBytes) return;
    const batchSize = 50;
    while (total > maxBytes) {
      const rows = stmtOldest.all(batchSize) as Array<{
        kind: string;
        key: string;
        value: string;
        size_bytes: number;
        created_at: number;
      }>;
      if (rows.length === 0) break;
      for (const row of rows) {
        if (total <= maxBytes) break;
        deleteEntry(row.kind, row.key, row.value, row.created_at);
        total -= row.size_bytes ?? 0;
      }
      if (total <= maxBytes) break;
    }
    db.exec("PRAGMA incremental_vacuum");
  };

  const readEntry = (kind: CacheKind, key: string, now: number): CacheRow | null => {
    const row = stmtGet.get(kind, key) as CacheRow | undefined;
    if (!row) return null;
    const expiresAt = row.expires_at;
    if (typeof expiresAt === "number" && expiresAt <= now) {
      deleteEntry(kind, key, row.value, row.created_at);
      return { ...row, expires_at: expiresAt };
    }
    stmtTouch.run(now, kind, key);
    return row;
  };

  const getText = (kind: CacheKind, key: string): string | null => {
    const now = Date.now();
    const row = readEntry(kind, key, now);
    if (!row) return null;
    const expiresAt = row.expires_at;
    if (typeof expiresAt === "number" && expiresAt <= now) return null;
    return row.value;
  };

  const getJson = <T>(kind: CacheKind, key: string): T | null => {
    return parseCacheJson<T>(getText(kind, key));
  };

  const setText = (kind: CacheKind, key: string, value: string, ttlMs: number | null) => {
    const now = Date.now();
    sweepExpired(now);
    const row = buildPortableCacheRow({ kind, key, value, ttlMs, now });
    stmtUpsert.run(
      row.kind,
      row.key,
      row.value,
      row.sizeBytes,
      row.createdAt,
      row.lastAccessedAt,
      row.expiresAt,
    );
    enforceSize();
  };

  const setJson = (kind: CacheKind, key: string, value: unknown, ttlMs: number | null) => {
    setText(kind, key, JSON.stringify(value), ttlMs);
  };

  const clear = () => {
    const rows = stmtSlides.all() as Array<{ value: string }>;
    for (const row of rows) {
      cleanupSlidesPayload(row.value);
    }
    stmtClear.run();
    db.exec("PRAGMA incremental_vacuum");
  };

  const close = () => {
    try {
      db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    } catch {
      // ignore
    }
    db.close();
  };

  const normalizedTranscriptNamespace =
    typeof transcriptNamespace === "string" && transcriptNamespace.trim().length > 0
      ? transcriptNamespace.trim()
      : null;
  const getTranscriptKey = (url: string, fileMtime?: number | null): string =>
    buildTranscriptCacheKey({
      url,
      namespace: normalizedTranscriptNamespace,
      fileMtime,
    });

  const transcriptCache: TranscriptCache = {
    get: async ({ url, fileMtime }) => {
      const now = Date.now();
      const key = getTranscriptKey(url, fileMtime);
      const row = readEntry("transcript", key, now);
      if (!row) return null;
      const expired = typeof row.expires_at === "number" && row.expires_at <= now;
      const payload = parseCacheJson<{
        content?: string | null;
        source?: TranscriptSource | string | null;
        metadata?: unknown;
        resourceKey?: unknown;
      }>(row.value);
      const resourceKey =
        typeof payload?.resourceKey === "string" && payload.resourceKey.trim().length > 0
          ? payload.resourceKey.trim()
          : null;
      return {
        content: payload?.content ?? null,
        source: normalizeTranscriptSource(payload?.source) ?? null,
        expired,
        metadata: (payload?.metadata as Record<string, unknown> | null | undefined) ?? null,
        resourceKey,
      };
    },
    set: async ({ url, content, source, ttlMs, metadata, service, resourceKey, fileMtime }) => {
      const key = getTranscriptKey(url, fileMtime);
      setJson(
        "transcript",
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
        ttlMs,
      );
    },
  };

  return { getText, getJson, setText, setJson, clear, close, transcriptCache };
}
