import { describe, expect, it } from "vitest";
import { parseSseStream } from "../apps/chrome-extension/src/lib/sse.js";
import {
  encodeSseEvent,
  parseSseEvent,
  type SseEvent,
} from "../packages/core/src/runtime/sse-events.js";

async function collectSse(input: string) {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(input));
      controller.close();
    },
  });
  const events = [];
  for await (const event of parseSseStream(stream)) {
    events.push(event);
  }
  return events;
}

describe("sse events", () => {
  it("encodes and parses known events", () => {
    const events: SseEvent[] = [
      {
        event: "meta",
        data: {
          model: "openai/gpt-5.2",
          modelLabel: "gpt-5.2",
          inputSummary: "Example",
          summaryFromCache: false,
        },
      },
      { event: "status", data: { text: "Working…" } },
      { event: "chunk", data: { text: "Hello" } },
      {
        event: "slides",
        data: {
          sourceUrl: "https://example.com/video",
          sourceId: "video-1",
          sourceKind: "video",
          ocrAvailable: true,
          slides: [
            {
              index: 0,
              timestamp: 12,
              imageUrl: "https://example.com/slide-1.jpg",
              ocrText: "Intro",
              ocrConfidence: 0.99,
            },
          ],
        },
      },
      {
        event: "assistant",
        data: {
          role: "assistant",
          content: [{ type: "text", text: "Hi" }],
          api: "openai-completions",
          provider: "openai",
          model: "gpt-5.2",
          usage: {
            input: 1,
            output: 1,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 2,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
          stopReason: "stop",
          timestamp: 1,
        },
      },
      {
        event: "metrics",
        data: {
          elapsedMs: 1200,
          summary: "7.5s · example.com",
          details: null,
          summaryDetailed: "7.5s · example.com · ↑1.2k ↓300",
          detailsDetailed: null,
        },
      },
      { event: "done", data: {} },
      { event: "error", data: { message: "Boom" } },
    ];

    for (const event of events) {
      const encoded = encodeSseEvent(event);
      expect(encoded).toBe(`event: ${event.event}\ndata: ${JSON.stringify(event.data)}\n\n`);

      const parsed = parseSseEvent({
        event: event.event,
        data: JSON.stringify(event.data),
      });
      expect(parsed).toEqual(event);
    }
  });

  it("ignores unknown events", () => {
    expect(parseSseEvent({ event: "unknown", data: "{}" })).toBeNull();
  });

  it("flushes a final SSE event at EOF without a blank delimiter", async () => {
    await expect(collectSse("event: done\ndata: {}")).resolves.toEqual([
      { event: "done", data: "{}" },
    ]);
  });

  it("flushes a final SSE event at EOF with only a trailing newline", async () => {
    await expect(collectSse("event: done\ndata: {}\n")).resolves.toEqual([
      { event: "done", data: "{}" },
    ]);
  });

  it("preserves significant whitespace in SSE data fields", async () => {
    await expect(collectSse("event: chunk\ndata:  leading and trailing  \n\n")).resolves.toEqual([
      { event: "chunk", data: " leading and trailing  " },
    ]);
  });

  it("preserves trailing whitespace before joining multi-line SSE data", async () => {
    await expect(collectSse("event: chunk\ndata: first  \ndata: second\n\n")).resolves.toEqual([
      { event: "chunk", data: "first  \nsecond" },
    ]);
  });

  it("treats colonless SSE data fields as empty values", async () => {
    await expect(collectSse("event: chunk\ndata\ndata: x\n\n")).resolves.toEqual([
      { event: "chunk", data: "\nx" },
    ]);
  });
});
