import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { extractYouTubeTranscriptInTab } from "../apps/chrome-extension/src/entrypoints/background/youtube-transcript";

type ExecuteScriptOptions = Parameters<typeof chrome.scripting.executeScript>[0] & {
  func: (limit: number) => Promise<unknown>;
  args: [number];
};

const originalChrome = globalThis.chrome;
const originalDocument = globalThis.document;
const originalFetch = globalThis.fetch;
const originalLocation = globalThis.location;
const originalScrollX = (globalThis as { scrollX?: unknown }).scrollX;
const originalScrollY = (globalThis as { scrollY?: unknown }).scrollY;
const originalScrollTo = (globalThis as { scrollTo?: unknown }).scrollTo;
const originalPlayerResponse = (globalThis as { ytInitialPlayerResponse?: unknown })
  .ytInitialPlayerResponse;

function installDocumentStub(overrides: Partial<Document> = {}) {
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: {
      querySelector: vi.fn(() => null),
      querySelectorAll: vi.fn(() => []),
      ...overrides,
    },
  });
}

function installExecuteScriptStub() {
  Object.defineProperty(globalThis, "chrome", {
    configurable: true,
    value: {
      scripting: {
        executeScript: vi.fn(async (options: ExecuteScriptOptions) => [
          { result: await options.func(options.args[0]) },
        ]),
      },
    },
  });
}

describe("chrome youtube transcript extraction", () => {
  beforeEach(() => {
    installDocumentStub();
    installExecuteScriptStub();
    Object.defineProperty(globalThis, "location", {
      configurable: true,
      value: { href: "https://www.youtube.com/watch?v=test" },
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    Object.defineProperty(globalThis, "chrome", {
      configurable: true,
      value: originalChrome,
    });
    Object.defineProperty(globalThis, "document", {
      configurable: true,
      value: originalDocument,
    });
    Object.defineProperty(globalThis, "fetch", {
      configurable: true,
      value: originalFetch,
    });
    Object.defineProperty(globalThis, "location", {
      configurable: true,
      value: originalLocation,
    });
    Object.defineProperty(globalThis, "scrollX", {
      configurable: true,
      value: originalScrollX,
    });
    Object.defineProperty(globalThis, "scrollY", {
      configurable: true,
      value: originalScrollY,
    });
    Object.defineProperty(globalThis, "scrollTo", {
      configurable: true,
      value: originalScrollTo,
    });
    (globalThis as { ytInitialPlayerResponse?: unknown }).ytInitialPlayerResponse =
      originalPlayerResponse;
  });

  it("extracts JSON3 captions from the YouTube player response", async () => {
    (globalThis as { ytInitialPlayerResponse?: unknown }).ytInitialPlayerResponse = {
      captions: {
        playerCaptionsTracklistRenderer: {
          captionTracks: [
            {
              baseUrl: "https://example.com/caption?lang=en",
              languageCode: "en",
              name: { simpleText: "English" },
            },
          ],
        },
      },
      videoDetails: { lengthSeconds: "42", videoId: "test" },
    };
    Object.defineProperty(globalThis, "fetch", {
      configurable: true,
      value: vi.fn(async () => ({
        ok: true,
        text: async () =>
          JSON.stringify({
            events: [
              { tStartMs: 1000, segs: [{ utf8: "Hello" }, { utf8: " world" }] },
              { tStartMs: 2500, segs: [{ utf8: "Second line" }] },
            ],
          }),
      })),
    });

    const result = await extractYouTubeTranscriptInTab(7, 10_000);

    expect(result).toEqual({
      ok: true,
      url: "https://www.youtube.com/watch?v=test",
      text: "Transcript:\n[0:01] Hello world\n[0:02] Second line",
      transcriptTimedText: "[0:01] Hello world\n[0:02] Second line",
      truncated: false,
      durationSeconds: 42,
    });
  });

  it("falls back across caption formats and clamps long captions", async () => {
    (globalThis as { ytInitialPlayerResponse?: unknown }).ytInitialPlayerResponse = {
      captions: {
        playerCaptionsTracklistRenderer: {
          captionTracks: [
            {
              baseUrl: "https://example.com/caption?lang=en",
              languageCode: "en-US",
              kind: "asr",
              name: { runs: [{ text: "English " }, { text: "auto-generated" }] },
            },
          ],
        },
      },
      videoDetails: { lengthSeconds: "bad", videoId: "test" },
    };
    Object.defineProperty(globalThis, "fetch", {
      configurable: true,
      value: vi
        .fn()
        .mockResolvedValueOnce({ ok: false, text: async () => "" })
        .mockResolvedValueOnce({
          ok: true,
          text: async () => "WEBVTT\n\n00:00:01.000 --> 00:00:03.000\nA very long caption line",
        }),
    });

    const result = await extractYouTubeTranscriptInTab(7, 36);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.text).toContain("Transcript:");
      expect(result.text).toContain("[TRUNCATED]");
      expect(result.url).toBe("https://www.youtube.com/watch?v=test");
      expect(result.transcriptTimedText).toBe("[0:01] A very long caption line");
      expect(result.truncated).toBe(true);
      expect(result.durationSeconds).toBeNull();
    }
  });

  it("returns transcript panel text when caption track metadata is unavailable", async () => {
    (globalThis as { ytInitialPlayerResponse?: unknown }).ytInitialPlayerResponse = {
      captions: {
        playerCaptionsTracklistRenderer: {
          captionTracks: [],
        },
      },
      videoDetails: { videoId: "test" },
    };
    const segment = {
      querySelector: vi.fn((selector: string) => ({
        textContent: selector.includes("timestamp") ? "1:23" : "Panel transcript text",
      })),
    };
    const button = { click: vi.fn(), textContent: "Show transcript" };
    const scrollTo = vi.fn();
    Object.defineProperty(globalThis, "scrollX", { configurable: true, value: 13 });
    Object.defineProperty(globalThis, "scrollY", { configurable: true, value: 37 });
    Object.defineProperty(globalThis, "scrollTo", { configurable: true, value: scrollTo });
    installDocumentStub({
      querySelector: vi.fn((selector: string) =>
        selector === "ytd-watch-metadata"
          ? ({ scrollIntoView: vi.fn() } as unknown as Element)
          : selector.includes("transcript-section")
            ? button
            : null,
      ) as unknown as Document["querySelector"],
      querySelectorAll: vi.fn((selector: string) =>
        selector.includes("transcript-segment") ? [segment] : [button],
      ) as unknown as Document["querySelectorAll"],
    });

    const result = await extractYouTubeTranscriptInTab(7, 10_000);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.transcriptTimedText).toBe("[1:23] Panel transcript text");
      expect(result.url).toBe("https://www.youtube.com/watch?v=test");
      expect(result.durationSeconds).toBeNull();
    }
    expect(scrollTo).toHaveBeenCalledWith(13, 37);
  });

  it("does not reuse already-open transcript panel rows without current transcript control", async () => {
    (globalThis as { ytInitialPlayerResponse?: unknown }).ytInitialPlayerResponse = {
      captions: {
        playerCaptionsTracklistRenderer: {
          captionTracks: [],
        },
      },
      videoDetails: { videoId: "test" },
    };
    const segment = {
      querySelector: vi.fn((selector: string) => ({
        textContent: selector.includes("timestamp") ? "0:10" : "Stale transcript text",
      })),
    };
    installDocumentStub({
      querySelector: vi.fn((selector: string) =>
        selector === "ytd-watch-metadata"
          ? ({ scrollIntoView: vi.fn() } as unknown as Element)
          : null,
      ) as unknown as Document["querySelector"],
      querySelectorAll: vi.fn((selector: string) =>
        selector.includes("transcript-segment") ? [segment] : [],
      ) as unknown as Document["querySelectorAll"],
    });

    const result = await extractYouTubeTranscriptInTab(7, 10_000);

    expect(result).toEqual({ ok: false, error: "No YouTube caption transcript found." });
  });

  it("reports wrapper failures", async () => {
    Object.defineProperty(globalThis, "chrome", {
      configurable: true,
      value: {
        scripting: {
          executeScript: vi.fn(async () => {
            throw new Error("cannot inject");
          }),
        },
      },
    });

    await expect(extractYouTubeTranscriptInTab(7, 1000)).resolves.toEqual({
      ok: false,
      error: "cannot inject",
    });
  });

  it("prefers current flexy captions over stale bootstrap player data", async () => {
    (globalThis as { ytInitialPlayerResponse?: unknown }).ytInitialPlayerResponse = {
      captions: {
        playerCaptionsTracklistRenderer: {
          captionTracks: [
            {
              baseUrl: "https://example.com/stale",
              languageCode: "en",
              name: { simpleText: "English" },
            },
          ],
        },
      },
      videoDetails: { lengthSeconds: "10", videoId: "old-video" },
    };
    installDocumentStub({
      querySelector: vi.fn((selector: string) =>
        selector === "ytd-watch-flexy"
          ? ({
              playerResponse: {
                captions: {
                  playerCaptionsTracklistRenderer: {
                    captionTracks: [
                      {
                        baseUrl: "https://example.com/current",
                        languageCode: "en",
                        name: { simpleText: "English" },
                      },
                    ],
                  },
                },
                videoDetails: { lengthSeconds: "42", videoId: "test" },
              },
            } as unknown as Element)
          : null,
      ) as unknown as Document["querySelector"],
    });
    Object.defineProperty(globalThis, "fetch", {
      configurable: true,
      value: vi.fn(async (url: string) => ({
        ok: true,
        text: async () =>
          JSON.stringify({
            events: [
              { tStartMs: 1000, segs: [{ utf8: url.includes("current") ? "Current" : "Stale" }] },
            ],
          }),
      })),
    });

    const result = await extractYouTubeTranscriptInTab(7, 10_000);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.transcriptTimedText).toBe("[0:01] Current");
      expect(result.durationSeconds).toBe(42);
    }
    expect(fetch).toHaveBeenCalledWith(expect.stringContaining("current"), expect.anything());
  });

  it("skips incomplete flexy playerData when playerResponse has current captions", async () => {
    installDocumentStub({
      querySelector: vi.fn((selector: string) =>
        selector === "ytd-watch-flexy"
          ? ({
              playerData: {},
              playerResponse: {
                captions: {
                  playerCaptionsTracklistRenderer: {
                    captionTracks: [
                      {
                        baseUrl: "https://example.com/current",
                        languageCode: "en",
                        name: { simpleText: "English" },
                      },
                    ],
                  },
                },
                videoDetails: { lengthSeconds: "42", videoId: "test" },
              },
            } as unknown as Element)
          : null,
      ) as unknown as Document["querySelector"],
    });
    Object.defineProperty(globalThis, "fetch", {
      configurable: true,
      value: vi.fn(async () => ({
        ok: true,
        text: async () =>
          JSON.stringify({
            events: [{ tStartMs: 1000, segs: [{ utf8: "Current response" }] }],
          }),
      })),
    });

    const result = await extractYouTubeTranscriptInTab(7, 10_000);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.transcriptTimedText).toBe("[0:01] Current response");
    }
    expect(fetch).toHaveBeenCalledWith(expect.stringContaining("current"), expect.anything());
  });
});
