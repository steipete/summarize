import { describe, expect, it, vi } from "vitest";
import type { CacheState, CacheStore } from "../src/cache.js";
import {
  resolveTranscriptDiarizationCacheReadScopes,
  resolveTranscriptDiarizationCacheWriteScope,
  scopeTranscriptCacheForDiarization,
} from "../src/shared/transcript-diarization-cache-scope.js";

function makeCacheState() {
  const get = vi.fn(async () => null);
  const set = vi.fn(async () => {});
  const store: CacheStore = {
    getText: () => null,
    getJson: () => null,
    setText: () => {},
    setJson: () => {},
    clear: () => {},
    close: () => {},
    transcriptCache: { get, set },
  };
  const cache: CacheState = {
    mode: "default",
    store,
    ttlMs: 0,
    maxBytes: 0,
    path: null,
  };
  return { cache, get, set };
}

describe("transcript diarization cache scope", () => {
  it("resolves read scopes for auto and explicit provider requests", () => {
    expect(resolveTranscriptDiarizationCacheReadScopes(null)).toBeNull();
    expect(resolveTranscriptDiarizationCacheReadScopes("auto")).toEqual([
      "elevenlabs",
      "openai",
      "auto",
    ]);
    expect(resolveTranscriptDiarizationCacheReadScopes("openai")).toEqual(["openai", "auto"]);
    expect(resolveTranscriptDiarizationCacheReadScopes("elevenlabs")).toEqual([
      "elevenlabs",
      "auto",
    ]);
  });

  it("writes auto requests into the actual provider scope and keeps explicit providers separate", async () => {
    expect(
      resolveTranscriptDiarizationCacheWriteScope({
        preference: "auto",
        metadata: { diarizationProvider: "openai", speakerLabels: true },
      }),
    ).toBe("openai");
    expect(
      resolveTranscriptDiarizationCacheWriteScope({
        preference: "auto",
        metadata: { speakerLabels: true },
      }),
    ).toBe("auto");
    expect(
      resolveTranscriptDiarizationCacheWriteScope({
        preference: "elevenlabs",
        metadata: { diarizationProvider: "openai", speakerLabels: true },
      }),
    ).toBe("elevenlabs");

    const { cache, set } = makeCacheState();
    const scopedAuto = scopeTranscriptCacheForDiarization(cache, "auto");
    await scopedAuto.store?.transcriptCache.set({
      url: "https://example.com/video",
      service: "youtube",
      resourceKey: "abc123",
      ttlMs: 1000,
      content: "Speaker A: hello",
      source: "yt-dlp",
      metadata: { diarizationProvider: "openai", speakerLabels: true },
    });
    const scopedElevenLabs = scopeTranscriptCacheForDiarization(cache, "elevenlabs");
    await scopedElevenLabs.store?.transcriptCache.set({
      url: "https://example.com/video",
      service: "youtube",
      resourceKey: "abc123",
      ttlMs: 1000,
      content: "Speaker 1: hi",
      source: "yt-dlp",
      metadata: { diarizationProvider: "elevenlabs", speakerLabels: true },
    });

    expect(set).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        url: "summarize-diarize:openai:https://example.com/video",
      }),
    );
    expect(set).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        url: "summarize-diarize:elevenlabs:https://example.com/video",
      }),
    );
  });

  it("lets auto mode reuse provider-scoped cache entries in provider order", async () => {
    const { cache, get } = makeCacheState();
    get.mockImplementation(async ({ url }) => {
      if (url === "summarize-diarize:openai:https://example.com/video") {
        return {
          content: "Speaker A: cached openai",
          source: "yt-dlp",
          expired: false,
          metadata: { diarizationProvider: "openai", speakerLabels: true },
        };
      }
      return null;
    });

    const scoped = scopeTranscriptCacheForDiarization(cache, "auto");
    const hit = await scoped.store?.transcriptCache.get({ url: "https://example.com/video" });

    expect(hit?.content).toBe("Speaker A: cached openai");
    expect(get).toHaveBeenNthCalledWith(1, {
      url: "summarize-diarize:elevenlabs:https://example.com/video",
    });
    expect(get).toHaveBeenNthCalledWith(2, {
      url: "summarize-diarize:openai:https://example.com/video",
    });
  });

  it("falls back from incompatible explicit-provider cache entries to a compatible legacy auto entry", async () => {
    const { cache, get } = makeCacheState();
    get.mockImplementation(async ({ url }) => {
      if (url === "summarize-diarize:openai:https://example.com/video") {
        return {
          content: "Speaker 1: cached elevenlabs",
          source: "yt-dlp",
          expired: false,
          metadata: { diarizationProvider: "elevenlabs", speakerLabels: true },
        };
      }
      if (url === "summarize-diarize:auto:https://example.com/video") {
        return {
          content: "Speaker A: cached openai",
          source: "yt-dlp",
          expired: false,
          metadata: { diarizationProvider: "openai", speakerLabels: true },
        };
      }
      return null;
    });

    const scoped = scopeTranscriptCacheForDiarization(cache, "openai");
    const hit = await scoped.store?.transcriptCache.get({ url: "https://example.com/video" });

    expect(hit?.content).toBe("Speaker A: cached openai");
    expect(get).toHaveBeenNthCalledWith(1, {
      url: "summarize-diarize:openai:https://example.com/video",
    });
    expect(get).toHaveBeenNthCalledWith(2, {
      url: "summarize-diarize:auto:https://example.com/video",
    });
  });
});
