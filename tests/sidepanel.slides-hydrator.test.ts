import { describe, expect, it, vi } from "vitest";
import { createSlidesHydrator } from "../apps/chrome-extension/src/entrypoints/sidepanel/slides-hydrator.js";
import { encodeSseEvent, type SseEvent, type SseSlidesData } from "../src/shared/sse-events.js";

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

async function waitFor(check: () => boolean, attempts = 20) {
  for (let i = 0; i < attempts; i += 1) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error("timeout waiting for condition");
}

describe("sidepanel slides hydrator", () => {
  it("reports and clears the active run id", async () => {
    let releaseStream: (() => void) | null = null;
    const streamReleased = new Promise<void>((resolve) => {
      releaseStream = resolve;
    });
    const hydrator = createSlidesHydrator({
      getToken: async () => "",
      onSlides: () => {},
      streamFetchImpl: async () => {
        await streamReleased;
        return new Response(streamFromEvents([{ event: "done", data: {} }]), { status: 200 });
      },
      snapshotFetchImpl: async () => new Response(JSON.stringify({ ok: false }), { status: 200 }),
    });

    const startPromise = hydrator.start("run-active");
    await waitFor(() => hydrator.getActiveRunId() === "run-active");

    expect(hydrator.getActiveRunId()).toBe("run-active");
    hydrator.stop();
    expect(hydrator.getActiveRunId()).toBeNull();
    releaseStream?.();
    await startPromise;
  });

  it("hydrates snapshot when the stream finishes without slides", async () => {
    const payload: SseSlidesData = {
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
    };
    const received: SseSlidesData[] = [];

    const hydrator = createSlidesHydrator({
      getToken: async () => "token",
      onSlides: (slides) => received.push(slides),
      streamFetchImpl: async () =>
        new Response(streamFromEvents([{ event: "done", data: {} }]), { status: 200 }),
      snapshotFetchImpl: async () =>
        new Response(JSON.stringify({ ok: true, slides: payload }), { status: 200 }),
    });

    await hydrator.start("run-1");
    await waitFor(() => received.length === 1);

    expect(received).toEqual([payload]);
  });

  it("ignores snapshot results when the active run changes", async () => {
    const payload: SseSlidesData = {
      sourceUrl: "https://example.com",
      sourceId: "stale",
      sourceKind: "youtube",
      ocrAvailable: false,
      slides: [
        {
          index: 1,
          timestamp: 2.4,
          imageUrl: "http://127.0.0.1:8787/v1/slides/stale/1",
          ocrText: null,
          ocrConfidence: null,
        },
      ],
    };
    let resolveSnapshot: ((value: Response) => void) | null = null;
    let snapshotRequested = false;
    const snapshotPromise = new Promise<Response>((resolve) => {
      resolveSnapshot = resolve;
    });
    const received: SseSlidesData[] = [];
    const livePayload: SseSlidesData = {
      sourceUrl: "https://example.com",
      sourceId: "live",
      sourceKind: "youtube",
      ocrAvailable: false,
      slides: [
        {
          index: 1,
          timestamp: 1,
          imageUrl: "http://127.0.0.1:8787/v1/slides/live/1",
          ocrText: null,
          ocrConfidence: null,
        },
      ],
    };

    const hydrator = createSlidesHydrator({
      getToken: async () => "token",
      onSlides: (slides) => received.push(slides),
      streamFetchImpl: async (input) => {
        const url = String(input);
        if (url.includes("run-2")) {
          return new Response(
            streamFromEvents([
              { event: "slides", data: livePayload },
              { event: "done", data: {} },
            ]),
            { status: 200 },
          );
        }
        return new Response(streamFromEvents([{ event: "done", data: {} }]), { status: 200 });
      },
      snapshotFetchImpl: async () => {
        snapshotRequested = true;
        return snapshotPromise;
      },
    });

    void hydrator.start("run-1");
    await waitFor(() => snapshotRequested);
    await hydrator.start("run-2");

    resolveSnapshot?.(new Response(JSON.stringify({ ok: true, slides: payload }), { status: 200 }));
    await snapshotPromise;
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(received).toEqual([livePayload]);
  });

  it("does not start a stale stream after a superseded local lookup misses", async () => {
    let resolveLocal: ((value: SseSlidesData | null) => void) | null = null;
    const localPromise = new Promise<SseSlidesData | null>((resolve) => {
      resolveLocal = resolve;
    });
    const streamFetchImpl = vi.fn(async () => {
      return new Response(streamFromEvents([{ event: "done", data: {} }]), { status: 200 });
    });
    const hydrator = createSlidesHydrator({
      getToken: async () => "",
      onSlides: () => {},
      resolveLocalSlides: async (runId) => (runId === "run-1" ? await localPromise : null),
      streamFetchImpl,
    });

    const staleStart = hydrator.start("run-1");
    await waitFor(() => hydrator.getActiveRunId() === "run-1");
    hydrator.stop();
    resolveLocal?.(null);
    await staleStart;

    expect(streamFetchImpl).not.toHaveBeenCalled();
  });

  it("finishes local runs when the in-memory browser payload is missing", async () => {
    const streamFetchImpl = vi.fn(async () => {
      return new Response(streamFromEvents([{ event: "done", data: {} }]), { status: 200 });
    });
    const onDone = vi.fn();
    const hydrator = createSlidesHydrator({
      getToken: async () => "token",
      onSlides: () => {},
      onDone,
      resolveLocalSlides: async () => null,
      streamFetchImpl,
    });

    await hydrator.start("browser-run", { local: true });

    expect(streamFetchImpl).not.toHaveBeenCalled();
    expect(onDone).toHaveBeenCalledOnce();
  });

  it("hydrates snapshot when cache is loaded without slides", async () => {
    const payload: SseSlidesData = {
      sourceUrl: "https://example.com",
      sourceId: "cache",
      sourceKind: "youtube",
      ocrAvailable: false,
      slides: [
        {
          index: 1,
          timestamp: 5,
          imageUrl: "http://127.0.0.1:8787/v1/slides/cache/1",
          ocrText: null,
          ocrConfidence: null,
        },
      ],
    };
    let snapshotCalls = 0;
    const received: SseSlidesData[] = [];
    const hydrator = createSlidesHydrator({
      getToken: async () => "token",
      onSlides: (slides) => received.push(slides),
      streamFetchImpl: async () =>
        new Response(streamFromEvents([{ event: "done", data: {} }]), { status: 200 }),
      snapshotFetchImpl: async () => {
        snapshotCalls += 1;
        return new Response(JSON.stringify({ ok: true, slides: payload }), { status: 200 });
      },
    });

    hydrator.syncFromCache({ runId: "run-cache", summaryFromCache: true, hasSlides: false });
    await waitFor(() => received.length === 1);

    expect(snapshotCalls).toBe(1);
    expect(received).toEqual([payload]);
  });

  it("hydrates snapshot when the stream only sends malformed slides", async () => {
    const payload: SseSlidesData = {
      sourceUrl: "https://example.com",
      sourceId: "snapshot",
      sourceKind: "youtube",
      ocrAvailable: false,
      slides: [
        {
          index: 1,
          timestamp: 7,
          imageUrl: "http://127.0.0.1:8787/v1/slides/snapshot/1",
          ocrText: null,
          ocrConfidence: null,
        },
      ],
    };
    const malformed = {
      sourceUrl: "https://example.com",
      sourceId: "snapshot",
      sourceKind: "youtube",
      ocrAvailable: false,
      slides: [{ index: 0, timestamp: 0, imageUrl: "bad" }],
    } as unknown as SseSlidesData;
    let snapshotCalls = 0;
    const received: SseSlidesData[] = [];
    const hydrator = createSlidesHydrator({
      getToken: async () => "token",
      onSlides: (slides) => received.push(slides),
      streamFetchImpl: async () =>
        new Response(
          streamFromEvents([
            { event: "slides", data: malformed },
            { event: "done", data: {} },
          ]),
          { status: 200 },
        ),
      snapshotFetchImpl: async () => {
        snapshotCalls += 1;
        return new Response(JSON.stringify({ ok: true, slides: payload }), { status: 200 });
      },
    });

    await hydrator.start("run-malformed");
    await waitFor(() => received.length === 1);

    expect(snapshotCalls).toBe(1);
    expect(received).toEqual([payload]);
  });
});
