import { describe, expect, it, vi } from "vitest";
import { generateTextWithModelId, streamTextWithModelId } from "../src/llm/generate-text.js";
import { makeAssistantMessage, makeTextDeltaStream } from "./helpers/pi-ai-mock.js";

const mocks = vi.hoisted(() => ({
  completeSimple: vi.fn(),
  streamSimple: vi.fn(),
  getModel: vi.fn(() => {
    throw new Error("no model");
  }),
}));

vi.mock("@earendil-works/pi-ai/compat", () => ({
  completeSimple: mocks.completeSimple,
  streamSimple: mocks.streamSimple,
  getModel: mocks.getModel,
}));

describe("llm/generate-text extra branches", () => {
  it("streamTextWithModelId resolves usage=null when stream.result rejects", async () => {
    mocks.streamSimple.mockImplementationOnce(() =>
      makeTextDeltaStream(["o", "k"], makeAssistantMessage({ text: "ok" }), {
        error: new Error("no usage"),
      }),
    );

    const result = await streamTextWithModelId({
      modelId: "openai/gpt-5-chat",
      apiKeys: {
        openaiApiKey: "k",
        xaiApiKey: null,
        googleApiKey: null,
        anthropicApiKey: null,
        openrouterApiKey: null,
      },
      prompt: { userText: "hi" },
      timeoutMs: 2000,
      fetchImpl: globalThis.fetch.bind(globalThis),
      maxOutputTokens: 10,
    });

    const chunks: string[] = [];
    for await (const chunk of result.textStream) chunks.push(chunk);
    expect(chunks.join("")).toBe("ok");
    await expect(result.usage).resolves.toBeNull();
  });

  it("streamTextWithModelId normalizes anthropic access errors via error events", async () => {
    mocks.streamSimple.mockImplementationOnce(() =>
      makeTextDeltaStream(["o", "k"], makeAssistantMessage({ text: "ok", provider: "anthropic" }), {
        error: Object.assign(new Error("model: claude-3-5-sonnet-latest"), {
          statusCode: 403,
          responseBody: JSON.stringify({
            type: "error",
            error: { type: "permission_error", message: "model: claude-3-5-sonnet-latest" },
          }),
        }),
      }),
    );

    const result = await streamTextWithModelId({
      modelId: "anthropic/claude-3-5-sonnet-latest",
      apiKeys: {
        openaiApiKey: null,
        xaiApiKey: null,
        googleApiKey: null,
        anthropicApiKey: "k",
        openrouterApiKey: null,
      },
      prompt: { userText: "hi" },
      timeoutMs: 2000,
      fetchImpl: globalThis.fetch.bind(globalThis),
      maxOutputTokens: 10,
    });

    for await (const _chunk of result.textStream) {
      // Drain stream to observe error event and store lastError.
    }
    const err = result.lastError();
    expect(err instanceof Error ? err.message : String(err)).toMatch(
      /Anthropic API rejected model/i,
    );
  });

  it("streamTextWithModelId preserves Google status codes from SDK error events", async () => {
    const googleError = {
      ...makeAssistantMessage({ text: "", provider: "google" }),
      content: [],
      stopReason: "error" as const,
      errorMessage: JSON.stringify({
        error: {
          code: 429,
          message: "Resource exhausted",
          status: "RESOURCE_EXHAUSTED",
        },
      }),
    };
    mocks.streamSimple.mockImplementationOnce(() =>
      makeTextDeltaStream([], makeAssistantMessage({ text: "", provider: "google" }), {
        error: googleError,
      }),
    );

    const result = await streamTextWithModelId({
      modelId: "google/gemini-3-flash-preview",
      apiKeys: {
        openaiApiKey: null,
        xaiApiKey: null,
        googleApiKey: "k",
        anthropicApiKey: null,
        openrouterApiKey: null,
      },
      prompt: { userText: "hi" },
      timeoutMs: 2000,
      fetchImpl: globalThis.fetch.bind(globalThis),
    });

    for await (const _chunk of result.textStream) {
      // Drain stream to observe the provider error.
    }
    expect(result.lastError()).toMatchObject({
      message: expect.stringContaining("Resource exhausted"),
      statusCode: 429,
    });
  });

  it("generateTextWithModelId retries on timeout-like errors", async () => {
    vi.useFakeTimers();
    const randomSpy = vi.spyOn(Math, "random").mockReturnValue(0);
    try {
      let calls = 0;
      mocks.completeSimple.mockImplementation(async () => {
        calls += 1;
        if (calls === 1) throw new Error("timed out");
        return makeAssistantMessage({ text: "OK" });
      });

      const onRetry = vi.fn();
      const promise = generateTextWithModelId({
        modelId: "openai/gpt-5-chat",
        apiKeys: {
          openaiApiKey: "k",
          xaiApiKey: null,
          googleApiKey: null,
          anthropicApiKey: null,
          openrouterApiKey: null,
        },
        prompt: { userText: "hi" },
        timeoutMs: 2000,
        fetchImpl: globalThis.fetch.bind(globalThis),
        maxOutputTokens: 10,
        retries: 1,
        onRetry,
      });

      await vi.runOnlyPendingTimersAsync();
      const result = await promise;
      expect(result.text).toBe("OK");
      expect(onRetry).toHaveBeenCalled();
      expect(calls).toBe(2);
    } finally {
      randomSpy.mockRestore();
      vi.useRealTimers();
    }
  });

  it("generateTextWithModelId retries transient API errors", async () => {
    vi.useFakeTimers();
    const randomSpy = vi.spyOn(Math, "random").mockReturnValue(0);
    try {
      let calls = 0;
      mocks.completeSimple.mockImplementation(async () => {
        calls += 1;
        if (calls === 1) {
          throw Object.assign(new Error("OpenAI API error (502)."), { statusCode: 502 });
        }
        return makeAssistantMessage({ text: "OK" });
      });

      const onRetry = vi.fn();
      const promise = generateTextWithModelId({
        modelId: "openai/gpt-5-chat",
        apiKeys: {
          openaiApiKey: "k",
          xaiApiKey: null,
          googleApiKey: null,
          anthropicApiKey: null,
          openrouterApiKey: null,
        },
        prompt: { userText: "hi" },
        timeoutMs: 2000,
        fetchImpl: globalThis.fetch.bind(globalThis),
        retries: 1,
        onRetry,
      });

      await vi.runOnlyPendingTimersAsync();
      const result = await promise;
      expect(result.text).toBe("OK");
      expect(onRetry).toHaveBeenCalledWith(expect.objectContaining({ attempt: 1, maxRetries: 1 }));
      expect(calls).toBe(2);
    } finally {
      randomSpy.mockRestore();
      vi.useRealTimers();
    }
  });

  it("retries resolved terminal errors instead of returning partial text", async () => {
    vi.useFakeTimers();
    const randomSpy = vi.spyOn(Math, "random").mockReturnValue(0);
    mocks.completeSimple.mockClear();
    try {
      mocks.completeSimple
        .mockImplementationOnce(async () => ({
          ...makeAssistantMessage({ text: "truncated", provider: "xai" }),
          stopReason: "error" as const,
          errorMessage: "connection closed",
        }))
        .mockImplementationOnce(async () =>
          makeAssistantMessage({ text: "recovered", provider: "xai" }),
        );

      const promise = generateTextWithModelId({
        modelId: "xai/grok-4-fast-non-reasoning",
        apiKeys: {
          openaiApiKey: null,
          xaiApiKey: "k",
          googleApiKey: null,
          anthropicApiKey: null,
          openrouterApiKey: null,
        },
        prompt: { userText: "hi" },
        timeoutMs: 2000,
        fetchImpl: globalThis.fetch.bind(globalThis),
        retries: 1,
      });

      await vi.runOnlyPendingTimersAsync();
      await expect(promise).resolves.toMatchObject({ text: "recovered" });
      expect(mocks.completeSimple).toHaveBeenCalledTimes(2);
    } finally {
      randomSpy.mockRestore();
      vi.useRealTimers();
    }
  });

  it("throws missing key errors for openai/... models", async () => {
    mocks.completeSimple.mockReset();
    await expect(
      generateTextWithModelId({
        modelId: "openai/gpt-5-chat",
        apiKeys: {
          openaiApiKey: null,
          xaiApiKey: null,
          googleApiKey: null,
          anthropicApiKey: null,
          openrouterApiKey: null,
        },
        prompt: { userText: "hi" },
        timeoutMs: 2000,
        fetchImpl: globalThis.fetch.bind(globalThis),
        maxOutputTokens: 10,
      }),
    ).rejects.toThrow(/Missing OPENAI_API_KEY/i);
  });
});
