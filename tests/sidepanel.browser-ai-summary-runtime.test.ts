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

  it("keeps overall and slide requests isolated", async () => {
    let resolveSummary: ((value: string) => void) | null = null;
    const summaryResult = new Promise<string>((resolve) => {
      resolveSummary = resolve;
    });
    const summarySummarize = vi.fn(() => summaryResult);
    const slidesSummarize = vi.fn(async () => "Slide result");
    const create = vi
      .fn()
      .mockResolvedValueOnce({ summarize: summarySummarize })
      .mockResolvedValueOnce({ summarize: slidesSummarize });
    const runtime = createBrowserAiSummaryRuntime({
      getApi: () => ({
        availability: vi.fn(async () => "available" as const),
        create,
      }),
      isUserActive: () => false,
      setStatus: vi.fn(),
    });

    const overall = runtime.summarize({
      input: { text: "Overall source", length: "short", keyMoments: [] },
    });
    const slide = runtime.summarize({
      input: { text: "Slide source", length: "short", keyMoments: [] },
      requestKey: "slides",
    });

    await expect(slide).resolves.toBe("Slide result");
    resolveSummary?.("Overall result");
    await expect(overall).resolves.toBe("Overall result");
    expect(create).toHaveBeenCalledTimes(2);
  });

  it("prewarms and runs a constrained Prompt API request", async () => {
    const session = {
      contextWindow: 9_216,
      measureContextUsage: vi.fn(async () => 700),
      prompt: vi.fn(async () => "[slide:1] A concise summary."),
      destroy: vi.fn(),
    };
    const create = vi.fn(async () => session);
    const availability = vi.fn(async () => "downloadable" as const);
    const runtime = createBrowserAiSummaryRuntime({
      getApi: () => null,
      getLanguageModelApi: () => ({ availability, create }),
      isUserActive: () => true,
      setStatus: vi.fn(),
    });
    const constraint = /^\[slide:1\] [^\r\n]{1,180}$/;

    runtime.preparePrompt();
    await Promise.resolve();
    const result = await runtime.prompt({
      input: "INDEX 1\nSource text",
      responseConstraint: constraint,
      status: "Summarizing slides…",
    });

    expect(result).toEqual({
      kind: "success",
      text: "[slide:1] A concise summary.",
      contextUsage: 700,
      contextWindow: 9_216,
    });
    expect(create).toHaveBeenCalledOnce();
    expect(availability).not.toHaveBeenCalled();
    expect(session.prompt).toHaveBeenCalledWith("INDEX 1\nSource text", {
      responseConstraint: constraint,
      omitResponseConstraintInput: true,
      signal: expect.any(AbortSignal),
    });
    expect(session.destroy).toHaveBeenCalledOnce();
  });

  it("creates a multimodal Prompt API session for slide images", async () => {
    const image = new Blob(["image"], { type: "image/jpeg" });
    const input = [
      {
        role: "user" as const,
        content: [
          { type: "text" as const, value: "INDEX 1" },
          { type: "image" as const, value: image },
        ],
      },
    ];
    const session = {
      contextWindow: 9_216,
      measureContextUsage: vi.fn(async () => 900),
      prompt: vi.fn(async () => "[slide:1] A visible equation is explained."),
      destroy: vi.fn(),
    };
    const create = vi.fn(async () => session);
    const availability = vi.fn(async () => "downloadable" as const);
    const runtime = createBrowserAiSummaryRuntime({
      getApi: () => null,
      getLanguageModelApi: () => ({ availability, create }),
      isUserActive: () => true,
      setStatus: vi.fn(),
    });

    runtime.preparePrompt("slides", { imageInput: true });
    await Promise.resolve();
    await expect(
      runtime.prompt({
        input,
        responseConstraint: /^\[slide:1\] [^\r\n]{1,260}$/,
      }),
    ).resolves.toEqual(
      expect.objectContaining({
        kind: "success",
        text: "[slide:1] A visible equation is explained.",
      }),
    );

    expect(create).toHaveBeenCalledOnce();
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        expectedInputs: [{ type: "text", languages: ["en"] }, { type: "image" }],
      }),
    );
    expect(availability).not.toHaveBeenCalled();
    expect(session.prompt).toHaveBeenCalledWith(
      input,
      expect.objectContaining({
        omitResponseConstraintInput: true,
        signal: expect.any(AbortSignal),
      }),
    );
  });

  it("reports context pressure before prompting", async () => {
    const session = {
      contextWindow: 1_000,
      measureContextUsage: vi.fn(async () => 900),
      prompt: vi.fn(),
      destroy: vi.fn(),
    };
    const runtime = createBrowserAiSummaryRuntime({
      getApi: () => null,
      getLanguageModelApi: () => ({
        availability: vi.fn(async () => "available" as const),
        create: vi.fn(async () => session),
      }),
      isUserActive: () => false,
      setStatus: vi.fn(),
    });

    await expect(
      runtime.prompt({
        input: "Oversized source",
        responseConstraint: /^.+$/,
      }),
    ).resolves.toEqual({
      kind: "too-large",
      contextUsage: 900,
      contextWindow: 1_000,
    });
    expect(session.prompt).not.toHaveBeenCalled();
    expect(session.destroy).toHaveBeenCalledOnce();
  });
});
