import { describe, expect, it, vi } from "vitest";
import type { BrowserYoutubeMediaContext } from "../apps/chrome-extension/src/entrypoints/background/youtube-media";
import { downloadYoutubeAudio } from "../apps/chrome-extension/src/entrypoints/offscreen/youtube-audio";

function contextWithoutLength(): BrowserYoutubeMediaContext {
  return {
    apiKey: "api-key",
    directAudio: {
      contentLength: null,
      mimeType: "audio/mp4",
      resolver: "player",
      url: "https://player.example/audio.m4a",
    },
    durationSeconds: 60,
    sabr: null,
    title: "Test video",
    url: "https://www.youtube.com/watch?v=test",
    videoId: "test",
    visitorData: null,
  } as BrowserYoutubeMediaContext;
}

describe("YouTube direct audio fetch deadline", () => {
  it("aborts a download that omits content length", async () => {
    const fetchMock = vi.fn((_url: string, init?: RequestInit) => {
      return new Promise<Response>((_resolve, reject) => {
        const abort = () => reject(Object.assign(new Error("aborted"), { name: "TimeoutError" }));
        if (init?.signal?.aborted) {
          abort();
          return;
        }
        init?.signal?.addEventListener("abort", abort, { once: true });
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      downloadYoutubeAudio({
        context: contextWithoutLength(),
        capturedSabr: null,
        fetchTimeoutMs: 20,
      }),
    ).rejects.toThrow();
    expect(fetchMock).toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it("cancels an oversized body before throwing", async () => {
    const cancel = vi.fn(async () => {});
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        body: {
          cancel,
          getReader: () => {
            throw new Error("body should not be read");
          },
        },
        headers: { get: (name: string) => (name === "content-length" ? "999999999999" : null) },
      })),
    );

    await expect(
      downloadYoutubeAudio({
        context: contextWithoutLength(),
        capturedSabr: null,
      }),
    ).rejects.toThrow("too large");
    expect(cancel).toHaveBeenCalled();
    vi.unstubAllGlobals();
  });
});
