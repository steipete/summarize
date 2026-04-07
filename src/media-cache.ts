import { createHash } from "node:crypto";
import { createReadStream, promises as fs } from "node:fs";
import { isAbsolute, join, resolve as resolvePath } from "node:path";
import type { MediaCache, MediaCacheEntry } from "./content/index.js";

export type MediaCacheVerifyMode = "none" | "size" | "hash";

export type MediaCacheConfig = {
  enabled?: boolean;
  maxMb?: number;
  ttlDays?: number;
  path?: string;
  verify?: MediaCacheVerifyMode;
};

type MediaCacheIndexEntry = {
  url: string;
  fileName: string;
  sizeBytes: number | null;
  sha256: string | null;
  mediaType: string | null;
  filename: string | null;
  createdAtMs: number;
  lastAccessAtMs: number;
  expiresAtMs: number | null;
};

type MediaCacheIndex = {
  version: 1;
  entries: Record<string, MediaCacheIndexEntry>;
};

export const DEFAULT_MEDIA_CACHE_MAX_MB = 2048;
export const DEFAULT_MEDIA_CACHE_TTL_DAYS = 7;
export const DEFAULT_MEDIA_CACHE_VERIFY: MediaCacheVerifyMode = "size";

const INDEX_VERSION = 1;
const INDEX_FILENAME = "index.json";

const ensureDir = async (path: string) => {
  await fs.mkdir(path, { recursive: true });
};

export function resolveMediaCachePath({
  env,
  cachePath,
}: {
  env: Record<string, string | undefined>;
  cachePath: string | null;
}): string | null {
  const raw = cachePath?.trim();
  const home = env.HOME?.trim() || env.USERPROFILE?.trim() || null;
  if (raw) {
    if (raw.startsWith("~/") && home) {
      return resolvePath(join(home, raw.slice(2)));
    }
    return isAbsolute(raw) ? raw : home ? resolvePath(join(home, raw)) : resolvePath(raw);
  }
  if (!home) return null;
  return join(home, ".summarize", "cache", "media");
}

const hashKey = (value: string): string => {
  return createHash("sha256").update(value).digest("hex");
};

const hashFile = async (filePath: string): Promise<string> => {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(filePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", () => resolve(hash.digest("hex")));
  });
};

const resolveExtension = (filename: string | null, mediaType: string | null): string => {
  const safeName = filename?.trim() ?? "";
  const match = safeName.match(/\.([a-z0-9]{2,5})$/i);
  if (match) return `.${match[1].toLowerCase()}`;
  if (!mediaType) return ".bin";
  const normalized = mediaType.toLowerCase();
  if (normalized.includes("audio/mpeg")) return ".mp3";
  if (normalized.includes("audio/mp4")) return ".m4a";
  if (normalized.includes("audio/ogg")) return ".ogg";
  if (normalized.includes("audio/wav")) return ".wav";
  if (normalized.includes("audio/flac")) return ".flac";
  if (normalized.includes("video/mp4")) return ".mp4";
  if (normalized.includes("video/webm")) return ".webm";
  if (
    normalized.includes("application/vnd.apple.mpegurl") ||
    normalized.includes("application/x-mpegurl")
  )
    return ".m3u8";
  return ".bin";
};

const readIndex = async (indexPath: string): Promise<MediaCacheIndex> => {
  try {
    const raw = await fs.readFile(indexPath, "utf8");
    const parsed = JSON.parse(raw) as Partial<MediaCacheIndex>;
    if (
      parsed &&
      parsed.version === INDEX_VERSION &&
      parsed.entries &&
      typeof parsed.entries === "object"
    ) {
      return {
        version: INDEX_VERSION,
        entries: parsed.entries as Record<string, MediaCacheIndexEntry>,
      };
    }
  } catch {
    // ignore
  }
  return { version: INDEX_VERSION, entries: {} };
};

const writeIndex = async (indexPath: string, index: MediaCacheIndex) => {
  const tmpPath = `${indexPath}.tmp-${process.pid}-${Date.now()}`;
  await fs.writeFile(tmpPath, JSON.stringify(index));
  await fs.rename(tmpPath, indexPath);
};

const removeEntry = async (
  cacheDir: string,
  index: MediaCacheIndex,
  key: string,
  entry: MediaCacheIndexEntry,
) => {
  delete index.entries[key];
  const path = join(cacheDir, entry.fileName);
  await fs.rm(path, { force: true });
};

const shouldCacheUrl = (url: string): boolean => {
  return /^https?:/i.test(url.trim());
};

const normalizeEntry = (cacheDir: string, entry: MediaCacheIndexEntry): MediaCacheEntry => {
  return {
    url: entry.url,
    filePath: join(cacheDir, entry.fileName),
    sizeBytes: entry.sizeBytes,
    sha256: entry.sha256,
    mediaType: entry.mediaType,
    filename: entry.filename,
    createdAtMs: entry.createdAtMs,
    lastAccessAtMs: entry.lastAccessAtMs,
    expiresAtMs: entry.expiresAtMs,
  };
};

const moveFile = async (fromPath: string, toPath: string) => {
  if (fromPath === toPath) return;
  await fs.rm(toPath, { force: true });
  try {
    await fs.rename(fromPath, toPath);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | null)?.code;
    if (code !== "EXDEV") throw error;
    await fs.copyFile(fromPath, toPath);
    await fs.rm(fromPath, { force: true });
  }
};

export async function createMediaCache({
  path,
  maxBytes,
  ttlMs,
  verify = DEFAULT_MEDIA_CACHE_VERIFY,
}: {
  path: string;
  maxBytes: number;
  ttlMs: number;
  verify?: MediaCacheVerifyMode;
}): Promise<MediaCache> {
  const cacheDir = path;
  const indexPath = join(cacheDir, INDEX_FILENAME);
  await ensureDir(cacheDir);

  const pruneExpired = async (index: MediaCacheIndex, now: number) => {
    const entries = Object.entries(index.entries);
    for (const [key, entry] of entries) {
      if (entry.expiresAtMs != null && entry.expiresAtMs <= now) {
        await removeEntry(cacheDir, index, key, entry);
      }
    }
  };

  const computeSizeBytes = async (entry: MediaCacheIndexEntry): Promise<number | null> => {
    try {
      const stat = await fs.stat(join(cacheDir, entry.fileName));
      return stat.size;
    } catch {
      return null;
    }
  };

  const enforceMaxBytes = async (index: MediaCacheIndex) => {
    if (!Number.isFinite(maxBytes) || maxBytes <= 0) return;
    const entries = Object.entries(index.entries);
    if (entries.length === 0) return;
    let totalBytes = 0;
    for (const [, entry] of entries) {
      if (typeof entry.sizeBytes !== "number") {
        entry.sizeBytes = await computeSizeBytes(entry);
      }
      if (typeof entry.sizeBytes === "number") {
        totalBytes += entry.sizeBytes;
      }
    }
    if (totalBytes <= maxBytes) return;
    const sorted = entries
      .map(([key, entry]) => ({ key, entry }))
      .sort((a, b) => a.entry.lastAccessAtMs - b.entry.lastAccessAtMs);
    for (const { key, entry } of sorted) {
      if (totalBytes <= maxBytes) break;
      const size = typeof entry.sizeBytes === "number" ? entry.sizeBytes : 0;
      await removeEntry(cacheDir, index, key, entry);
      totalBytes -= size;
    }
  };

  const get = async ({ url }: { url: string }): Promise<MediaCacheEntry | null> => {
    if (!shouldCacheUrl(url)) return null;
    const now = Date.now();
    const index = await readIndex(indexPath);
    await pruneExpired(index, now);
    const key = hashKey(url);
    const entry = index.entries[key];
    if (!entry) return null;

    const filePath = join(cacheDir, entry.fileName);
    let stat: { size: number } | null = null;
    try {
      stat = await fs.stat(filePath);
    } catch {
      await removeEntry(cacheDir, index, key, entry);
      await writeIndex(indexPath, index);
      return null;
    }

    if (verify === "size" && typeof entry.sizeBytes === "number") {
      if (stat.size !== entry.sizeBytes) {
        await removeEntry(cacheDir, index, key, entry);
        await writeIndex(indexPath, index);
        return null;
      }
    }
    if (verify === "hash") {
      const hash = await hashFile(filePath);
      if (entry.sha256 && entry.sha256 !== hash) {
        await removeEntry(cacheDir, index, key, entry);
        await writeIndex(indexPath, index);
        return null;
      }
      entry.sha256 = hash;
    }

    if (typeof entry.sizeBytes !== "number" || entry.sizeBytes !== stat.size) {
      entry.sizeBytes = stat.size;
    }
    entry.lastAccessAtMs = now;
    index.entries[key] = entry;
    await writeIndex(indexPath, index);
    return normalizeEntry(cacheDir, entry);
  };

  const put = async ({
    url,
    filePath,
    mediaType = null,
    filename = null,
  }: {
    url: string;
    filePath: string;
    mediaType?: string | null;
    filename?: string | null;
  }): Promise<MediaCacheEntry | null> => {
    if (!shouldCacheUrl(url)) return null;
    const now = Date.now();
    const index = await readIndex(indexPath);
    await pruneExpired(index, now);
    const key = hashKey(url);
    const ext = resolveExtension(filename, mediaType);
    const fileName = `${key}${ext}`;
    const destPath = join(cacheDir, fileName);

    const sourceStat = await fs.stat(filePath);
    if (Number.isFinite(maxBytes) && maxBytes > 0 && sourceStat.size > maxBytes) {
      return null;
    }
    await moveFile(filePath, destPath);
    const stat = sourceStat;
    const sha256 = verify === "hash" ? await hashFile(destPath) : null;
    const expiresAtMs = ttlMs > 0 ? now + ttlMs : null;
    const entry: MediaCacheIndexEntry = {
      url,
      fileName,
      sizeBytes: stat.size,
      sha256,
      mediaType,
      filename,
      createdAtMs: now,
      lastAccessAtMs: now,
      expiresAtMs,
    };
    index.entries[key] = entry;
    await enforceMaxBytes(index);
    const finalEntry = index.entries[key];
    await writeIndex(indexPath, index);
    return finalEntry ? normalizeEntry(cacheDir, finalEntry) : null;
  };

  return { get, put };
}
