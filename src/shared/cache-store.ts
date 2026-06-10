export type CacheKind = "extract" | "summary" | "transcript" | "chat" | "slides";

export type CacheCounts = Record<CacheKind, number>;

export type CacheStats = {
  path: string;
  sizeBytes: number;
  totalEntries: number;
  counts: CacheCounts;
};

export type PortableCacheRow = {
  kind: CacheKind;
  key: string;
  value: string;
  sizeBytes: number;
  createdAt: number;
  lastAccessedAt: number;
  expiresAt: number | null;
};

export const CACHE_FORMAT_VERSION = 2;
export const DEFAULT_CACHE_MAX_MB = 512;
export const DEFAULT_CACHE_TTL_DAYS = 30;
export const CACHE_KINDS: readonly CacheKind[] = [
  "extract",
  "summary",
  "transcript",
  "chat",
  "slides",
];

export function createEmptyCacheCounts(): CacheCounts {
  return {
    extract: 0,
    summary: 0,
    transcript: 0,
    chat: 0,
    slides: 0,
  };
}

export function isCacheKind(value: unknown): value is CacheKind {
  return typeof value === "string" && CACHE_KINDS.includes(value as CacheKind);
}

export function measureCacheValueBytes(value: string): number {
  const maybeBuffer = (globalThis as typeof globalThis & { Buffer?: { byteLength?: unknown } })
    .Buffer;
  if (typeof maybeBuffer?.byteLength === "function") {
    return maybeBuffer.byteLength(value, "utf8") as number;
  }
  return new TextEncoder().encode(value).byteLength;
}

export function buildPortableCacheRow({
  kind,
  key,
  value,
  ttlMs,
  now = Date.now(),
}: {
  kind: CacheKind;
  key: string;
  value: string;
  ttlMs: number | null;
  now?: number;
}): PortableCacheRow {
  return {
    kind,
    key,
    value,
    sizeBytes: measureCacheValueBytes(value),
    createdAt: now,
    lastAccessedAt: now,
    expiresAt: typeof ttlMs === "number" ? now + ttlMs : null,
  };
}

export function isPortableCacheRowExpired(
  row: Pick<PortableCacheRow, "expiresAt">,
  now = Date.now(),
): boolean {
  return typeof row.expiresAt === "number" && row.expiresAt <= now;
}

export function parseCacheJson<T>(value: string | null | undefined): T | null {
  if (!value) return null;
  try {
    return JSON.parse(value) as T;
  } catch {
    return null;
  }
}

export function summarizePortableCacheRows(
  rows: Iterable<Pick<PortableCacheRow, "kind" | "sizeBytes">>,
  path: string,
): CacheStats {
  const counts = createEmptyCacheCounts();
  let sizeBytes = 0;
  let totalEntries = 0;
  for (const row of rows) {
    if (!isCacheKind(row.kind)) continue;
    counts[row.kind] += 1;
    sizeBytes += Math.max(0, row.sizeBytes);
    totalEntries += 1;
  }
  return { path, sizeBytes, totalEntries, counts };
}
