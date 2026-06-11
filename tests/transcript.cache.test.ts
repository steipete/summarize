import { describe, expect, it, vi } from "vitest";
import type { TranscriptCache } from "../packages/core/src/content/cache/types.js";
import {
  readTranscriptCache,
  writeTranscriptCache,
} from "../packages/core/src/content/transcript/cache.js";
import { resolveTranscriptForLink } from "../packages/core/src/content/transcript/index.js";

describe("transcript cache helpers", () => {
  it("reads a cached transcript hit", async () => {
    const transcriptCache: TranscriptCache = {
      get: vi.fn(async () => ({
        content: "cached transcript",
        source: "captionTracks",
        expired: false,
        metadata: null,
      })),
      set: vi.fn(async () => {}),
    };

    const outcome = await readTranscriptCache({
      url: "https://www.youtube.com/watch?v=abcdefghijk",
      cacheMode: "default",
      transcriptCache,
    });

    expect(outcome.resolution?.text).toBe("cached transcript");
    expect(outcome.resolution?.source).toBe("captionTracks");
    expect(outcome.diagnostics.cacheStatus).toBe("hit");
    expect(vi.mocked(transcriptCache.get)).toHaveBeenCalledTimes(1);
  });

  it("returns cache miss when timestamps requested but cached segments missing", async () => {
    const transcriptCache: TranscriptCache = {
      get: vi.fn(async () => ({
        content: "cached transcript",
        source: "captionTracks",
        expired: false,
        metadata: { timestamps: true },
      })),
      set: vi.fn(async () => {}),
    };

    const outcome = await readTranscriptCache({
      url: "https://example.com",
      cacheMode: "default",
      transcriptCache,
      transcriptTimestamps: true,
    });

    expect(outcome.resolution).toBeNull();
    expect(outcome.diagnostics.notes).toContain("missing timestamps");
  });

  it("keeps cached transcript when timestamps are explicitly unavailable", async () => {
    const transcriptCache: TranscriptCache = {
      get: vi.fn(async () => ({
        content: "cached transcript",
        source: "captionTracks",
        expired: false,
        metadata: { timestamps: false },
      })),
      set: vi.fn(async () => {}),
    };

    const outcome = await readTranscriptCache({
      url: "https://example.com",
      cacheMode: "default",
      transcriptCache,
      transcriptTimestamps: true,
    });

    expect(outcome.resolution?.text).toBe("cached transcript");
    expect(outcome.diagnostics.notes).toContain("timestamps unavailable");
  });

  it("returns cached segments when timestamps are requested", async () => {
    const transcriptCache: TranscriptCache = {
      get: vi.fn(async () => ({
        content: "cached transcript",
        source: "captionTracks",
        expired: false,
        metadata: {
          segments: [
            { startMs: 1000, endMs: 2000, text: "Hello" },
            { startMs: 2000, endMs: null, text: "world" },
          ],
        },
      })),
      set: vi.fn(async () => {}),
    };

    const outcome = await readTranscriptCache({
      url: "https://example.com",
      cacheMode: "default",
      transcriptCache,
      transcriptTimestamps: true,
    });

    expect(outcome.resolution?.segments).toEqual([
      { startMs: 1000, endMs: 2000, text: "Hello" },
      { startMs: 2000, endMs: null, text: "world" },
    ]);
  });

  it("does not enable timestamps from cached diarization segments", async () => {
    const transcriptCache: TranscriptCache = {
      get: vi.fn(async () => ({
        content: "Speaker 1: Hello",
        source: "yt-dlp",
        expired: false,
        metadata: {
          diarizationProvider: "elevenlabs",
          speakerLabels: true,
          segments: [{ startMs: 1000, endMs: 2000, text: "Hello", speaker: "Speaker 1" }],
        },
      })),
      set: vi.fn(async () => {}),
    };

    const outcome = await readTranscriptCache({
      url: "https://example.com",
      cacheMode: "default",
      transcriptCache,
      transcriptDiarization: "auto",
    });

    expect(outcome.resolution?.text).toBe("Speaker 1: Hello");
    expect(outcome.resolution?.segments).toBeNull();
  });

  it("does not reuse cached speaker-labelled transcripts when diarization was not requested", async () => {
    const transcriptCache: TranscriptCache = {
      get: vi.fn(async () => ({
        content: "Speaker A: Hello",
        source: "yt-dlp",
        expired: false,
        metadata: {
          diarizationProvider: "openai",
          speakerLabels: true,
          segments: [{ startMs: 1000, endMs: 2000, text: "Hello", speaker: "Speaker A" }],
        },
      })),
      set: vi.fn(async () => {}),
    };

    const outcome = await readTranscriptCache({
      url: "https://example.com",
      cacheMode: "default",
      transcriptCache,
    });

    expect(outcome.resolution).toBeNull();
    expect(outcome.diagnostics.notes).toContain("speaker labels");
  });

  it("skips cache reads when bypass requested", async () => {
    const transcriptCache: TranscriptCache = {
      get: vi.fn(async () => ({
        content: "cached transcript",
        source: "captionTracks",
        expired: true,
        metadata: null,
      })),
      set: vi.fn(async () => {}),
    };

    const outcome = await readTranscriptCache({
      url: "https://example.com",
      cacheMode: "bypass",
      transcriptCache,
    });

    expect(outcome.resolution).toBeNull();
    expect(outcome.diagnostics.cacheStatus).toBe("bypassed");
  });

  it("writes negative cache entries with shorter TTL", async () => {
    const transcriptCache: TranscriptCache = {
      get: vi.fn(async () => null),
      set: vi.fn(async () => {}),
    };

    await writeTranscriptCache({
      url: "https://example.com",
      service: "generic",
      resourceKey: null,
      result: { text: null, source: "unavailable", metadata: { reason: "nope" } },
      transcriptCache,
    });

    expect(vi.mocked(transcriptCache.set)).toHaveBeenCalledTimes(1);
    const args = vi.mocked(transcriptCache.set).mock.calls[0]?.[0];
    expect(args?.ttlMs).toBeGreaterThan(0);
    expect(args?.ttlMs).toBeLessThan(1000 * 60 * 60 * 24);
    expect(args?.source).toBe("unavailable");
  });
});

describe("transcript cache integration", () => {
  it("falls back to cached transcript content when provider misses", async () => {
    const transcriptCache: TranscriptCache = {
      get: vi.fn(async () => ({
        content: "cached transcript",
        source: "captionTracks",
        expired: true,
        metadata: null,
      })),
      set: vi.fn(async () => {}),
    };

    const fetchMock = vi.fn(async () => new Response("nope", { status: 500 }));

    const result = await resolveTranscriptForLink(
      "https://www.youtube.com/watch?v=abcdefghijk",
      "<html></html>",
      {
        fetch: fetchMock as unknown as typeof fetch,
        apifyApiToken: null,
        ytDlpPath: null,
        groqApiKey: null,
        falApiKey: null,
        openaiApiKey: null,
        scrapeWithFirecrawl: null,
        convertHtmlToMarkdown: null,
        transcriptCache,
        readTweetWithBird: null,
      },
      { youtubeTranscriptMode: "web", cacheMode: "default" },
    );

    expect(result.text).toBe("cached transcript");
    expect(result.source).toBe("captionTracks");
    expect(result.diagnostics?.cacheStatus).toBe("fallback");
    expect(result.diagnostics?.notes).toContain("Falling back");
  });

  it("does not fall back to cached speaker-labelled content when diarization was not requested", async () => {
    const transcriptCache: TranscriptCache = {
      get: vi.fn(async () => ({
        content: "Speaker A: cached transcript",
        source: "yt-dlp",
        expired: true,
        metadata: {
          diarizationProvider: "openai",
          speakerLabels: true,
          segments: [
            { startMs: 1000, endMs: 2000, text: "cached transcript", speaker: "Speaker A" },
          ],
        },
      })),
      set: vi.fn(async () => {}),
    };

    const fetchMock = vi.fn(async () => new Response("nope", { status: 500 }));

    const result = await resolveTranscriptForLink(
      "https://www.youtube.com/watch?v=abcdefghijk",
      "<html></html>",
      {
        fetch: fetchMock as unknown as typeof fetch,
        apifyApiToken: null,
        ytDlpPath: null,
        groqApiKey: null,
        falApiKey: null,
        openaiApiKey: null,
        scrapeWithFirecrawl: null,
        convertHtmlToMarkdown: null,
        transcriptCache,
        readTweetWithBird: null,
      },
      { youtubeTranscriptMode: "web", cacheMode: "default" },
    );

    expect(result.text).toBeNull();
    expect(result.diagnostics?.cacheStatus).toBe("expired");
    expect(result.diagnostics?.notes).not.toContain("Falling back");
  });

  it("does not fall back to a cache entry incompatible with requested diarization", async () => {
    const transcriptCache: TranscriptCache = {
      get: vi.fn(async () => ({
        content: "plain cached transcript",
        source: "html",
        expired: true,
        metadata: null,
      })),
      set: vi.fn(async () => {}),
    };

    const result = await resolveTranscriptForLink(
      "https://example.com/article",
      "<html></html>",
      {
        fetch,
        apifyApiToken: null,
        ytDlpPath: null,
        groqApiKey: null,
        falApiKey: null,
        openaiApiKey: null,
        scrapeWithFirecrawl: null,
        convertHtmlToMarkdown: null,
        transcriptCache,
        readTweetWithBird: null,
      },
      { cacheMode: "default", transcriptDiarization: "openai" },
    );

    expect(result.text).toBeNull();
    expect(result.diagnostics?.cacheStatus).toBe("expired");
  });
});
