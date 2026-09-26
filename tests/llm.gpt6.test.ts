import { afterEach, describe, expect, it, vi } from "vitest";
import {
  isRetryableLlmError,
  resolveEffectiveTemperature,
} from "../src/llm/generate-text-shared.js";
import { generateTextWithModelId, streamTextWithModelId } from "../src/llm/generate-text.js";
import type { ModelRequestOptions } from "../src/llm/model-options.js";
import { isOpenAiResponsesTextModelId } from "../src/llm/providers/openai/request-options.js";
import { buildMinimalPdf } from "./helpers/pdf.js";

const mocks = vi.hoisted(() => ({
  completeSimple: vi.fn(() => {
    throw new Error("Unexpected SDK fallback");
  }),
  streamSimple: vi.fn(() => {
    throw new Error("Unexpected SDK fallback");
  }),
  getModel: vi.fn(() => {
    throw new Error("No catalog entry");
  }),
}));
vi.mock("@earendil-works/pi-ai/compat", () => mocks);

const models = ["gpt-6-astra", "gpt-6-sol", "gpt-6-luna"];
const apiKeys = {
  openaiApiKey: "test-key",
  openrouterApiKey: null,
  googleApiKey: null,
  anthropicApiKey: null,
  xaiApiKey: null,
};
const requestOptions: ModelRequestOptions = { reasoningEffort: "medium", serviceTier: "fast" };
const usage = { input_tokens: 2, output_tokens: 3, total_tokens: 5 };

function mockResponse(stream: boolean, chat = false) {
  return vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => {
    const payload = stream
      ? chat
        ? 'data: {"choices":[{"delta":{"content":"Summary"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n'
        : 'data: {"type":"response.output_text.delta","delta":"Summary"}\n\ndata: {"type":"response.completed","response":{"usage":{"input_tokens":2,"output_tokens":3,"total_tokens":5}}}\n\n'
      : JSON.stringify(
          chat
            ? { choices: [{ message: { content: "Summary" } }], usage }
            : { output_text: "Summary", usage },
        );
    return new Response(payload, {
      headers: { "content-type": stream ? "text/event-stream" : "application/json" },
    });
  });
}

function readRequest(fetchImpl: ReturnType<typeof mockResponse>) {
  expect(fetchImpl).toHaveBeenCalledTimes(1);
  const [url, init] = fetchImpl.mock.calls[0];
  return { url: String(url), body: JSON.parse(String(init?.body)) };
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

it.each([false, true])("rejects Astra none before any API request (stream=%s)", async (stream) => {
  const fetchImpl = mockResponse(stream);
  const generate = stream ? streamTextWithModelId : generateTextWithModelId;
  await expect(
    generate({
      modelId: "openai/gpt-6-astra",
      apiKeys,
      prompt: { userText: "Summarize this page" },
      timeoutMs: 2000,
      fetchImpl,
      requestOptions: { reasoningEffort: "none" },
    }),
  ).rejects.toThrow(/Astra requires reasoning.*--thinking none/);
  expect(fetchImpl).not.toHaveBeenCalled();
});

describe.each(models)("%s requests", (model) => {
  it.each([undefined, requestOptions])(
    "uses Responses without temperature (options=%j)",
    async (options) => {
      const fetchImpl = mockResponse(false);
      const result = await generateTextWithModelId({
        modelId: `openai/${model}`,
        apiKeys,
        prompt: { userText: "Summarize this page" },
        temperature: 0.3,
        maxOutputTokens: 2000,
        timeoutMs: 2000,
        fetchImpl,
        openaiBaseUrlOverride: "https://api.openai.com/v1",
        requestOptions: options,
      });
      expect(result.text).toBe("Summary");
      expect(result.canonicalModelId).toBe(`openai/${model}`);
      const { url, body } = readRequest(fetchImpl);
      expect(url).toBe("https://api.openai.com/v1/responses");
      expect(body.model).toBe(model);
      expect(body.store).toBe(false);
      expect(body).not.toHaveProperty("temperature");
      expect(body.max_output_tokens).toBe(2000);
      expect(body.reasoning).toEqual(options ? { effort: "medium" } : undefined);
      expect(body.service_tier).toBe(options ? "priority" : undefined);
    },
  );

  it.each([undefined, requestOptions])(
    "streams text and images through Responses (options=%j)",
    async (options) => {
      const fetchImpl = mockResponse(true);
      const result = await streamTextWithModelId({
        modelId: `openai/${model}`,
        apiKeys,
        prompt: {
          userText: "Describe",
          attachments: [
            { kind: "image", mediaType: "image/png", bytes: new Uint8Array([1, 2, 3]) },
          ],
        },
        temperature: 0.3,
        timeoutMs: 2000,
        fetchImpl,
        openaiBaseUrlOverride: "https://api.openai.com/v1",
        requestOptions: options,
      });
      let text = "";
      for await (const delta of result.textStream) text += delta;
      expect(text).toBe("Summary");
      expect(await result.finalText).toBe("Summary");
      expect(await result.usage).toEqual({ promptTokens: 2, completionTokens: 3, totalTokens: 5 });
      expect(result.lastError()).toBeNull();
      const { url, body } = readRequest(fetchImpl);
      expect(url).toBe("https://api.openai.com/v1/responses");
      expect(body).toMatchObject({ model, stream: true, store: false });
      expect(body).not.toHaveProperty("temperature");
      expect(body.input[0].content).toContainEqual({
        type: "input_image",
        image_url: "data:image/png;base64,AQID",
        detail: "auto",
      });
      expect(body.reasoning).toEqual(options ? { effort: "medium" } : undefined);
      expect(body.service_tier).toBe(options ? "priority" : undefined);
    },
  );

  it("omits temperature from PDF requests and preserves reasoning and fast mode", async () => {
    const fetchImpl = mockResponse(false);
    await generateTextWithModelId({
      modelId: `openai/${model}`,
      apiKeys,
      prompt: {
        userText: "Summarize",
        attachments: [
          {
            kind: "document",
            mediaType: "application/pdf",
            filename: "sample.pdf",
            bytes: buildMinimalPdf("Hello"),
          },
        ],
      },
      temperature: 0.3,
      timeoutMs: 2000,
      fetchImpl,
      openaiBaseUrlOverride: "https://api.openai.com/v1",
      requestOptions,
    });
    const { url, body } = readRequest(fetchImpl);
    expect(url).toBe("https://api.openai.com/v1/responses");
    expect(body).toMatchObject({
      model,
      reasoning: { effort: "medium" },
      service_tier: "priority",
      store: false,
    });
    expect(body).not.toHaveProperty("temperature");
    expect(body.input[0].content[0]).toMatchObject({ type: "input_file", filename: "sample.pdf" });
  });

  it.each([
    [false, undefined],
    [true, undefined],
    [false, requestOptions],
    [true, requestOptions],
  ] as const)(
    "preserves explicit Chat Completions (stream=%s, options=%j)",
    async (stream, options) => {
      const fetchImpl = mockResponse(stream, true);
      const args = {
        modelId: `openai/${model}`,
        apiKeys,
        prompt: { userText: "Summarize" },
        temperature: 0.3,
        maxOutputTokens: 2000,
        timeoutMs: 2000,
        fetchImpl,
        openaiBaseUrlOverride: "https://api.openai.com/v1",
        forceChatCompletions: true,
        requestOptions: options,
      };
      if (stream) {
        const result = await streamTextWithModelId(args);
        let text = "";
        for await (const delta of result.textStream) text += delta;
        expect(text).toBe("Summary");
      } else {
        expect((await generateTextWithModelId(args)).text).toBe("Summary");
      }
      const { url, body } = readRequest(fetchImpl);
      expect(url).toBe("https://api.openai.com/v1/chat/completions");
      expect(body).toMatchObject({
        model,
        max_completion_tokens: 2000,
      });
      expect(body).not.toHaveProperty("temperature");
      expect(body).not.toHaveProperty("max_tokens");
      expect(body.reasoning_effort).toBe(options ? "medium" : undefined);
      expect(body.service_tier).toBe(options ? "priority" : undefined);
    },
  );
});

describe("GPT-6 Chat stream endings", () => {
  async function streamChat(events: unknown[], done = true) {
    const payload =
      events.map((event) => "data: " + JSON.stringify(event) + "\n\n").join("") +
      (done ? "data: [DONE]\n\n" : "");
    return streamTextWithModelId({
      modelId: "openai/gpt-6-astra",
      apiKeys,
      prompt: { userText: "Summarize" },
      forceChatCompletions: true,
      timeoutMs: 2000,
      openaiBaseUrlOverride: "https://api.openai.com/v1",
      fetchImpl: vi.fn(async () => new Response(payload)),
    });
  }
  async function consume(stream: AsyncIterable<string>) {
    let text = "";
    for await (const delta of stream) text += delta;
    return text;
  }
  it.each([false, true])("rejects a missing finish reason (DONE=%s)", async (done) => {
    const result = await streamChat([{ choices: [{ delta: { content: "Partial" } }] }], done);
    await expect(consume(result.textStream)).rejects.toThrow("stream ended without finish_reason");
    expect(isRetryableLlmError(result.lastError())).toBe(true);
    expect(await result.usage).toBeNull();
  });
  it.each(["network_error", "content_filter", "unexpected"])(
    "rejects %s finish reasons",
    async (reason) => {
      const result = await streamChat([
        { choices: [{ delta: { content: "Partial" }, finish_reason: reason }] },
      ]);
      await expect(consume(result.textStream)).rejects.toThrow("Provider finish_reason: " + reason);
      expect(result.lastError()).toBeInstanceOf(Error);
      expect(isRetryableLlmError(result.lastError())).toBe(reason === "network_error");
    },
  );
  it.each(["stop", "length"])("retains usage after a %s finish event", async (reason) => {
    const result = await streamChat([
      { choices: [{ delta: { content: "Summary" }, finish_reason: reason }] },
      { choices: [], usage: { prompt_tokens: 20, completion_tokens: 100, total_tokens: 120 } },
    ]);
    expect(await consume(result.textStream)).toBe("Summary");
    expect(await result.usage).toEqual({
      promptTokens: 20,
      completionTokens: 100,
      totalTokens: 120,
    });
    expect(result.lastError()).toBeNull();
  });
});

describe("GPT-6 model boundaries", () => {
  it("preserves OpenRouter model ids and token-cap spelling", async () => {
    const fetchImpl = mockResponse(false, true);
    await generateTextWithModelId({
      modelId: "openai/openai/gpt-6-astra",
      apiKeys,
      prompt: { userText: "Summarize" },
      forceOpenRouter: true,
      temperature: 0.3,
      maxOutputTokens: 2000,
      timeoutMs: 2000,
      fetchImpl,
    });
    const { url, body } = readRequest(fetchImpl);
    expect(url).toBe("https://openrouter.ai/api/v1/chat/completions");
    expect(body).toMatchObject({ model: "openai/gpt-6-astra", max_tokens: 2000 });
    expect(body).not.toHaveProperty("max_completion_tokens");
    expect(body).not.toHaveProperty("temperature");
  });
  it.each(["https://gateway.example/v1", "https://openrouter.ai/api/v1"])(
    "keeps SDK streaming for %s without explicit options",
    async (baseURL) => {
      await expect(
        streamTextWithModelId({
          modelId: "openai/gpt-6-astra",
          apiKeys,
          prompt: { userText: "Summarize" },
          openaiBaseUrlOverride: baseURL,
          temperature: 0.3,
          timeoutMs: 2000,
          fetchImpl: mockResponse(true),
        }),
      ).rejects.toThrow("Unexpected SDK fallback");
      expect(mocks.streamSimple).toHaveBeenCalledTimes(1);
      expect(mocks.completeSimple).not.toHaveBeenCalled();
    },
  );
  it.each(["", "data: [DONE]\n\n"])(
    "rejects Responses EOF before a terminal event (%j)",
    async (ending) => {
      const result = await streamTextWithModelId({
        modelId: "openai/gpt-6-astra",
        apiKeys,
        prompt: { userText: "Summarize" },
        timeoutMs: 2000,
        openaiBaseUrlOverride: "https://api.openai.com/v1",
        fetchImpl: vi.fn(
          async () =>
            new Response(
              'data: {"type":"response.output_text.delta","delta":"Partial"}\n\n' + ending,
            ),
        ),
      });
      await expect(
        (async () => {
          for await (const _delta of result.textStream) {
            /* consume */
          }
        })(),
      ).rejects.toThrow("stream ended before a terminal response event");
      expect(isRetryableLlmError(result.lastError())).toBe(true);
      expect(await result.usage).toBeNull();
    },
  );
  it("retains usage for a Responses output-token limit", async () => {
    const result = await streamTextWithModelId({
      modelId: "openai/gpt-6-astra",
      apiKeys,
      prompt: { userText: "Summarize" },
      maxOutputTokens: 100,
      timeoutMs: 2000,
      openaiBaseUrlOverride: "https://api.openai.com/v1",
      fetchImpl: vi.fn(
        async () =>
          new Response(
            'data: {"type":"response.output_text.delta","delta":"Partial"}\n\ndata: {"type":"response.incomplete","response":{"incomplete_details":{"reason":"max_output_tokens"},"usage":{"input_tokens":20,"output_tokens":100,"total_tokens":120}}}\n\n',
          ),
      ),
    });
    let text = "";
    for await (const delta of result.textStream) text += delta;
    expect(text).toBe("Partial");
    expect(result.lastError()).toBeNull();
    expect(await result.usage).toEqual({
      promptTokens: 20,
      completionTokens: 100,
      totalTokens: 120,
    });
  });
  it.each(["gpt-6-sol", "gpt-6-luna"])(
    "preserves temperature for %s with reasoning disabled",
    async (model) => {
      for (const stream of [false, true]) {
        const fetchImpl = mockResponse(stream);
        const args = {
          modelId: `openai/${model}`,
          apiKeys,
          prompt: { userText: "Summarize" },
          temperature: 0.3,
          timeoutMs: 2000,
          fetchImpl,
          openaiBaseUrlOverride: "https://api.openai.com/v1",
          requestOptions: { reasoningEffort: "none" as const },
        };
        if (stream) {
          const result = await streamTextWithModelId(args);
          for await (const _delta of result.textStream) {
            /* consume */
          }
        } else {
          await generateTextWithModelId(args);
        }
        expect(readRequest(fetchImpl).body).toMatchObject({
          temperature: 0.3,
          reasoning: { effort: "none" },
        });
      }
    },
  );
  it("never enables Astra temperature, including an unsupported none effort", () => {
    expect(
      resolveEffectiveTemperature({
        provider: "openai",
        model: "gpt-6-astra",
        temperature: 0.3,
        reasoningEffort: "none",
      }),
    ).toBeUndefined();
  });
  it.each(models)("recognizes only the documented model %s", (model) => {
    expect(isOpenAiResponsesTextModelId(model)).toBe(true);
    expect(isOpenAiResponsesTextModelId(`openai/${model}`)).toBe(true);
    expect(
      resolveEffectiveTemperature({ provider: "openai", model, temperature: 0.3 }),
    ).toBeUndefined();
  });
  it.each([
    "gpt-6",
    "gpt-6-mini",
    "gpt-6-astra-extra",
    "gpt-60",
    "gpt-4.1",
    "gpt-5-chat",
    "anthropic/gpt-6-astra",
  ])("does not opt %s into Responses", (model) => {
    expect(isOpenAiResponsesTextModelId(model)).toBe(false);
  });
  it("does not change unrelated provider temperature or GPT-5 routing", () => {
    expect(
      resolveEffectiveTemperature({ provider: "ollama", model: "gpt-6-astra", temperature: 0.3 }),
    ).toBe(0.3);
    expect(
      resolveEffectiveTemperature({ provider: "openai", model: "gpt-4.1", temperature: 0.3 }),
    ).toBe(0.3);
    expect(isOpenAiResponsesTextModelId("gpt-5.5")).toBe(true);
  });
});
