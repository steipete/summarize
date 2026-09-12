import { existsSync, rmSync, statSync } from "node:fs";
import { isAbsolute, join, resolve as resolvePath } from "node:path";
import {
  createEmptyCacheCounts,
  type CacheKind,
  type CacheStats,
} from "@steipete/summarize-core/runtime";
import { openSqlite } from "./cache-database.js";
import type { CacheStore } from "./cache-store.js";

export {
  buildAttachmentContentHash,
  buildExtractCacheKey,
  buildExtractCacheKeyValue,
  buildLanguageKey,
  buildLengthKey,
  buildPromptContentHash,
  buildPromptHash,
  buildSlidesCacheKey,
  buildSlidesCacheKeyValue,
  buildSummaryCacheKey,
  buildSummaryCacheKeyValue,
  buildTranscriptCacheKey,
  buildTranscriptCacheKeyValue,
  hashJson,
  hashString,
  hashBytes,
  normalizeContentForHash,
  extractTaggedBlock,
} from "./cache-keys.js";
export {
  CACHE_FORMAT_VERSION,
  DEFAULT_CACHE_MAX_MB,
  DEFAULT_CACHE_TTL_DAYS,
  type CacheKind,
  type CacheStats,
} from "@steipete/summarize-core/runtime";
export { createCacheStore, type CacheStore } from "./cache-store.js";

export type CacheConfig = {
  enabled?: boolean;
  maxMb?: number;
  ttlDays?: number;
  path?: string;
};

export type CacheState = {
  mode: "default" | "bypass";
  store: CacheStore | null;
  ttlMs: number;
  maxBytes: number;
  path: string | null;
};

function resolveHomeDir(env: Record<string, string | undefined>): string | null {
  const home = env.HOME?.trim() || env.USERPROFILE?.trim();
  return home || null;
}

export function resolveCachePath({
  env,
  cachePath,
}: {
  env: Record<string, string | undefined>;
  cachePath: string | null;
}): string | null {
  const home = resolveHomeDir(env);
  const raw = cachePath?.trim();
  if (raw && raw.length > 0) {
    if (raw === "~" || raw.startsWith("~/")) {
      if (!home) return null;
      const expanded = raw === "~" ? home : join(home, raw.slice(2));
      return resolvePath(expanded);
    }
    return isAbsolute(raw) ? raw : home ? resolvePath(join(home, raw)) : null;
  }
  if (!home) return null;
  return join(home, ".summarize", "cache.sqlite");
}

export function clearCacheFiles(path: string) {
  rmSync(path, { force: true });
  rmSync(`${path}-wal`, { force: true });
  rmSync(`${path}-shm`, { force: true });
}

export async function readCacheStats(path: string): Promise<CacheStats | null> {
  if (!existsSync(path)) return null;
  const counts = createEmptyCacheCounts();
  let totalEntries: number;
  const db = await openSqlite(path);
  try {
    try {
      db.exec("PRAGMA query_only = ON");
    } catch {
      // ignore
    }
    const rows = db
      .prepare("SELECT kind, COUNT(*) AS count FROM cache_entries GROUP BY kind")
      .all();
    for (const row of rows as Array<{ kind?: string; count?: number }>) {
      if (row?.kind && typeof row.count === "number" && Object.hasOwn(counts, row.kind)) {
        counts[row.kind as CacheKind] = row.count;
      }
    }
    const totalRow = db.prepare("SELECT COUNT(*) AS count FROM cache_entries").get() as
      | { count?: number }
      | undefined;
    totalEntries = typeof totalRow?.count === "number" ? totalRow.count : 0;
  } finally {
    db.close();
  }
  return {
    path,
    sizeBytes: getSqliteFileSizeBytes(path),
    totalEntries,
    counts,
  };
}

export function getSqliteFileSizeBytes(path: string): number {
  let total = 0;
  for (const filePath of [path, `${path}-wal`, `${path}-shm`]) {
    try {
      total += statSync(filePath).size;
    } catch {
      // SQLite sidecars may not exist, or may disappear during a checkpoint.
    }
  }
  return total;
}
