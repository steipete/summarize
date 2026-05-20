import { describe, expect, it } from "vitest";
import { createStreamController } from "../apps/chrome-extension/src/entrypoints/sidepanel/stream-controller.js";
import { encodeSseEvent, type SseEvent } from "../src/shared/sse-events.js";

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

function streamWithKeepaliveThenEvents(
  events: SseEvent[],
  delayMs: number,
  keepaliveEveryMs: number,
) {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(`: keepalive ${Date.now()}\n\n`));
      const keepalive = setInterval(() => {
        controller.enqueue(encoder.encode(`: keepalive ${Date.now()}\n\n`));
      }, keepaliveEveryMs);
      setTimeout(() => {
        clearInterval(keepalive);
        controller.enqueue(encoder.encode(events.map((event) => encodeSseEvent(event)).join("")));
        controller.close();
      }, delayMs);
    },
  });
}

const run = {
  id: "run-1",
  url: "https://example.com",
  title: null,
  model: "auto",
  reason: "manual",
};

describe("sidepanel stream controller error handling", () => {
  it("does not let stale starts cancel newer streams after token lookup races", async () => {
    let releaseFirstToken: ((value: string) => void) | null = null;
    const firstToken = new Promise<string>((resolve) => {
      releaseFirstToken = resolve;
    });
    const tokenCalls: Promise<string>[] = [firstToken, Promise.resolve("token-2")];
    const fetched: string[] = [];
    const phases: string[] = [];
    const controller = createStreamController({
      getToken: async () => await (tokenCalls.shift() ?? Promise.resolve("token")),
      onStatus: () => {},
      onPhaseChange: (phase) => phases.push(phase),
      onMeta: () => {},
      fetchImpl: async (input) => {
        fetched.push(String(input));
        return new Response(
          streamFromEvents([
            { event: "chunk", data: { text: "ok" } },
            { event: "done", data: {} },
          ]),
          { status: 200 },
        );
      },
    });

    const staleStart = controller.start({ ...run, id: "run-old" });
    const currentStart = controller.start({ ...run, id: "run-new" });
    await currentStart;
    releaseFirstToken?.("token-1");
    await staleStart;

    expect(fetched).toEqual(["http://127.0.0.1:8787/v1/summarize/run-new/events"]);
    expect(phases.at(-1)).toBe("idle");
  });

  it("keeps error phase when SSE returns an error event", async () => {
    const phases: string[] = [];
    const statuses: string[] = [];

    const controller = createStreamController({
      getToken: async () => "token",
      onStatus: (text) => statuses.push(text),
      onPhaseChange: (phase) => phases.push(phase),
      onMeta: () => {},
      fetchImpl: async () =>
        new Response(streamFromEvents([{ event: "error", data: { message: "daemon crashed" } }]), {
          status: 200,
        }),
    });

    await controller.start(run);

    expect(phases.at(-1)).toBe("error");
    expect(phases).not.toContain("idle");
    expect(statuses.some((status) => status.includes("Error:"))).toBe(true);
  });

  it("keeps error phase when the fetch fails", async () => {
    const phases: string[] = [];

    const controller = createStreamController({
      getToken: async () => "token",
      onStatus: () => {},
      onPhaseChange: (phase) => phases.push(phase),
      onMeta: () => {},
      fetchImpl: async () => {
        throw new Error("connection refused");
      },
    });

    await controller.start(run);

    expect(phases.at(-1)).toBe("error");
    expect(phases).not.toContain("idle");
  });

  it("keeps error phase when the stream ends without a done event", async () => {
    const phases: string[] = [];
    const statuses: string[] = [];

    const controller = createStreamController({
      getToken: async () => "token",
      onStatus: (text) => statuses.push(text),
      onPhaseChange: (phase) => phases.push(phase),
      onMeta: () => {},
      fetchImpl: async () =>
        new Response(streamFromEvents([{ event: "chunk", data: { text: "Hello" } }]), {
          status: 200,
        }),
    });

    await controller.start(run);

    expect(phases.at(-1)).toBe("error");
    expect(statuses.some((status) => status.includes("Stream ended unexpectedly"))).toBe(true);
  });

  it("keeps error phase when the stream stalls without output", async () => {
    const phases: string[] = [];
    const statuses: string[] = [];
    const stalledStream = new ReadableStream<Uint8Array>({
      start() {},
    });

    const controller = createStreamController({
      getToken: async () => "token",
      onStatus: (text) => statuses.push(text),
      onPhaseChange: (phase) => phases.push(phase),
      onMeta: () => {},
      fetchImpl: async () => new Response(stalledStream, { status: 200 }),
      idleTimeoutMs: 25,
      idleTimeoutMessage: "Timed out waiting for daemon output.",
    });

    await controller.start(run);

    expect(phases.at(-1)).toBe("error");
    expect(statuses.some((status) => status.includes("Timed out waiting"))).toBe(true);
  });

  it("does not time out on keepalive comments", async () => {
    const phases: string[] = [];
    const statuses: string[] = [];

    const controller = createStreamController({
      getToken: async () => "token",
      onStatus: (text) => statuses.push(text),
      onPhaseChange: (phase) => phases.push(phase),
      onMeta: () => {},
      fetchImpl: async () =>
        new Response(
          streamWithKeepaliveThenEvents(
            [
              { event: "chunk", data: { text: "Hello" } },
              { event: "done", data: {} },
            ],
            60,
            10,
          ),
          { status: 200 },
        ),
      idleTimeoutMs: 25,
      idleTimeoutMessage: "Timed out waiting for daemon output.",
    });

    await controller.start(run);

    expect(phases.at(-1)).toBe("idle");
    expect(statuses.some((status) => status.includes("Timed out waiting"))).toBe(false);
  });
});
