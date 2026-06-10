import {
  DEFAULT_CACHE_TTL_DAYS,
  buildPortableCacheRow,
  isPortableCacheRowExpired,
  parseCacheJson,
  summarizePortableCacheRows,
  type CacheStats,
  type PortableCacheRow,
} from "../../../../src/shared/cache-store";
import type { PanelCachePayload } from "./panel-contracts";

type StoredPanelCacheRow = PortableCacheRow & {
  format: "panel";
};

type BrowserStorageArea = {
  get: (keys: string | string[] | null, callback: (items: Record<string, unknown>) => void) => void;
  set: (items: Record<string, unknown>, callback?: () => void) => void;
  remove: (keys: string | string[], callback?: () => void) => void;
};

const INDEX_KEY = "summarize.browserCache.index.v1";
const ENTRY_PREFIX = "summarize.browserCache.entry.v1.";
const CACHE_TTL_MS = DEFAULT_CACHE_TTL_DAYS * 24 * 60 * 60 * 1000;
const MAX_BROWSER_CACHE_BYTES = 8 * 1024 * 1024;

function normalizeCacheUrl(url: string): string {
  const trimmed = url.trim();
  if (!trimmed) return "";
  try {
    const parsed = new URL(trimmed);
    return parsed.toString();
  } catch {
    return trimmed;
  }
}

function buildPanelCacheKey(url: string): string {
  return `panel:${normalizeCacheUrl(url)}`;
}

function buildStorageKey(cacheKey: string): string {
  return `${ENTRY_PREFIX}${encodeURIComponent(cacheKey)}`;
}

async function storageGet<T>(storage: BrowserStorageArea, key: string): Promise<T | undefined> {
  return await new Promise((resolve, reject) => {
    storage.get(key, (result) => {
      const error = chrome.runtime.lastError;
      if (error) {
        reject(new Error(error.message));
        return;
      }
      resolve((result as Record<string, T | undefined>)[key]);
    });
  });
}

async function storageGetMany(
  storage: BrowserStorageArea,
  keys: string[] | null,
): Promise<Record<string, unknown>> {
  return await new Promise((resolve, reject) => {
    storage.get(keys, (result) => {
      const error = chrome.runtime.lastError;
      if (error) {
        reject(new Error(error.message));
        return;
      }
      resolve(result);
    });
  });
}

async function storageSet(storage: BrowserStorageArea, values: Record<string, unknown>) {
  await new Promise<void>((resolve, reject) => {
    storage.set(values, () => {
      const error = chrome.runtime.lastError;
      if (error) {
        reject(new Error(error.message));
        return;
      }
      resolve();
    });
  });
}

async function storageRemove(storage: BrowserStorageArea, keys: string | string[]) {
  await new Promise<void>((resolve, reject) => {
    storage.remove(keys, () => {
      const error = chrome.runtime.lastError;
      if (error) {
        reject(new Error(error.message));
        return;
      }
      resolve();
    });
  });
}

function normalizeIndex(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function isStoredPanelCacheRow(value: unknown): value is StoredPanelCacheRow {
  const row = value as Partial<StoredPanelCacheRow> | null;
  return (
    Boolean(row) &&
    row?.format === "panel" &&
    row.kind === "summary" &&
    typeof row.key === "string" &&
    typeof row.value === "string" &&
    typeof row.sizeBytes === "number" &&
    typeof row.createdAt === "number" &&
    typeof row.lastAccessedAt === "number" &&
    (typeof row.expiresAt === "number" || row.expiresAt === null)
  );
}

export type BrowserPanelCacheStore = {
  getPanel: (url: string) => Promise<PanelCachePayload | null>;
  setPanel: (payload: PanelCachePayload) => Promise<void>;
  stats: () => Promise<CacheStats>;
  clear: () => Promise<CacheStats>;
};

export function createBrowserPanelCacheStore(
  storage: BrowserStorageArea = chrome.storage.local,
): BrowserPanelCacheStore {
  let mutationTail: Promise<unknown> = Promise.resolve();

  const runSerialized = async <T>(task: () => Promise<T>): Promise<T> => {
    const run = mutationTail.then(task, task);
    mutationTail = run.catch(() => undefined);
    return await run;
  };

  const loadIndex = async () => normalizeIndex(await storageGet<unknown>(storage, INDEX_KEY));

  const loadEntryKeys = async () => {
    const indexed = await loadIndex();
    const all = await storageGetMany(storage, null);
    const discovered = Object.keys(all).filter((key) => key.startsWith(ENTRY_PREFIX));
    return Array.from(new Set([...indexed, ...discovered]));
  };

  const saveIndex = async (keys: string[]) => {
    await storageSet(storage, { [INDEX_KEY]: Array.from(new Set(keys)) });
  };

  const removeEntries = async (keys: string[]) => {
    if (keys.length === 0) return;
    await storageRemove(storage, keys);
    const removeSet = new Set(keys);
    await saveIndex((await loadIndex()).filter((key) => !removeSet.has(key)));
  };

  const readRows = async () => {
    const index = await loadEntryKeys();
    if (index.length === 0) return [] as Array<{ storageKey: string; row: StoredPanelCacheRow }>;
    const raw = await storageGetMany(storage, index);
    const rows: Array<{ storageKey: string; row: StoredPanelCacheRow }> = [];
    const missing: string[] = [];
    for (const storageKey of index) {
      const value = raw[storageKey];
      if (isStoredPanelCacheRow(value)) {
        rows.push({ storageKey, row: value });
      } else {
        missing.push(storageKey);
      }
    }
    if (missing.length > 0) {
      await removeEntries(missing);
    }
    return rows;
  };

  const prune = async (now = Date.now()) => {
    let rows = await readRows();
    const expired = rows
      .filter(({ row }) => isPortableCacheRowExpired(row, now))
      .map(({ storageKey }) => storageKey);
    if (expired.length > 0) {
      await removeEntries(expired);
      rows = rows.filter(({ storageKey }) => !expired.includes(storageKey));
    }

    let total = rows.reduce((sum, { row }) => sum + Math.max(0, row.sizeBytes), 0);
    if (total <= MAX_BROWSER_CACHE_BYTES) return;
    const evicted: string[] = [];
    for (const { storageKey, row } of rows.sort(
      (left, right) => left.row.lastAccessedAt - right.row.lastAccessedAt,
    )) {
      if (total <= MAX_BROWSER_CACHE_BYTES) break;
      evicted.push(storageKey);
      total -= Math.max(0, row.sizeBytes);
    }
    await removeEntries(evicted);
  };

  const pruneBeforeInsert = async (
    storageKey: string,
    row: StoredPanelCacheRow,
    now = Date.now(),
  ): Promise<boolean> => {
    if (row.sizeBytes > MAX_BROWSER_CACHE_BYTES) {
      await removeEntries([storageKey]);
      return false;
    }
    let rows = await readRows();
    const removeSet = new Set<string>();
    for (const existing of rows) {
      if (isPortableCacheRowExpired(existing.row, now)) {
        removeSet.add(existing.storageKey);
      }
    }
    rows = rows.filter(({ storageKey: key }) => !removeSet.has(key) && key !== storageKey);
    let total = rows.reduce((sum, existing) => sum + Math.max(0, existing.row.sizeBytes), 0);
    for (const existing of rows.sort(
      (left, right) => left.row.lastAccessedAt - right.row.lastAccessedAt,
    )) {
      if (total + row.sizeBytes <= MAX_BROWSER_CACHE_BYTES) break;
      removeSet.add(existing.storageKey);
      total -= Math.max(0, existing.row.sizeBytes);
    }
    await removeEntries(Array.from(removeSet));
    return true;
  };

  const buildStats = async () => {
    await prune();
    const rows = await readRows();
    return summarizePortableCacheRows(
      rows.map(({ row }) => row),
      `chrome.storage.local (${DEFAULT_CACHE_TTL_DAYS} days)`,
    );
  };

  const getPanel = async (url: string): Promise<PanelCachePayload | null> =>
    runSerialized(async () => {
      const cacheKey = buildPanelCacheKey(url);
      const storageKey = buildStorageKey(cacheKey);
      const row = await storageGet<unknown>(storage, storageKey);
      if (!isStoredPanelCacheRow(row)) return null;
      const now = Date.now();
      if (isPortableCacheRowExpired(row, now)) {
        await removeEntries([storageKey]);
        return null;
      }
      const payload = parseCacheJson<PanelCachePayload>(row.value);
      if (!payload || normalizeCacheUrl(payload.url) !== normalizeCacheUrl(url)) {
        await removeEntries([storageKey]);
        return null;
      }
      await storageSet(storage, {
        [storageKey]: {
          ...row,
          lastAccessedAt: now,
        },
      });
      return payload;
    });

  const setPanel = async (payload: PanelCachePayload) =>
    runSerialized(async () => {
      if (!payload.url.trim()) return;
      const cacheKey = buildPanelCacheKey(payload.url);
      const storageKey = buildStorageKey(cacheKey);
      const row: StoredPanelCacheRow = {
        ...buildPortableCacheRow({
          kind: "summary",
          key: cacheKey,
          value: JSON.stringify(payload),
          ttlMs: CACHE_TTL_MS,
        }),
        format: "panel",
      };
      const shouldStore = await pruneBeforeInsert(storageKey, row);
      if (!shouldStore) return;
      const index = await loadIndex();
      await storageSet(storage, {
        [storageKey]: row,
        [INDEX_KEY]: Array.from(new Set([...index, storageKey])),
      });
    });

  const stats = async () => runSerialized(buildStats);

  const clear = async () =>
    runSerialized(async () => {
      const keys = await loadEntryKeys();
      if (keys.length > 0) {
        await storageRemove(storage, keys);
      }
      await storageSet(storage, { [INDEX_KEY]: [] });
      return buildStats();
    });

  return { getPanel, setPanel, stats, clear };
}
