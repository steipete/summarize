import { describe, expect, it } from "vitest";
import { createSlidesStreamController } from "../apps/chrome-extension/src/entrypoints/sidepanel/slides-stream-controller.js";
import { encodeSseEvent, type SseEvent } from "../packages/core/src/runtime/sse-events.js";

const encoder = new TextEncoder();

function streamFromEvents(events: SseEvent[]) {
  const payload = events.map((event) => encodeSseEvent(event)).join("");
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(payload));
      controller.close();
    },
  });
}

function streamWithKeepaliveAndDone(delayMs: number, keepaliveEveryMs: number) {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(`: keepalive ${Date.now()}\n\n`));
      const keepalive = setInterval(() => {
        controller.enqueue(encoder.encode(`: keepalive ${Date.now()}\n\n`));
      }, keepaliveEveryMs);
      setTimeout(() => {
        clearInterval(keepalive);
        controller.enqueue(encoder.encode(encodeSseEvent({ event: "done", data: {} })));
        controller.close();
      }, delayMs);
    },
  });
}

describe("sidepanel slides stream controller", () => {
  it("streams slides events and finishes on done", async () => {
    const slidesEvents: SseEvent[] = [
      { event: "status", data: { text: "Slides: extracting" } },
      {
        event: "slides",
        data: {
          sourceUrl: "https://example.com",
          sourceId: "abc",
          sourceKind: "youtube",
          ocrAvailable: false,
          slides: [
            {
              index: 1,
              timestamp: 1.2,
              imageUrl: "http://127.0.0.1:8787/v1/slides/abc/1",
              ocrText: null,
              ocrConfidence: null,
            },
          ],
        },
      },
      { event: "done", data: {} },
    ];
    const received: number[] = [];
    const statuses: string[] = [];
    let done = false;

    const controller = createSlidesStreamController({
      getToken: async () => "token",
      onSlides: (payload) => received.push(payload.slides.length),
      onStatus: (text) => statuses.push(text),
      onDone: () => {
        done = true;
      },
      fetchImpl: async () => new Response(streamFromEvents(slidesEvents), { status: 200 }),
    });

    await controller.start("run-1");

    expect(received).toEqual([1]);
    expect(statuses).toContain("Slides: extracting");
    expect(done).toBe(true);
  });

  it("reports errors when the stream returns an error event", async () => {
    const errors: string[] = [];

    const controller = createSlidesStreamController({
      getToken: async () => "token",
      onSlides: () => {},
      onError: (err) => {
        const message = err instanceof Error ? err.message : String(err);
        errors.push(message);
        return message;
      },
      fetchImpl: async () =>
        new Response(streamFromEvents([{ event: "error", data: { message: "slides crashed" } }]), {
          status: 200,
        }),
    });

    await controller.start("run-1");

    expect(errors.some((msg) => msg.includes("slides crashed"))).toBe(true);
  });

  it("reports errors when the stream ends without done", async () => {
    const errors: string[] = [];
    const payload: SseEvent = {
      event: "slides",
      data: {
        sourceUrl: "https://example.com",
        sourceId: "abc",
        sourceKind: "youtube",
        ocrAvailable: false,
        slides: [],
      },
    };

    const controller = createSlidesStreamController({
      getToken: async () => "token",
      onSlides: () => {},
      onError: (err) => {
        const message = err instanceof Error ? err.message : String(err);
        errors.push(message);
        return message;
      },
      fetchImpl: async () => new Response(streamFromEvents([payload]), { status: 200 }),
    });

    await controller.start("run-1");

    expect(errors.some((msg) => msg.includes("Stream ended unexpectedly"))).toBe(true);
  });

  it("times out when no events arrive", async () => {
    const errors: string[] = [];
    const stalledStream = new ReadableStream<Uint8Array>({
      start() {},
    });

    const controller = createSlidesStreamController({
      getToken: async () => "token",
      onSlides: () => {},
      onError: (err) => {
        const message = err instanceof Error ? err.message : String(err);
        errors.push(message);
        return message;
      },
      fetchImpl: async () => new Response(stalledStream, { status: 200 }),
      idleTimeoutMs: 25,
      idleTimeoutMessage: "Timed out waiting for slide updates.",
    });

    await controller.start("run-1");

    expect(errors.some((msg) => msg.includes("Timed out waiting"))).toBe(true);
  });

  it("does not time out on keepalive comments", async () => {
    const errors: string[] = [];
    let done = false;

    const controller = createSlidesStreamController({
      getToken: async () => "token",
      onSlides: () => {},
      onDone: () => {
        done = true;
      },
      onError: (err) => {
        const message = err instanceof Error ? err.message : String(err);
        errors.push(message);
        return message;
      },
      fetchImpl: async () => new Response(streamWithKeepaliveAndDone(60, 10), { status: 200 }),
      idleTimeoutMs: 25,
      idleTimeoutMessage: "Timed out waiting for slide updates.",
    });

    await controller.start("run-1");

    expect(done).toBe(true);
    expect(errors).toEqual([]);
  });

  it("returns early when token is missing", async () => {
    let fetched = false;
    const controller = createSlidesStreamController({
      getToken: async () => "",
      onSlides: () => {},
      fetchImpl: async () => {
        fetched = true;
        return new Response(streamFromEvents([{ event: "done", data: {} }]), { status: 200 });
      },
    });

    await controller.start("run-1");

    expect(fetched).toBe(false);
    expect(controller.isStreaming()).toBe(false);
  });

  it("does not fetch if aborted before token lookup resolves", async () => {
    let fetched = false;
    let releaseToken: ((value: string) => void) | null = null;
    const tokenPromise = new Promise<string>((resolve) => {
      releaseToken = resolve;
    });
    const controller = createSlidesStreamController({
      getToken: async () => await tokenPromise,
      onSlides: () => {},
      fetchImpl: async () => {
        fetched = true;
        return new Response(streamFromEvents([{ event: "done", data: {} }]), { status: 200 });
      },
    });

    const startPromise = controller.start("run-1");
    controller.abort();
    releaseToken?.("token");
    await startPromise;

    expect(fetched).toBe(false);
    expect(controller.isStreaming()).toBe(false);
  });

  it("reports errors when the server returns a non-ok response", async () => {
    const errors: string[] = [];
    const controller = createSlidesStreamController({
      getToken: async () => "token",
      onSlides: () => {},
      onError: (err) => {
        const message = err instanceof Error ? err.message : String(err);
        errors.push(message);
        return message;
      },
      fetchImpl: async () => new Response("nope", { status: 500, statusText: "Boom" }),
    });

    await controller.start("run-1");

    expect(errors.some((msg) => msg.includes("500 Boom"))).toBe(true);
  });

  it("reports errors when the response body is missing", async () => {
    const errors: string[] = [];
    const controller = createSlidesStreamController({
      getToken: async () => "token",
      onSlides: () => {},
      onError: (err) => {
        const message = err instanceof Error ? err.message : String(err);
        errors.push(message);
        return message;
      },
      fetchImpl: async () => new Response(null, { status: 200 }),
    });

    await controller.start("run-1");

    expect(errors.some((msg) => msg.includes("Missing stream body"))).toBe(true);
  });
});
