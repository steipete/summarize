import { afterEach, describe, expect, it, vi } from "vitest";
import {
  browserMediaCanvasToDataUrl,
  extractBrowserMediaFrames,
  extractBrowserMediaFramesInDocument,
  fetchBrowserMediaWithLimit,
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

  it("preserves compliant ranged responses regardless of total media size", async () => {
    const response = new Response(new Uint8Array([1, 2, 3]), {
      status: 206,
      headers: {
        "content-length": "3",
        "content-range": "bytes 0-2/999999999",
      },
    });
    const fetchImpl = vi.fn(async () => response);

    await expect(
      fetchBrowserMediaWithLimit(
        fetchImpl as unknown as typeof fetch,
        "https://example.com/video.mp4",
        { headers: { Range: "bytes=0-" } },
        2,
      ),
    ).resolves.toBe(response);
  });

  it("rejects oversized full responses before MediaBunny sees them", async () => {
    const cancel = vi.fn(async () => {});
    const response = {
      body: { cancel },
      headers: new Headers({ "content-length": "4" }),
      status: 200,
    } as unknown as Response;
    const fetchImpl = vi.fn(async () => response);

    await expect(
      fetchBrowserMediaWithLimit(
        fetchImpl as unknown as typeof fetch,
        "https://example.com/video.mp4",
        undefined,
        3,
      ),
    ).rejects.toThrow("without partial content");
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("bounds streamed full responses with missing or incorrect content lengths", async () => {
    const response = new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array([1, 2]));
          controller.enqueue(new Uint8Array([3, 4]));
          controller.close();
        },
      }),
      {
        status: 200,
        headers: { "content-length": "2" },
      },
    );
    const fetchImpl = vi.fn(async () => response);
    const guarded = await fetchBrowserMediaWithLimit(
      fetchImpl as unknown as typeof fetch,
      "https://example.com/video.mp4",
      { headers: { Range: "bytes=0-" } },
      3,
    );

    await expect(guarded.arrayBuffer()).rejects.toThrow("streamed more than 3 bytes");
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

  it("encodes offscreen-document HTML canvases without the throttled blob callback", async () => {
    const toDataURL = vi.fn(() => "data:image/jpeg;base64,AQID");
    const canvas = { toDataURL } as unknown as HTMLCanvasElement;

    await expect(
      browserMediaCanvasToDataUrl({
        canvas,
        duration: 1,
        timestamp: 0,
      }),
    ).resolves.toBe("data:image/jpeg;base64,AQID");
    expect(toDataURL).toHaveBeenCalledWith("image/jpeg", 0.82);
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

  it("writes later media chunks relative to their own start time", () => {
    const output = new BrowserPcmAccumulator(0.0005, 8_000, 1024, 900);
    output.add({
      duration: 0.0005,
      interleaved: new Float32Array([1, 2, 3, 4]),
      numberOfChannels: 1,
      numberOfFrames: 4,
      sampleRate: 8_000,
      timestamp: 900,
    });
    expect(Array.from(output.finish())).toEqual([1, 2, 3, 4]);
  });
});
