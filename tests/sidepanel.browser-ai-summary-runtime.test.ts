// @vitest-environment happy-dom
import { describe, expect, it, vi } from "vitest";
import { createBrowserAiSummaryRuntime } from "../apps/chrome-extension/src/entrypoints/sidepanel/browser-ai-summary-runtime";

describe("sidepanel browser AI summary runtime", () => {
  it("prewarms from user activation and reuses the created Gemini Nano summarizer", async () => {
    const summarize = vi.fn(async () => "Nano summary");
    const create = vi.fn(async () => ({ summarize }));
    const availability = vi.fn(async () => "downloadable" as const);
    const setStatus = vi.fn();
    const runtime = createBrowserAiSummaryRuntime({
      getApi: () => ({ availability, create }),
      isUserActive: () => true,
      setStatus,
    });

    runtime.prepare("medium");
    await Promise.resolve();
    const result = await runtime.summarize({
      input: { text: "Long source text", length: "medium", keyMoments: [] },
      context: "Article",
    });

    expect(result).toBe("Nano summary");
    expect(create).toHaveBeenCalledOnce();
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "key-points",
        format: "plain-text",
        length: "medium",
      }),
    );
    expect(availability).not.toHaveBeenCalled();
    expect(summarize).toHaveBeenCalledWith("Long source text", {
      context: "Article",
      signal: expect.any(AbortSignal),
    });
    expect(setStatus).toHaveBeenLastCalledWith("");
  });

  it("does not trigger a first-time model download without user activation", async () => {
    const create = vi.fn();
    const runtime = createBrowserAiSummaryRuntime({
      getApi: () => ({
        availability: vi.fn(async () => "downloadable" as const),
        create,
      }),
      isUserActive: () => false,
      setStatus: vi.fn(),
    });

    const result = await runtime.summarize({
      input: { text: "Source", length: "short", keyMoments: [] },
    });

    expect(result).toBeNull();
    expect(create).not.toHaveBeenCalled();
  });

  it("uses an already available model without user activation", async () => {
    const create = vi.fn(async () => ({ summarize: vi.fn(async () => "Available summary") }));
    const runtime = createBrowserAiSummaryRuntime({
      getApi: () => ({
        availability: vi.fn(async () => "available" as const),
        create,
      }),
      isUserActive: () => false,
      setStatus: vi.fn(),
    });

    await expect(
      runtime.summarize({
        input: { text: "Source", length: "long", keyMoments: [] },
      }),
    ).resolves.toBe("Available summary");
    expect(create).toHaveBeenCalledOnce();
  });

  it("clears download status when model creation fails", async () => {
    const setStatus = vi.fn();
    const runtime = createBrowserAiSummaryRuntime({
      getApi: () => ({
        availability: vi.fn(async () => "available" as const),
        create: vi.fn(async ({ monitor }) => {
          const events = new EventTarget();
          monitor(events);
          events.dispatchEvent(Object.assign(new Event("downloadprogress"), { loaded: 0.5 }));
          throw new Error("model failed");
        }),
      }),
      isUserActive: () => false,
      setStatus,
    });

    await expect(
      runtime.summarize({
        input: { text: "Source", length: "short", keyMoments: [] },
      }),
    ).resolves.toBeNull();
    expect(setStatus).toHaveBeenCalledWith("Downloading on-device AI… 50%");
    expect(setStatus).toHaveBeenLastCalledWith("");
  });

  it("recursively summarizes input that exceeds the session quota", async () => {
    const summarize = vi.fn(async (text: string) => {
      if (text === "part-a\npart-b") return "final";
      return text.startsWith("A") ? "part-a" : "part-b";
    });
    const runtime = createBrowserAiSummaryRuntime({
      getApi: () => ({
        availability: vi.fn(async () => "available" as const),
        create: vi.fn(async () => ({
          inputQuota: 20,
          measureInputUsage: vi.fn(async (text: string) => Math.ceil(text.length / 2)),
          summarize,
        })),
      }),
      isUserActive: () => false,
      setStatus: vi.fn(),
    });

    const result = await runtime.summarize({
      input: {
        text: `${"A".repeat(20)}. ${"B".repeat(20)}.`,
        length: "long",
        keyMoments: [],
      },
    });

    expect(summarize.mock.calls.map(([text]) => text)).toEqual([
      `${"A".repeat(20)}.`,
      `${"B".repeat(20)}.`,
      "part-a\npart-b",
    ]);
    expect(result).toBe("final");
    expect(summarize).toHaveBeenCalledTimes(3);
  });
});
