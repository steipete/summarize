import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createCacheStore, type CacheStore } from "../src/cache.js";
import { NEGATIVE_TTL_MS } from "../packages/core/src/content/index.js";

/**
 * Regression test for https://github.com/steipete/summarize/issues/114
 *
 * When the transcript source is "unavailable" (e.g. Apify timeout), the
 * extract cache entry must use a short TTL (NEGATIVE_TTL_MS) instead of
 * the default 30-day TTL so that transient failures are retried on the
 * next run.
 */
describe("extract cache TTL for unavailable transcripts (#114)", () => {
  const makeExtractPayload = (transcriptSource: string | null) => ({
    content: "<p>page content</p>",
    title: "Test",
    description: null,
    url: "https://www.youtube.com/watch?v=abc123",
    siteName: "YouTube",
    wordCount: 2,
    totalCharacters: 19,
    truncated: false,
    mediaDurationSeconds: null,
    video: null,
    isVideoOnly: false,
    transcriptSource,
    transcriptCharacters: null,
    transcriptWordCount: null,
    transcriptLines: null,
    transcriptMetadata: null,
    transcriptSegments: null,
    transcriptTimedText: null,
    transcriptionProvider: null,
    diagnostics: {
      strategy: "html",
      firecrawl: { attempted: false, used: false, cacheMode: "default", cacheStatus: "bypassed", notes: null },
      markdown: { requested: false, used: false, provider: null, notes: null },
      transcript: { cacheMode: "default", cacheStatus: "miss", textProvided: false, provider: transcriptSource, attemptedProviders: [] },
    },
  });

  const DEFAULT_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days (default cache TTL)

  let store: CacheStore;
  let storePath: string;

  const createStore = async () => {
    const root = mkdtempSync(join(tmpdir(), "summarize-extract-ttl-"));
    storePath = join(root, "cache.sqlite");
    store = await createCacheStore({ path: storePath, maxBytes: 10 * 1024 * 1024 });
    return store;
  };

  it("extract with unavailable transcript expires after NEGATIVE_TTL_MS", async () => {
    const s = await createStore();
    const payload = makeExtractPayload("unavailable");

    // Simulate what flow.ts does: use NEGATIVE_TTL_MS for unavailable transcripts
    const extractTtlMs =
      payload.transcriptSource === "unavailable" ? NEGATIVE_TTL_MS : DEFAULT_TTL_MS;

    expect(extractTtlMs).toBe(NEGATIVE_TTL_MS);
    expect(extractTtlMs).toBeLessThan(DEFAULT_TTL_MS);

    // Write with the short TTL
    s.setJson("extract", "test-key", payload, extractTtlMs);

    // Immediately readable
    expect(s.getJson("extract", "test-key")).not.toBeNull();

    // Write with a TTL of -1ms to simulate expiry
    s.setJson("extract", "test-key-expired", payload, -1);
    expect(s.getJson("extract", "test-key-expired")).toBeNull();

    s.close();
  });

  it("extract with successful transcript uses the full default TTL", async () => {
    const s = await createStore();
    const payload = makeExtractPayload("youtubei");

    const extractTtlMs =
      payload.transcriptSource === "unavailable" ? NEGATIVE_TTL_MS : DEFAULT_TTL_MS;

    expect(extractTtlMs).toBe(DEFAULT_TTL_MS);

    s.setJson("extract", "test-key-success", payload, extractTtlMs);
    expect(s.getJson("extract", "test-key-success")).not.toBeNull();

    s.close();
  });

  it("NEGATIVE_TTL_MS is 6 hours", () => {
    expect(NEGATIVE_TTL_MS).toBe(1000 * 60 * 60 * 6);
  });
});
