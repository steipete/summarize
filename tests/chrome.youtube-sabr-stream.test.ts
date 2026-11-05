import { afterEach, describe, expect, it, vi } from "vitest";
import type { BrowserYoutubeMediaContext } from "../apps/chrome-extension/src/entrypoints/background/youtube-media";

const mocks = vi.hoisted(() => ({ create: vi.fn(), start: vi.fn(), abort: vi.fn() }));
vi.mock(
  "../apps/chrome-extension/node_modules/googlevideo/dist/src/exports/sabr-stream.js",
  () => ({
    SabrStream: class {
      constructor(config: unknown) {
        mocks.create(config);
      }
      start = mocks.start;
      abort = mocks.abort;
    },
  }),
);

import { downloadYoutubeAudio } from "../apps/chrome-extension/src/entrypoints/offscreen/youtube-audio";

const context: BrowserYoutubeMediaContext = {
  apiKey: "test-key",
  visitorData: null,
  videoId: "test",
  url: "https://www.youtube.com/watch?v=test",
  title: "Test",
  durationSeconds: 1,
  directAudio: {
    contentLength: null,
    mimeType: "audio/mp4",
    resolver: "player",
    url: "https://example.com/audio",
  },
  sabr: {
    serverAbrStreamingUrl: "https://example.com/sabr",
    videoPlaybackUstreamerConfig: "",
    clientName: 1,
    clientVersion: "test",
    formats: [
      {
        itag: 140,
        mimeType: "audio/mp4",
        bitrate: 128000,
        audioQuality: "AUDIO_QUALITY_MEDIUM",
        audioTrackId: "en.0",
      },
    ],
  },
};
const capturedSabr = { url: "https://example.com/sabr", poToken: null, timestamp: 0 };

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetAllMocks();
});

function failDirectAudio() {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status: 403 })));
}

describe("SABR binary streams", () => {
  it("preserves raw bytes and offsets from mixed binary views", async () => {
    failDirectAudio();
    const bytes = new Uint8Array([99, 1, 2, 3, 4, 99]);
    mocks.start.mockReturnValue({
      audioStream: new ReadableStream<ArrayBufferView>({
        start(controller) {
          controller.enqueue(new DataView(bytes.buffer, 1, 2));
          controller.enqueue(new Uint8Array(bytes.buffer, 3, 2));
          controller.close();
        },
      }),
    });
    const result = await downloadYoutubeAudio({ context, capturedSabr });
    expect(result.bytes).toEqual(new Uint8Array([1, 2, 3, 4]));
    expect(result.mediaSource).toBe("sabr");
    expect(mocks.abort).not.toHaveBeenCalled();
    const config = mocks.create.mock.calls[0]?.[0];
    expect(config.videoId).toBe("test");
    expect(config.formats[0].audioTrackId).toBe("en.0");
    await config.fetchFunction("https://example.com/sabr", { method: "POST" });
    expect(fetch).toHaveBeenLastCalledWith("https://example.com/sabr", {
      method: "POST",
      credentials: "include",
    });
  });

  it("waits for asynchronous abort when the stream fails", async () => {
    failDirectAudio();
    mocks.start.mockReturnValue({
      audioStream: new ReadableStream({
        start(controller) {
          controller.error(new Error("SABR read failed"));
        },
      }),
    });
    const { promise, resolve } = Promise.withResolvers<void>();
    mocks.abort.mockReturnValue(promise);
    const result = downloadYoutubeAudio({ context, capturedSabr });
    let settled = false;
    void result.catch(() => {
      settled = true;
    });
    await vi.waitFor(() => expect(mocks.abort).toHaveBeenCalledOnce());
    expect(settled).toBe(false);
    resolve();
    await expect(result).rejects.toThrow("SABR read failed");
  });

  it("preserves the read error if asynchronous cleanup fails", async () => {
    failDirectAudio();
    mocks.start.mockReturnValue({
      audioStream: new ReadableStream({
        start(controller) {
          controller.error(new Error("SABR read failed"));
        },
      }),
    });
    mocks.abort.mockRejectedValue(new Error("Cleanup failed"));
    await expect(downloadYoutubeAudio({ context, capturedSabr })).rejects.toThrow(
      "SABR read failed",
    );
  });
});
