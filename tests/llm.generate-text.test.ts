import type { Api } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { generateTextWithModelId, streamTextWithModelId } from "../src/llm/generate-text.js";
import { buildDocumentPrompt } from "./helpers/document-prompt.js";
import { buildMinimalPdf } from "./helpers/pdf.js";
import { makeAssistantMessage, makeTextDeltaStream } from "./helpers/pi-ai-mock.js";

type MockModel = { provider: string; id: string; api: Api };

const mocks = vi.hoisted(() => ({
  completeSimple: vi.fn(),
  streamSimple: vi.fn(),
  getModel: vi.fn(() => {
    throw new Error("no model");
  }),
}));

mocks.completeSimple.mockImplementation(async (model: MockModel) =>
  makeAssistantMessage({
    provider: model.provider,
    model: model.id,
    api: model.api,
    text: "ok",
    usage: { input: 1, output: 2, totalTokens: 3 },
  }),
);
mocks.streamSimple.mockImplementation((_model: MockModel) =>
  makeTextDeltaStream(["o", "k"], makeAssistantMessage({ text: "ok" })),
);

vi.mock("@earendil-works/pi-ai/compat", () => ({
  completeSimple: mocks.completeSimple,
  streamSimple: mocks.streamSimple,
  getModel: mocks.getModel,
}));

describe("llm generate/stream", () => {
  const originalBaseUrl = process.env.OPENAI_BASE_URL;

  afterEach(() => {
    vi.useRealTimers();
    mocks.completeSimple.mockClear();
    mocks.streamSimple.mockClear();
    process.env.OPENAI_BASE_URL = originalBaseUrl;
  });

  it("routes by provider (generateText) and includes maxOutputTokens when set", async () => {
    mocks.completeSimple.mockClear();
    await generateTextWithModelId({
      modelId: "xai/grok-4-fast-non-reasoning",
      apiKeys: {
        xaiApiKey: "k",
        openaiApiKey: null,
        googleApiKey: null,
        anthropicApiKey: null,
        openrouterApiKey: null,
      },
      prompt: { userText: "hi" },
      timeoutMs: 2000,
      fetchImpl: globalThis.fetch.bind(globalThis),
      maxOutputTokens: 7,
    });
    await generateTextWithModelId({
      modelId: "google/gemini-3-flash-preview",
      apiKeys: {
        xaiApiKey: null,
        openaiApiKey: null,
        googleApiKey: "k",
        anthropicApiKey: null,
        openrouterApiKey: null,
      },
      prompt: { userText: "hi" },
      timeoutMs: 2000,
      fetchImpl: globalThis.fetch.bind(globalThis),
      maxOutputTokens: 7,
    });
    await generateTextWithModelId({
      modelId: "anthropic/claude-opus-4-5",
      apiKeys: {
        xaiApiKey: null,
        openaiApiKey: null,
        googleApiKey: null,
        anthropicApiKey: "k",
        openrouterApiKey: null,
      },
      prompt: { userText: "hi" },
      timeoutMs: 2000,
      fetchImpl: globalThis.fetch.bind(globalThis),
      maxOutputTokens: 7,
    });
    await generateTextWithModelId({
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
      maxOutputTokens: 7,
    });
    expect(mocks.completeSimple).toHaveBeenCalledTimes(4);
    for (const call of mocks.completeSimple.mock.calls) {
      const options = (call?.[2] ?? {}) as Record<string, unknown>;
      expect(options).toHaveProperty("maxTokens", 7);
    }
  });

  it("does not include maxOutputTokens when unset", async () => {
    mocks.completeSimple.mockClear();
    mocks.streamSimple.mockClear();

    await generateTextWithModelId({
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
    });

    await streamTextWithModelId({
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
    });

    expect(mocks.completeSimple).toHaveBeenCalledTimes(1);
    expect(mocks.streamSimple).toHaveBeenCalledTimes(1);

    const generateArgs = (mocks.completeSimple.mock.calls[0]?.[2] ?? {}) as Record<string, unknown>;
    const streamArgs = (mocks.streamSimple.mock.calls[0]?.[2] ?? {}) as Record<string, unknown>;

    expect(generateArgs).not.toHaveProperty("maxTokens");
    expect(streamArgs).not.toHaveProperty("maxTokens");
  });

  it("skips temperature for OpenAI GPT-5 models (generate/stream)", async () => {
    mocks.completeSimple.mockClear();
    mocks.streamSimple.mockClear();

    await generateTextWithModelId({
      modelId: "openai/gpt-5-mini",
      apiKeys: {
        openaiApiKey: "k",
        xaiApiKey: null,
        googleApiKey: null,
        anthropicApiKey: null,
        openrouterApiKey: null,
      },
      prompt: { userText: "hi" },
      temperature: 0.7,
      timeoutMs: 2000,
      fetchImpl: globalThis.fetch.bind(globalThis),
    });

    await streamTextWithModelId({
      modelId: "openai/gpt-5-mini",
      apiKeys: {
        openaiApiKey: "k",
        xaiApiKey: null,
        googleApiKey: null,
        anthropicApiKey: null,
        openrouterApiKey: null,
      },
      prompt: { userText: "hi" },
      temperature: 0.7,
      timeoutMs: 2000,
      fetchImpl: globalThis.fetch.bind(globalThis),
    });

    const generateArgs = (mocks.completeSimple.mock.calls[0]?.[2] ?? {}) as Record<string, unknown>;
    const streamArgs = (mocks.streamSimple.mock.calls[0]?.[2] ?? {}) as Record<string, unknown>;

    expect(generateArgs).not.toHaveProperty("temperature");
    expect(streamArgs).not.toHaveProperty("temperature");
  });

  it("forwards temperature for non-GPT-5 OpenAI models", async () => {
    mocks.completeSimple.mockClear();
    mocks.streamSimple.mockClear();

    await generateTextWithModelId({
      modelId: "openai/gpt-4.1",
      apiKeys: {
        openaiApiKey: "k",
        xaiApiKey: null,
        googleApiKey: null,
        anthropicApiKey: null,
        openrouterApiKey: null,
      },
      prompt: { userText: "hi" },
      temperature: 0.2,
      timeoutMs: 2000,
      fetchImpl: globalThis.fetch.bind(globalThis),
    });

    await streamTextWithModelId({
      modelId: "openai/gpt-4.1",
      apiKeys: {
        openaiApiKey: "k",
        xaiApiKey: null,
        googleApiKey: null,
        anthropicApiKey: null,
        openrouterApiKey: null,
      },
      prompt: { userText: "hi" },
      temperature: 0.2,
      timeoutMs: 2000,
      fetchImpl: globalThis.fetch.bind(globalThis),
    });

    const generateArgs = (mocks.completeSimple.mock.calls[0]?.[2] ?? {}) as Record<string, unknown>;
    const streamArgs = (mocks.streamSimple.mock.calls[0]?.[2] ?? {}) as Record<string, unknown>;

    expect(generateArgs).toMatchObject({ temperature: 0.2 });
    expect(streamArgs).toMatchObject({ temperature: 0.2 });
  });

  it("uses Anthropic document calls for PDF prompts", async () => {
    mocks.completeSimple.mockClear();

    const fetchMock = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          content: [{ type: "text", text: "ok" }],
          usage: { input_tokens: 3, output_tokens: 4 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });

    const pdfBytes = buildMinimalPdf("Hello PDF");
    const result = await generateTextWithModelId({
      modelId: "anthropic/claude-opus-4-5",
      apiKeys: {
        xaiApiKey: null,
        openaiApiKey: null,
        googleApiKey: null,
        anthropicApiKey: "k",
        openrouterApiKey: null,
      },
      prompt: buildDocumentPrompt({
        text: "Summarize the attached PDF.",
        bytes: pdfBytes,
        filename: "test.pdf",
      }),
      timeoutMs: 2000,
      fetchImpl: fetchMock as unknown as typeof fetch,
    });

    expect(result.text).toBe("ok");
    expect(result.usage).toMatchObject({ promptTokens: 3, completionTokens: 4, totalTokens: 7 });
    expect(mocks.completeSimple).toHaveBeenCalledTimes(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const options = fetchMock.mock.calls[0]?.[1] as RequestInit;
    const body = JSON.parse(String(options.body));
    expect(body.model).toBe("claude-opus-4-5");
    expect(body.messages?.[0]?.content?.[0]?.type).toBe("document");
    expect(body.messages?.[0]?.content?.[0]?.source?.media_type).toBe("application/pdf");
    expect(typeof body.messages?.[0]?.content?.[0]?.source?.data).toBe("string");
  });

  it("uses OpenAI responses for PDF prompts", async () => {
    mocks.completeSimple.mockClear();
    process.env.OPENAI_BASE_URL = "";

    const fetchMock = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          output_text: "ok",
          usage: { input_tokens: 2, output_tokens: 3, total_tokens: 5 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });

    const pdfBytes = buildMinimalPdf("Hello PDF");
    const result = await generateTextWithModelId({
      modelId: "openai/gpt-5.2",
      apiKeys: {
        xaiApiKey: null,
        openaiApiKey: "k",
        googleApiKey: null,
        anthropicApiKey: null,
        openrouterApiKey: null,
      },
      prompt: buildDocumentPrompt({
        text: "Summarize the attached PDF.",
        bytes: pdfBytes,
        filename: "test.pdf",
      }),
      timeoutMs: 2000,
      fetchImpl: fetchMock as unknown as typeof fetch,
    });

    expect(result.text).toBe("ok");
    expect(result.usage).toMatchObject({ promptTokens: 2, completionTokens: 3, totalTokens: 5 });
    expect(mocks.completeSimple).toHaveBeenCalledTimes(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const options = fetchMock.mock.calls[0]?.[1] as RequestInit;
    const body = JSON.parse(String(options.body));
    expect(body.model).toBe("gpt-5.2");
    expect(body.input?.[0]?.content?.[0]?.type).toBe("input_file");
    expect(body.input?.[0]?.content?.[0]?.file_data).toMatch(/^data:application\/pdf;base64,/);
  });

  it("retries transient OpenAI PDF response failures", async () => {
    vi.useFakeTimers();
    const randomSpy = vi.spyOn(Math, "random").mockReturnValue(0);
    process.env.OPENAI_BASE_URL = "";
    try {
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ error: { message: "bad gateway" } }), { status: 502 }),
        )
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify({
              output_text: "ok after retry",
              usage: { input_tokens: 2, output_tokens: 3, total_tokens: 5 },
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          ),
        );
      const onRetry = vi.fn();
      const promise = generateTextWithModelId({
        modelId: "openai/gpt-5.2",
        apiKeys: {
          xaiApiKey: null,
          openaiApiKey: "k",
          googleApiKey: null,
          anthropicApiKey: null,
          openrouterApiKey: null,
        },
        prompt: buildDocumentPrompt({
          text: "Summarize the attached PDF.",
          bytes: buildMinimalPdf("Hello PDF"),
          filename: "test.pdf",
        }),
        timeoutMs: 2000,
        fetchImpl: fetchMock as typeof fetch,
        retries: 1,
        onRetry,
      });

      await vi.runOnlyPendingTimersAsync();
      const result = await promise;

      expect(result.text).toBe("ok after retry");
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(onRetry).toHaveBeenCalledWith(expect.objectContaining({ attempt: 1, maxRetries: 1 }));
    } finally {
      randomSpy.mockRestore();
      vi.useRealTimers();
    }
  });

  it("uses Gemini inline data for PDF prompts", async () => {
    mocks.completeSimple.mockClear();

    const fetchMock = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          candidates: [
            {
              content: {
                parts: [{ text: "ok" }],
              },
            },
          ],
          usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 2, totalTokenCount: 3 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });

    const pdfBytes = buildMinimalPdf("Hello PDF");
    const result = await generateTextWithModelId({
      modelId: "google/gemini-3-flash-preview",
      apiKeys: {
        xaiApiKey: null,
        openaiApiKey: null,
        googleApiKey: "k",
        anthropicApiKey: null,
        openrouterApiKey: null,
      },
      prompt: buildDocumentPrompt({
        text: "Summarize the attached PDF.",
        bytes: pdfBytes,
        filename: "test.pdf",
      }),
      timeoutMs: 2000,
      fetchImpl: fetchMock as unknown as typeof fetch,
    });

    expect(result.text).toBe("ok");
    expect(result.usage).toMatchObject({ promptTokens: 1, completionTokens: 2, totalTokens: 3 });
    expect(mocks.completeSimple).toHaveBeenCalledTimes(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const options = fetchMock.mock.calls[0]?.[1] as RequestInit;
    const body = JSON.parse(String(options.body));
    expect(body.contents?.[0]?.parts?.[0]?.inline_data?.mime_type).toBe("application/pdf");
    expect(body.contents?.[0]?.parts?.[0]?.inline_data?.data).toBeTypeOf("string");
  });

  it("routes by provider (streamText) and includes maxOutputTokens when set", async () => {
    mocks.streamSimple.mockClear();
    await streamTextWithModelId({
      modelId: "xai/grok-4-fast-non-reasoning",
      apiKeys: {
        xaiApiKey: "k",
        openaiApiKey: null,
        googleApiKey: null,
        anthropicApiKey: null,
        openrouterApiKey: null,
      },
      prompt: { userText: "hi" },
      timeoutMs: 2000,
      fetchImpl: globalThis.fetch.bind(globalThis),
      maxOutputTokens: 9,
    });
    await streamTextWithModelId({
      modelId: "google/gemini-3-flash-preview",
      apiKeys: {
        xaiApiKey: null,
        openaiApiKey: null,
        googleApiKey: "k",
        anthropicApiKey: null,
        openrouterApiKey: null,
      },
      prompt: { userText: "hi" },
      timeoutMs: 2000,
      fetchImpl: globalThis.fetch.bind(globalThis),
      maxOutputTokens: 9,
    });
    await streamTextWithModelId({
      modelId: "anthropic/claude-opus-4-5",
      apiKeys: {
        xaiApiKey: null,
        openaiApiKey: null,
        googleApiKey: null,
        anthropicApiKey: "k",
        openrouterApiKey: null,
      },
      prompt: { userText: "hi" },
      timeoutMs: 2000,
      fetchImpl: globalThis.fetch.bind(globalThis),
      maxOutputTokens: 9,
    });
    await streamTextWithModelId({
      modelId: "openai/gpt-5.2",
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
      maxOutputTokens: 9,
    });
    expect(mocks.streamSimple).toHaveBeenCalledTimes(4);
    for (const call of mocks.streamSimple.mock.calls) {
      const options = (call?.[2] ?? {}) as Record<string, unknown>;
      expect(options).toHaveProperty("maxTokens", 9);
    }
  });

  it("throws a friendly timeout error on AbortError", async () => {
    mocks.completeSimple.mockImplementationOnce(async () => {
      throw new DOMException("aborted", "AbortError");
    });
    await expect(
      generateTextWithModelId({
        modelId: "openai/gpt-5.2",
        apiKeys: {
          openaiApiKey: "k",
          xaiApiKey: null,
          googleApiKey: null,
          anthropicApiKey: null,
          openrouterApiKey: null,
        },
        prompt: { userText: "hi" },
        timeoutMs: 1,
        fetchImpl: globalThis.fetch.bind(globalThis),
        maxOutputTokens: 10,
      }),
    ).rejects.toThrow(/timed out/i);
  });

  it("retries once when the model returns an empty output", async () => {
    mocks.completeSimple.mockClear();
    mocks.completeSimple.mockImplementationOnce(async () =>
      makeAssistantMessage({ text: "   ", usage: { input: 1, output: 2, totalTokens: 3 } }),
    );
    mocks.completeSimple.mockImplementationOnce(async () =>
      makeAssistantMessage({ text: "ok", usage: { input: 1, output: 2, totalTokens: 3 } }),
    );

    const result = await generateTextWithModelId({
      modelId: "openai/gpt-5.2",
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
    });

    expect(result.text).toBe("ok");
    expect(mocks.completeSimple).toHaveBeenCalledTimes(2);
  });

  it("retries GPT-5-family empty outputs once without maxOutputTokens", async () => {
    delete process.env.OPENAI_BASE_URL;
    const fetchMock = vi
      .fn()
      .mockImplementationOnce(async (_input: RequestInfo | URL, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body)) as { max_output_tokens?: number };
        expect(body.max_output_tokens).toBe(200);
        return new Response(JSON.stringify({ output: [{ content: [{ text: "   " }] }] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      })
      .mockImplementationOnce(async (_input: RequestInfo | URL, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body)) as { max_output_tokens?: number };
        expect(body).not.toHaveProperty("max_output_tokens");
        return new Response(
          JSON.stringify({ output: [{ content: [{ text: "ok without cap" }] }] }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      });

    const result = await generateTextWithModelId({
      modelId: "openai/gpt-5-mini",
      apiKeys: {
        openaiApiKey: "k",
        xaiApiKey: null,
        googleApiKey: null,
        anthropicApiKey: null,
        openrouterApiKey: null,
      },
      prompt: { userText: "hi" },
      timeoutMs: 2000,
      fetchImpl: fetchMock as typeof fetch,
      maxOutputTokens: 200,
    });

    expect(result.text).toBe("ok without cap");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("retries OpenRouter GPT-5-family empty outputs once without maxOutputTokens", async () => {
    delete process.env.OPENAI_BASE_URL;
    const fetchMock = vi
      .fn()
      .mockImplementationOnce(async (_input: RequestInfo | URL, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body)) as { max_tokens?: number };
        expect(body.max_tokens).toBe(200);
        return new Response(
          JSON.stringify({
            choices: [{ message: { content: null } }],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      })
      .mockImplementationOnce(async (_input: RequestInfo | URL, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body)) as { max_tokens?: number };
        expect(body).not.toHaveProperty("max_tokens");
        return new Response(
          JSON.stringify({
            choices: [{ message: { content: "ok from openrouter without cap" } }],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      });

    const result = await generateTextWithModelId({
      modelId: "openai/openai/gpt-5-mini",
      apiKeys: {
        openaiApiKey: null,
        xaiApiKey: null,
        googleApiKey: null,
        anthropicApiKey: null,
        openrouterApiKey: "k",
      },
      prompt: { userText: "hi" },
      timeoutMs: 2000,
      fetchImpl: fetchMock as typeof fetch,
      forceOpenRouter: true,
      maxOutputTokens: 200,
    });

    expect(result.text).toBe("ok from openrouter without cap");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("falls back from empty Google preview responses to google/gemini-2.5-flash", async () => {
    mocks.completeSimple.mockClear();
    mocks.completeSimple.mockImplementationOnce(async (model: MockModel) =>
      makeAssistantMessage({
        provider: "google",
        model: model.id,
        api: "google-generative-ai",
        text: "   ",
        usage: { input: 1, output: 2, totalTokens: 3 },
      }),
    );
    mocks.completeSimple.mockImplementationOnce(async (model: MockModel) =>
      makeAssistantMessage({
        provider: "google",
        model: model.id,
        api: "google-generative-ai",
        text: "ok",
        usage: { input: 1, output: 2, totalTokens: 3 },
      }),
    );

    const result = await generateTextWithModelId({
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
      maxOutputTokens: 10,
    });

    expect(result.text).toBe("ok");
    expect(result.canonicalModelId).toBe("google/gemini-2.5-flash");
    expect((mocks.completeSimple.mock.calls[0]?.[0] as MockModel).id).toBe(
      "gemini-3-flash-preview",
    );
    expect((mocks.completeSimple.mock.calls[1]?.[0] as MockModel).id).toBe("gemini-2.5-flash");
  });

  it("accepts Google thinking-only responses without failing empty-summary", async () => {
    mocks.completeSimple.mockReset();
    mocks.completeSimple.mockImplementation(async (model: MockModel) =>
      makeAssistantMessage({
        provider: model.provider,
        model: model.id,
        api: model.api,
        text: "ok",
        usage: { input: 1, output: 2, totalTokens: 3 },
      }),
    );
    mocks.completeSimple.mockImplementationOnce(async () => ({
      ...makeAssistantMessage({
        provider: "google",
        model: "gemini-3-flash-preview",
        api: "google-generative-ai",
        usage: { input: 1, output: 2, totalTokens: 3 },
      }),
      content: [{ type: "thinking" as const, thinking: "ok from thinking" }],
    }));

    const result = await generateTextWithModelId({
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
      maxOutputTokens: 10,
    });

    expect(result.text.trim().length).toBeGreaterThan(0);
  });

  it("falls back from empty Google preview document responses to google/gemini-2.5-flash", async () => {
    mocks.completeSimple.mockClear();
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      const body = url.includes("models/gemini-3-flash-preview:generateContent")
        ? {
            candidates: [{ content: { parts: [] } }],
            usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 2, totalTokenCount: 3 },
          }
        : {
            candidates: [{ content: { parts: [{ text: "ok from document fallback" }] } }],
            usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 2, totalTokenCount: 3 },
          };
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });

    const pdfBytes = buildMinimalPdf("Hello PDF");
    const result = await generateTextWithModelId({
      modelId: "google/gemini-3-flash-preview",
      apiKeys: {
        xaiApiKey: null,
        openaiApiKey: null,
        googleApiKey: "k",
        anthropicApiKey: null,
        openrouterApiKey: null,
      },
      prompt: buildDocumentPrompt({
        text: "Summarize the attached PDF.",
        bytes: pdfBytes,
        filename: "test.pdf",
      }),
      timeoutMs: 2000,
      fetchImpl: fetchMock as unknown as typeof fetch,
    });

    expect(result.text).toBe("ok from document fallback");
    expect(result.canonicalModelId).toBe("google/gemini-2.5-flash");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain("models/gemini-3-flash-preview");
    expect(String(fetchMock.mock.calls[1]?.[0])).toContain("models/gemini-2.5-flash");
  });

  it("does not replenish retries after a Google document fallback fails", async () => {
    vi.useFakeTimers();
    const randomSpy = vi.spyOn(Math, "random").mockReturnValue(0);
    try {
      const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes("models/gemini-3-flash-preview:generateContent")) {
          return new Response(JSON.stringify({ candidates: [{ content: { parts: [] } }] }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }
        return new Response(JSON.stringify({ error: { message: "unavailable" } }), {
          status: 503,
          headers: { "content-type": "application/json" },
        });
      });
      const promise = generateTextWithModelId({
        modelId: "google/gemini-3-flash-preview",
        apiKeys: {
          xaiApiKey: null,
          openaiApiKey: null,
          googleApiKey: "k",
          anthropicApiKey: null,
          openrouterApiKey: null,
        },
        prompt: buildDocumentPrompt({
          text: "Summarize the attached PDF.",
          bytes: buildMinimalPdf("Hello PDF"),
          filename: "test.pdf",
        }),
        timeoutMs: 2000,
        fetchImpl: fetchMock as typeof fetch,
        retries: 1,
      });

      const rejection = expect(promise).rejects.toThrow(/Google API error \(503\)/);
      await vi.runOnlyPendingTimersAsync();
      await rejection;

      expect(fetchMock).toHaveBeenCalledTimes(3);
      expect(
        fetchMock.mock.calls.filter(([input]) =>
          String(input).includes("models/gemini-3-flash-preview:generateContent"),
        ),
      ).toHaveLength(1);
    } finally {
      randomSpy.mockRestore();
      vi.useRealTimers();
    }
  });

  it("surfaces embedded Google API errors instead of reporting an empty summary", async () => {
    mocks.completeSimple.mockClear();
    mocks.completeSimple.mockImplementationOnce(async () => ({
      role: "assistant",
      content: [],
      api: "google-generative-ai",
      provider: "google",
      model: "gemini-3-flash",
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "error",
      timestamp: Date.now(),
      errorMessage: JSON.stringify({
        error: {
          message: JSON.stringify({
            error: {
              code: 404,
              message:
                "models/gemini-3-flash is not found for API version v1beta, or is not supported for generateContent. Call ListModels to see the list of available models and their supported methods.",
              status: "NOT_FOUND",
            },
          }),
          code: 404,
          status: "Not Found",
        },
      }),
    }));

    await expect(
      generateTextWithModelId({
        modelId: "google/gemini-3-flash",
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
        maxOutputTokens: 10,
      }),
    ).rejects.toThrow(/Google API rejected model "gemini-3-flash"/);
  });

  it("retries transient Google SDK response failures", async () => {
    vi.useFakeTimers();
    const randomSpy = vi.spyOn(Math, "random").mockReturnValue(0);
    mocks.completeSimple.mockClear();
    mocks.completeSimple
      .mockImplementationOnce(async () => ({
        ...makeAssistantMessage({ text: "", provider: "google" }),
        content: [],
        stopReason: "error",
        errorMessage: `got status: UNAVAILABLE. ${JSON.stringify({
          error: {
            code: 503,
            message: "The service is currently unavailable",
            status: "UNAVAILABLE",
          },
        })}`,
      }))
      .mockImplementationOnce(async () =>
        makeAssistantMessage({ text: "recovered", provider: "google" }),
      );

    try {
      const promise = generateTextWithModelId({
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
        retries: 1,
      });

      await vi.runOnlyPendingTimersAsync();
      await expect(promise).resolves.toMatchObject({ text: "recovered" });
      expect(mocks.completeSimple).toHaveBeenCalledTimes(2);
    } finally {
      randomSpy.mockRestore();
    }
  });

  it("retries resolved Google abort results", async () => {
    vi.useFakeTimers();
    const randomSpy = vi.spyOn(Math, "random").mockReturnValue(0);
    mocks.completeSimple.mockClear();
    mocks.completeSimple
      .mockImplementationOnce(async () => ({
        ...makeAssistantMessage({ text: "", provider: "google", stopReason: "aborted" }),
        content: [],
        errorMessage: "Request was aborted",
      }))
      .mockImplementationOnce(async () =>
        makeAssistantMessage({ text: "recovered", provider: "google" }),
      );

    try {
      const promise = generateTextWithModelId({
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

  it("enforces missing-key errors per provider", async () => {
    await expect(
      generateTextWithModelId({
        modelId: "google/gemini-3-flash-preview",
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
    ).rejects.toThrow(/GEMINI_API_KEY/i);

    await expect(
      generateTextWithModelId({
        modelId: "xai/grok-4-fast-non-reasoning",
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
    ).rejects.toThrow(/XAI_API_KEY/i);

    await expect(
      generateTextWithModelId({
        modelId: "anthropic/claude-opus-4-5",
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
    ).rejects.toThrow(/ANTHROPIC_API_KEY/i);
  });

  it("uses chat completions for custom OPENAI_BASE_URL and skips OpenRouter headers", async () => {
    process.env.OPENAI_BASE_URL = "https://openai.example.com/v1";
    mocks.completeSimple.mockClear();

    await generateTextWithModelId({
      modelId: "openai/gpt-5.2",
      apiKeys: {
        openaiApiKey: "openai-key",
        openrouterApiKey: "openrouter-key",
        xaiApiKey: null,
        googleApiKey: null,
        anthropicApiKey: null,
      },
      prompt: { userText: "hi" },
      timeoutMs: 2000,
      fetchImpl: globalThis.fetch.bind(globalThis),
    });

    const model = mocks.completeSimple.mock.calls[0]?.[0] as { baseUrl?: string; api?: string };
    expect(model.baseUrl).toBe("https://openai.example.com/v1");
    expect(model.api).toBe("openai-completions");

    const headers = (
      mocks.completeSimple.mock.calls[0]?.[0] as { headers?: Record<string, string> }
    ).headers;
    expect(headers?.["HTTP-Referer"] ?? null).toBeNull();
  });

  it("adds OpenRouter headers and forces chat completions when OPENROUTER_API_KEY is set", async () => {
    delete process.env.OPENAI_BASE_URL;
    mocks.completeSimple.mockClear();

    await generateTextWithModelId({
      modelId: "openai/openai/gpt-oss-20b",
      apiKeys: {
        openaiApiKey: null,
        openrouterApiKey: "openrouter-key",
        xaiApiKey: null,
        googleApiKey: null,
        anthropicApiKey: null,
      },
      prompt: { userText: "hi" },
      timeoutMs: 2000,
      fetchImpl: globalThis.fetch.bind(globalThis),
    });

    const model = mocks.completeSimple.mock.calls[0]?.[0] as {
      baseUrl?: string;
      api?: string;
      headers?: Record<string, string>;
    };
    expect(model.baseUrl).toBe("https://openrouter.ai/api/v1");
    expect(model.api).toBe("openai-completions");
    expect(model.headers?.["HTTP-Referer"]).toBe("https://github.com/steipete/summarize");
    expect(model.headers?.["X-Title"]).toBe("summarize");
  });

  it("uses the GitHub Models chat-completions endpoint for github-copilot ids", async () => {
    mocks.completeSimple.mockClear();
    const fetchMock = vi
      .fn()
      .mockImplementationOnce(async (_input: RequestInfo | URL, init?: RequestInit) => {
        expect(String(_input)).toBe("https://models.github.ai/inference/chat/completions");
        expect((init?.headers as Record<string, string>)?.Accept).toBe(
          "application/vnd.github+json",
        );
        expect((init?.headers as Record<string, string>)?.["X-GitHub-Api-Version"]).toBe(
          "2026-03-10",
        );
        const body = JSON.parse(String(init?.body)) as {
          model: string;
          messages: Array<{ role: string; content: string }>;
        };
        expect(body.model).toBe("openai/gpt-5.4");
        expect(body.messages.at(-1)).toEqual({ role: "user", content: "hi" });
        return new Response(JSON.stringify({ error: "server error" }), { status: 500 });
      })
      .mockImplementationOnce(async (_input: RequestInfo | URL, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body)) as {
          model: string;
          messages: Array<{ role: string; content: string }>;
        };
        expect(body.model).toBe("openai/gpt-5-chat");
        expect(body.messages.at(-1)).toEqual({ role: "user", content: "hi" });
        return new Response(
          JSON.stringify({
            choices: [{ message: { role: "assistant", content: "ok from github models" } }],
            usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      });

    try {
      vi.stubGlobal("fetch", fetchMock);
      const result = await generateTextWithModelId({
        modelId: "github-copilot/gpt-5.4",
        apiKeys: {
          openaiApiKey: "gh-token",
          openrouterApiKey: null,
          xaiApiKey: null,
          googleApiKey: null,
          anthropicApiKey: null,
        },
        prompt: { userText: "hi" },
        timeoutMs: 2000,
        fetchImpl: fetchMock as typeof fetch,
      });

      expect(result.text).toBe("ok from github models");
      expect(result.canonicalModelId).toBe("github-copilot/openai/gpt-5-chat");
      expect(result.provider).toBe("github-copilot");
      expect(mocks.completeSimple).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("does not forward OpenAI-only request options to GitHub Models", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(_input)).toBe("https://models.github.ai/inference/chat/completions");
      const body = JSON.parse(String(init?.body)) as {
        model: string;
        reasoning_effort?: string;
        service_tier?: string;
        verbosity?: string;
      };
      expect(body.model).toBe("openai/gpt-4.1");
      expect(body).not.toHaveProperty("reasoning_effort");
      expect(body).not.toHaveProperty("service_tier");
      expect(body).not.toHaveProperty("verbosity");
      return new Response(
        JSON.stringify({
          choices: [{ message: { role: "assistant", content: "ok from github models" } }],
          usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });

    try {
      vi.stubGlobal("fetch", fetchMock);
      const result = await generateTextWithModelId({
        modelId: "github-copilot/gpt-4.1",
        apiKeys: {
          openaiApiKey: "gh-token",
          openrouterApiKey: null,
          xaiApiKey: null,
          googleApiKey: null,
          anthropicApiKey: null,
        },
        prompt: { userText: "hi" },
        timeoutMs: 2000,
        fetchImpl: fetchMock as typeof fetch,
        requestOptions: {
          serviceTier: "fast",
          reasoningEffort: "medium",
          textVerbosity: "medium",
        },
      });

      expect(result.text).toBe("ok from github models");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("omits temperature for GitHub Models GPT-5-family ids", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as {
        model: string;
        temperature?: number;
      };
      expect(body.model).toBe("openai/gpt-5");
      expect(body).not.toHaveProperty("temperature");
      return new Response(
        JSON.stringify({
          choices: [{ message: { role: "assistant", content: "ok from gpt-5" } }],
          usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });

    try {
      vi.stubGlobal("fetch", fetchMock);
      const result = await generateTextWithModelId({
        modelId: "github-copilot/gpt-5",
        apiKeys: {
          openaiApiKey: "gh-token",
          openrouterApiKey: null,
          xaiApiKey: null,
          googleApiKey: null,
          anthropicApiKey: null,
        },
        prompt: { userText: "hi" },
        temperature: 0.3,
        timeoutMs: 2000,
        fetchImpl: fetchMock as typeof fetch,
      });

      expect(result.text).toBe("ok from gpt-5");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("applies provider baseUrl overrides (google/xai/zai)", async () => {
    mocks.completeSimple.mockClear();

    await generateTextWithModelId({
      modelId: "google/gemini-3-flash-preview",
      apiKeys: {
        openaiApiKey: null,
        openrouterApiKey: null,
        xaiApiKey: null,
        googleApiKey: "k",
        anthropicApiKey: null,
      },
      prompt: { userText: "hi" },
      timeoutMs: 2000,
      fetchImpl: globalThis.fetch.bind(globalThis),
      googleBaseUrlOverride: "https://google-proxy.example.com",
    });

    const googleModel = mocks.completeSimple.mock.calls[0]?.[0] as { baseUrl?: string };
    expect(googleModel.baseUrl).toBe("https://google-proxy.example.com");

    mocks.completeSimple.mockClear();
    await generateTextWithModelId({
      modelId: "xai/grok-4-fast-non-reasoning",
      apiKeys: {
        openaiApiKey: null,
        openrouterApiKey: null,
        xaiApiKey: "k",
        googleApiKey: null,
        anthropicApiKey: null,
      },
      prompt: { userText: "hi" },
      timeoutMs: 2000,
      fetchImpl: globalThis.fetch.bind(globalThis),
      xaiBaseUrlOverride: "https://xai-proxy.example.com/v1",
    });

    const xaiModel = mocks.completeSimple.mock.calls[0]?.[0] as { baseUrl?: string };
    expect(xaiModel.baseUrl).toBe("https://xai-proxy.example.com/v1");

    mocks.completeSimple.mockClear();
    await generateTextWithModelId({
      modelId: "zai/glm-4.7",
      apiKeys: {
        openaiApiKey: "k",
        openrouterApiKey: null,
        xaiApiKey: null,
        googleApiKey: null,
        anthropicApiKey: null,
      },
      prompt: { userText: "hi" },
      timeoutMs: 2000,
      fetchImpl: globalThis.fetch.bind(globalThis),
      openaiBaseUrlOverride: "https://zai-proxy.example.com/v4",
    });

    const zaiModel = mocks.completeSimple.mock.calls[0]?.[0] as { baseUrl?: string };
    expect(zaiModel.baseUrl).toBe("https://zai-proxy.example.com/v4");
  });

  it("routes MiniMax generate and stream calls with separated reasoning", async () => {
    mocks.completeSimple.mockClear();
    mocks.streamSimple.mockClear();

    const args = {
      modelId: "minimax/MiniMax-M3",
      apiKeys: {
        openaiApiKey: "minimax-key",
        openrouterApiKey: null,
        xaiApiKey: null,
        googleApiKey: null,
        anthropicApiKey: null,
      },
      prompt: { userText: "hi" },
      timeoutMs: 2000,
      fetchImpl: globalThis.fetch.bind(globalThis),
      openaiBaseUrlOverride: "https://minimax-proxy.example.com/v1",
    } as const;

    const result = await generateTextWithModelId(args);
    const streamResult = await streamTextWithModelId(args);

    expect(result.provider).toBe("minimax");
    expect(streamResult.provider).toBe("minimax");

    for (const call of [mocks.completeSimple.mock.calls[0], mocks.streamSimple.mock.calls[0]]) {
      const model = call?.[0] as MockModel & { baseUrl?: string };
      const options = (call?.[2] ?? {}) as {
        apiKey?: string;
        onPayload?: (payload: unknown) => unknown;
      };
      expect(model).toMatchObject({
        provider: "minimax",
        api: "openai-completions",
        baseUrl: "https://minimax-proxy.example.com/v1",
      });
      expect(options.apiKey).toBe("minimax-key");
      expect(await Promise.resolve(options.onPayload?.({ stream: true }))).toEqual({
        stream: true,
        reasoning_split: true,
      });
    }
  });

  it("wraps anthropic model access errors with a helpful message", async () => {
    mocks.completeSimple.mockImplementationOnce(async () => {
      const error = Object.assign(new Error("model: claude-3-5-sonnet-latest"), {
        statusCode: 404,
        responseBody: JSON.stringify({
          type: "error",
          error: { type: "not_found_error", message: "model: claude-3-5-sonnet-latest" },
        }),
      });
      throw error;
    });

    await expect(
      generateTextWithModelId({
        modelId: "anthropic/claude-3-5-sonnet-latest",
        apiKeys: {
          xaiApiKey: null,
          openaiApiKey: null,
          googleApiKey: null,
          anthropicApiKey: "k",
          openrouterApiKey: null,
        },
        prompt: { userText: "hi" },
        timeoutMs: 2000,
        fetchImpl: globalThis.fetch.bind(globalThis),
        maxOutputTokens: 10,
      }),
    ).rejects.toThrow(/Anthropic API rejected model "claude-3-5-sonnet-latest"/i);

    mocks.streamSimple.mockImplementationOnce(() => {
      const error = Object.assign(new Error("model: claude-3-5-sonnet-latest"), {
        statusCode: 403,
        responseBody: JSON.stringify({
          type: "error",
          error: { type: "permission_error", message: "model: claude-3-5-sonnet-latest" },
        }),
      });
      throw error;
    });

    await expect(
      streamTextWithModelId({
        modelId: "anthropic/claude-3-5-sonnet-latest",
        apiKeys: {
          xaiApiKey: null,
          openaiApiKey: null,
          googleApiKey: null,
          anthropicApiKey: "k",
          openrouterApiKey: null,
        },
        prompt: { userText: "hi" },
        timeoutMs: 2000,
        fetchImpl: globalThis.fetch.bind(globalThis),
        maxOutputTokens: 10,
      }),
    ).rejects.toThrow(/Anthropic API rejected model "claude-3-5-sonnet-latest"/i);
  });

  it("streams OpenAI Responses when request options are set", async () => {
    delete process.env.OPENAI_BASE_URL;
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const event of [
          { type: "response.output_text.delta", delta: "He" },
          { type: "response.output_text.delta", delta: "llo" },
          {
            type: "response.completed",
            response: { usage: { input_tokens: 3, output_tokens: 4, total_tokens: 7 } },
          },
        ]) {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
        }
        controller.close();
      },
    });
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(_input)).toBe("https://api.openai.com/v1/responses");
      const requestBody = JSON.parse(String(init?.body)) as {
        model: string;
        stream?: boolean;
        service_tier?: string;
        reasoning?: { effort?: string };
        text?: { verbosity?: string };
      };
      expect(requestBody.model).toBe("gpt-5.5");
      expect(requestBody.stream).toBe(true);
      expect(requestBody.service_tier).toBe("priority");
      expect(requestBody.reasoning?.effort).toBe("medium");
      expect(requestBody.text?.verbosity).toBe("low");
      return new Response(body, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    });

    const result = await streamTextWithModelId({
      modelId: "openai/gpt-5.5",
      apiKeys: {
        openaiApiKey: "k",
        xaiApiKey: null,
        googleApiKey: null,
        anthropicApiKey: null,
        openrouterApiKey: null,
      },
      prompt: { userText: "hi" },
      timeoutMs: 2000,
      fetchImpl: fetchMock as typeof fetch,
      requestOptions: {
        serviceTier: "fast",
        reasoningEffort: "medium",
        textVerbosity: "low",
      },
    });

    const chunks: string[] = [];
    for await (const delta of result.textStream) chunks.push(delta);

    expect(chunks).toEqual(["He", "llo"]);
    expect(result.canonicalModelId).toBe("openai/gpt-5.5");
    await expect(result.finalText).resolves.toBe("Hello");
    await expect(result.usage).resolves.toEqual({
      promptTokens: 3,
      completionTokens: 4,
      totalTokens: 7,
    });
    expect(mocks.streamSimple).not.toHaveBeenCalled();
    expect(mocks.completeSimple).not.toHaveBeenCalled();
  });

  it("times out when OpenAI Responses streaming stalls before headers", async () => {
    vi.useFakeTimers();
    delete process.env.OPENAI_BASE_URL;
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(_input)).toBe("https://api.openai.com/v1/responses");
      expect((init?.signal as AbortSignal | undefined)?.aborted).toBe(false);
      await new Promise(() => {});
      return new Response(null);
    });

    const resultPromise = streamTextWithModelId({
      modelId: "openai/gpt-5.5",
      apiKeys: {
        openaiApiKey: "k",
        xaiApiKey: null,
        googleApiKey: null,
        anthropicApiKey: null,
        openrouterApiKey: null,
      },
      prompt: { userText: "hi" },
      timeoutMs: 5,
      fetchImpl: fetchMock as typeof fetch,
      requestOptions: {
        serviceTier: "fast",
      },
    });

    const rejection = expect(resultPromise).rejects.toThrow(/timed out/i);
    await vi.advanceTimersByTimeAsync(5);
    await rejection;
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("throws a friendly timeout error on AbortError (streamText)", async () => {
    mocks.streamSimple.mockImplementationOnce(() => {
      throw new DOMException("aborted", "AbortError");
    });
    await expect(
      streamTextWithModelId({
        modelId: "openai/gpt-5.2",
        apiKeys: {
          openaiApiKey: "k",
          xaiApiKey: null,
          googleApiKey: null,
          anthropicApiKey: null,
          openrouterApiKey: null,
        },
        prompt: { userText: "hi" },
        timeoutMs: 1,
        fetchImpl: globalThis.fetch.bind(globalThis),
        maxOutputTokens: 10,
      }),
    ).rejects.toThrow(/timed out/i);
  });

  it("times out when a stream stalls before yielding", async () => {
    vi.useFakeTimers();
    mocks.streamSimple.mockImplementationOnce(() => ({
      async *[Symbol.asyncIterator]() {
        await new Promise(() => {});
      },
      result: async () => makeAssistantMessage({ text: "ok" }),
    }));
    const result = await streamTextWithModelId({
      modelId: "openai/gpt-5.2",
      apiKeys: {
        openaiApiKey: "k",
        xaiApiKey: null,
        googleApiKey: null,
        anthropicApiKey: null,
        openrouterApiKey: null,
      },
      prompt: { userText: "hi" },
      timeoutMs: 5,
      fetchImpl: globalThis.fetch.bind(globalThis),
      maxOutputTokens: 10,
    });
    const iterator = result.textStream[Symbol.asyncIterator]();
    const nextPromise = iterator.next();
    const rejection = expect(nextPromise).rejects.toThrow(/timed out/i);
    await vi.advanceTimersByTimeAsync(5);
    await rejection;
  });

  it("resolves stream usage as null when stream.result() never settles", async () => {
    vi.useFakeTimers();
    const finalMessage = makeAssistantMessage({ text: "ok" });
    mocks.streamSimple.mockImplementationOnce(() => ({
      async *[Symbol.asyncIterator]() {
        yield {
          type: "text_delta" as const,
          contentIndex: 0,
          delta: "ok",
          partial: finalMessage,
        };
        yield {
          type: "done" as const,
          reason: "stop" as const,
          message: finalMessage,
        };
      },
      async result() {
        await new Promise(() => {});
      },
    }));

    const result = await streamTextWithModelId({
      modelId: "openai/gpt-5.2",
      apiKeys: {
        openaiApiKey: "k",
        xaiApiKey: null,
        googleApiKey: null,
        anthropicApiKey: null,
        openrouterApiKey: null,
      },
      prompt: { userText: "hi" },
      timeoutMs: 20,
      fetchImpl: globalThis.fetch.bind(globalThis),
      maxOutputTokens: 10,
    });

    let streamed = "";
    for await (const delta of result.textStream) streamed += delta;
    expect(streamed).toBe("ok");
    await vi.advanceTimersByTimeAsync(20);
    await expect(result.usage).resolves.toBeNull();
  });
});
