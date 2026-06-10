import { describe, expect, it } from "vitest";
import {
  buildPortableCacheRow,
  isPortableCacheRowExpired,
  parseCacheJson,
  summarizePortableCacheRows,
} from "../src/shared/cache-store.js";

describe("shared cache store primitives", () => {
  it("builds rows with ttl, size, and stats usable by cache backends", () => {
    const row = buildPortableCacheRow({
      kind: "summary",
      key: "key",
      value: "hello",
      ttlMs: 1000,
      now: 10,
    });

    expect(row.expiresAt).toBe(1010);
    expect(row.sizeBytes).toBe(5);
    expect(isPortableCacheRowExpired(row, 1009)).toBe(false);
    expect(isPortableCacheRowExpired(row, 1010)).toBe(true);

    const stats = summarizePortableCacheRows([row], "memory");
    expect(stats).toMatchObject({
      path: "memory",
      sizeBytes: 5,
      totalEntries: 1,
      counts: { summary: 1 },
    });
  });

  it("parses cached json safely", () => {
    expect(parseCacheJson<{ ok: boolean }>('{"ok":true}')).toEqual({ ok: true });
    expect(parseCacheJson("{")).toBeNull();
    expect(parseCacheJson(null)).toBeNull();
  });
});
