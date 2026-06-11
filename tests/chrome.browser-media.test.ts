import { afterEach, describe, expect, it, vi } from "vitest";
import {
  extractBrowserMediaFrames,
  extractBrowserMediaFramesInDocument,
  isBrowserMediaUrl,
} from "../apps/chrome-extension/src/entrypoints/background/browser-media";
import { BrowserPcmAccumulator } from "../apps/chrome-extension/src/entrypoints/background/browser-media-audio";

const originalChrome = globalThis.chrome;

describe("chrome browser media decoding", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    Object.defineProperty(globalThis, "chrome", {
      configurable: true,
      value: originalChrome,
    });
  });

  it("accepts only fetchable HTTP media URLs", async () => {
    expect(isBrowserMediaUrl("https://example.com/video.mp4")).toBe(true);
    expect(isBrowserMediaUrl("http://example.com/video.mp4")).toBe(true);
    expect(isBrowserMediaUrl("blob:https://example.com/id")).toBe(false);
    expect(isBrowserMediaUrl("not a URL")).toBe(false);

    const fetchImpl = vi.fn();
    await expect(
      extractBrowserMediaFramesInDocument({
        mediaUrl: "https://example.com/video.mp4",
        timestamps: [],
        fetchImpl,
      }),
    ).resolves.toEqual([]);
    expect(fetchImpl).not.toHaveBeenCalled();
    await expect(
      extractBrowserMediaFramesInDocument({
        mediaUrl: "file:///tmp/video.mp4",
        timestamps: [1],
        fetchImpl,
      }),
    ).rejects.toThrow("fetchable HTTP media URL");
  });

  it("creates the offscreen document and requests MediaBunny frames", async () => {
    const onStatus = vi.fn();
    const createDocument = vi.fn(async () => {});
    const sendMessage = vi.fn(async () => ({
      ok: true,
      frames: [{ imageUrl: "data:image/jpeg;base64,AQID", timestamp: 1 }],
    }));
    Object.defineProperty(globalThis, "chrome", {
      configurable: true,
      value: {
        offscreen: {
          createDocument,
          hasDocument: vi.fn(async () => false),
          Reason: { WORKERS: "WORKERS" },
        },
        runtime: { sendMessage },
      },
    });

    await expect(
      extractBrowserMediaFrames({
        mediaUrl: "https://example.com/video.mp4",
        timestamps: [1],
        onStatus,
      }),
    ).resolves.toHaveLength(1);
    expect(onStatus).toHaveBeenCalledWith("Preparing browser media decoder...");
    expect(createDocument).toHaveBeenCalledWith(
      expect.objectContaining({ url: "offscreen.html", reasons: ["WORKERS"] }),
    );
    expect(sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ target: "offscreen", type: "mediabunny:frames" }),
    );
  });

  it("reports unavailable and failed offscreen runtimes", async () => {
    Object.defineProperty(globalThis, "chrome", {
      configurable: true,
      value: { offscreen: {}, runtime: { sendMessage: vi.fn() } },
    });
    await expect(
      extractBrowserMediaFrames({
        mediaUrl: "https://example.com/video.mp4",
        timestamps: [1],
      }),
    ).rejects.toThrow("offscreen documents are unavailable");

    Object.defineProperty(globalThis, "chrome", {
      configurable: true,
      value: {
        offscreen: {
          createDocument: vi.fn(),
          hasDocument: vi.fn(async () => true),
        },
        runtime: { sendMessage: vi.fn(async () => ({ ok: false, error: "decoder failed" })) },
      },
    });
    await expect(
      extractBrowserMediaFrames({
        mediaUrl: "https://example.com/video.mp4",
        timestamps: [1],
      }),
    ).rejects.toThrow("decoder failed");
  });

  it("rejects failed and oversized media downloads before decoding", async () => {
    await expect(
      extractBrowserMediaFramesInDocument({
        mediaUrl: "https://example.com/video.mp4",
        timestamps: [1],
        fetchImpl: vi.fn(
          async () => new Response("missing", { status: 404, statusText: "Not Found" }),
        ),
      }),
    ).rejects.toThrow("404 Not Found");

    await expect(
      extractBrowserMediaFramesInDocument({
        mediaUrl: "https://example.com/video.mp4",
        timestamps: [1],
        fetchImpl: vi.fn(
          async () =>
            new Response("video", {
              headers: { "content-length": String(128 * 1024 * 1024 + 1) },
            }),
        ),
      }),
    ).rejects.toThrow("too large");
  });

  it("incrementally downmixes and resamples timestamped PCM", () => {
    const output = new BrowserPcmAccumulator(0.0005, 8_000, 1024);
    output.add({
      duration: 0.0005,
      interleaved: new Float32Array([1, -1, 0.5, 0.5, -0.5, -0.5, 0, 1]),
      numberOfChannels: 2,
      numberOfFrames: 4,
      sampleRate: 8_000,
      timestamp: 0,
    });
    expect(Array.from(output.finish())).toEqual([0, 0.5, -0.5, 0.5]);
  });

  it("trims negative timestamps and bounds decoded PCM growth", () => {
    const output = new BrowserPcmAccumulator(0.00025, 8_000, 32);
    output.add({
      duration: 0.0005,
      interleaved: new Float32Array([1, 2, 3, 4]),
      numberOfChannels: 1,
      numberOfFrames: 4,
      sampleRate: 8_000,
      timestamp: -0.00025,
    });
    expect(Array.from(output.finish())).toEqual([3, 4]);
    expect(
      () => new BrowserPcmAccumulator(1, 8_000, Float32Array.BYTES_PER_ELEMENT * 7_999),
    ).toThrow("too long");
  });
});
