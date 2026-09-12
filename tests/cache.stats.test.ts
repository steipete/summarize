import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readCacheStats } from "../src/cache.js";

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "summarize-cache-stats-"));
});
afterEach(() => {
  vi.restoreAllMocks();
  rmSync(root, { recursive: true, force: true });
});

describe("cache statistics connection ownership", () => {
  it("closes the database after reading its counts", async () => {
    const path = join(root, "cache.sqlite");
    const db = new DatabaseSync(path);
    db.exec("CREATE TABLE cache_entries (kind TEXT)");
    db.exec("INSERT INTO cache_entries VALUES ('summary'), ('extract')");
    db.close();
    const close = vi.spyOn(DatabaseSync.prototype, "close");

    const stats = await readCacheStats(path);

    expect(stats).toMatchObject({ path, totalEntries: 2, counts: { summary: 1, extract: 1 } });
    expect(stats?.sizeBytes).toBeGreaterThan(0);
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("ignores cache kinds that match inherited object properties", async () => {
    const path = join(root, "cache.sqlite");
    const db = new DatabaseSync(path);
    db.exec("CREATE TABLE cache_entries (kind TEXT)");
    db.exec("INSERT INTO cache_entries VALUES ('constructor')");
    db.close();

    const stats = await readCacheStats(path);

    expect(stats?.totalEntries).toBe(1);
    expect(Object.hasOwn(stats?.counts ?? {}, "constructor")).toBe(false);
  });

  it("closes the database when a statistics query fails", async () => {
    const path = join(root, "cache.sqlite");
    new DatabaseSync(path).close();
    const close = vi.spyOn(DatabaseSync.prototype, "close");

    await expect(readCacheStats(path)).rejects.toThrow("no such table: cache_entries");
    expect(close).toHaveBeenCalledTimes(1);
  });
});
