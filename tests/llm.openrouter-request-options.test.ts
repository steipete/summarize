import { afterEach, describe, expect, it, vi } from "vitest";
import { generateTextWithModelId, streamTextWithModelId } from "../src/llm/generate-text.js";
import { completeOpenAiText } from "../src/llm/providers/openai.js";

const mocks = vi.hoisted(() => ({
  completeSimple: vi.fn(() => {
    throw new Error("Unexpected SDK fallback");
  }),
  streamSimple: vi.fn(() => {
    throw new Error("Unexpected SDK fallback");
  }),
}));

vi.mock("@earendil-works/pi-ai/compat", () => mocks);

const openRouterKeys = {
  openaiApiKey: null,
  openrouterApiKey: "router-key",
  googleApiKey: null,
  anthropicApiKey: null,
  xaiApiKey: null,
};

function mockChatResponse(stream: boolean) {
  return vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => {
    const body = stream
      ? [
          `data: ${JSON.stringify({ choices: [{ delta: { content: "Summary" }, finish_reason: "stop" }] })}`,
          `data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 } })}`,
          "data: [DONE]",
          "",
        ].join("\n\n")
      : JSON.stringify({
          choices: [{ message: { content: "Summary" } }],
          usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 },
        });
    return new Response(body, {
      headers: { "content-type": stream ? "text/event-stream" : "application/json" },
    });
  });
}

function readRequest(fetchImpl: ReturnType<typeof mockChatResponse>) {
  expect(fetchImpl).toHaveBeenCalledTimes(1);
  const [url, init] = fetchImpl.mock.calls[0];
  return { url: String(url), body: JSON.parse(String(init?.body)) as Record<string, unknown> };
}

afterEach(() => {
  vi.clearAllMocks();
});

describe("OpenRouter Chat Completions request options", () => {
  it("sends an uncapped completion without forcing reasoning", async () => {
    const fetchImpl = mockChatResponse(false);
    const result = await generateTextWithModelId({
      modelId: "openai/meta-llama/llama-3.3-70b-instruct",
      apiKeys: openRouterKeys,
      prompt: { userText: "Summarize this page" },
      timeoutMs: 2000,
      fetchImpl,
    });

    expect(result.text).toBe("Summary");
    expect(result.usage).toEqual({ promptTokens: 2, completionTokens: 3, totalTokens: 5 });
    const { url, body } = readRequest(fetchImpl);
    expect(url).toBe("https://openrouter.ai/api/v1/chat/completions");
    expect(body).toMatchObject({
      model: "meta-llama/llama-3.3-70b-instruct",
      messages: [{ role: "user", content: "Summarize this page" }],
    });
    expect(body).not.toHaveProperty("max_tokens");
    expect(body).not.toHaveProperty("reasoning");
    expect(body).not.toHaveProperty("reasoning_effort");
  });

  it("preserves an explicit cap and maps thinking to OpenRouter reasoning", async () => {
    const fetchImpl = mockChatResponse(false);
    await generateTextWithModelId({
      modelId: "openai/meta-llama/llama-3.3-70b-instruct",
      apiKeys: openRouterKeys,
      prompt: { userText: "Summarize this page" },
      maxOutputTokens: 96_000,
      requestOptions: { reasoningEffort: "high" },
      timeoutMs: 2000,
      fetchImpl,
    });

    const { body } = readRequest(fetchImpl);
    expect(body.max_tokens).toBe(96_000);
    expect(body.reasoning).toEqual({ effort: "high" });
    expect(body).not.toHaveProperty("reasoning_effort");
  });

  it("rejects partial completion text for an OpenRouter error finish reason", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () =>
      Response.json({
        choices: [{ message: { content: "Partial" }, finish_reason: "content_filter" }],
      }),
    );

    await expect(
      generateTextWithModelId({
        modelId: "openai/meta-llama/llama-3.3-70b-instruct",
        apiKeys: openRouterKeys,
        prompt: { userText: "Summarize this page" },
        timeoutMs: 2000,
        fetchImpl,
      }),
    ).rejects.toThrow("Provider finish_reason: content_filter");
  });

  it("streams uncapped OpenRouter text through the direct transport", async () => {
    const fetchImpl = mockChatResponse(true);
    const result = await streamTextWithModelId({
      modelId: "openai/meta-llama/llama-3.3-70b-instruct",
      apiKeys: openRouterKeys,
      prompt: { userText: "Summarize this page" },
      timeoutMs: 2000,
      fetchImpl,
    });
    let text = "";
    for await (const delta of result.textStream) text += delta;

    expect(text).toBe("Summary");
    expect(await result.usage).toEqual({ promptTokens: 2, completionTokens: 3, totalTokens: 5 });
    const { url, body } = readRequest(fetchImpl);
    expect(url).toBe("https://openrouter.ai/api/v1/chat/completions");
    expect(body.stream).toBe(true);
    expect(body).not.toHaveProperty("max_tokens");
    expect(body).not.toHaveProperty("reasoning");
    expect(body).not.toHaveProperty("reasoning_effort");
  });

  it("streams an explicit cap and thinking through OpenRouter fields", async () => {
    const fetchImpl = mockChatResponse(true);
    const result = await streamTextWithModelId({
      modelId: "openai/meta-llama/llama-3.3-70b-instruct",
      apiKeys: openRouterKeys,
      prompt: { userText: "Summarize this page" },
      maxOutputTokens: 96_000,
      requestOptions: { reasoningEffort: "high" },
      timeoutMs: 2000,
      fetchImpl,
    });
    let text = "";
    for await (const delta of result.textStream) text += delta;
    expect(text).toBe("Summary");

    const { body } = readRequest(fetchImpl);
    expect(body.max_tokens).toBe(96_000);
    expect(body.reasoning).toEqual({ effort: "high" });
    expect(body).not.toHaveProperty("reasoning_effort");
  });

  it("keeps a custom OpenAI-compatible gateway on the existing fallback", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    await expect(
      generateTextWithModelId({
        modelId: "openai/meta-llama/llama-3.3-70b-instruct",
        apiKeys: { ...openRouterKeys, openrouterApiKey: null, openaiApiKey: "openai-key" },
        openaiBaseUrlOverride: "https://gateway.example/v1",
        prompt: { userText: "Summarize this page" },
        timeoutMs: 2000,
        fetchImpl,
      }),
    ).rejects.toThrow("Unexpected SDK fallback");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("preserves OpenRouter provider diagnostics in HTTP errors", async () => {
    const fetchImpl = vi.fn<typeof fetch>(
      async () =>
        new Response(
          JSON.stringify({ error: { message: "Rate limit exceeded: free-models-per-min" } }),
          { status: 429, headers: { "content-type": "application/json" } },
        ),
    );

    await expect(
      generateTextWithModelId({
        modelId: "openai/meta-llama/llama-3.3-70b-instruct",
        apiKeys: openRouterKeys,
        prompt: { userText: "Summarize this page" },
        timeoutMs: 2000,
        fetchImpl,
      }),
    ).rejects.toMatchObject({
      message: expect.stringContaining("Rate limit exceeded: free-models-per-min"),
      statusCode: 429,
      responseBody: JSON.stringify({
        error: { message: "Rate limit exceeded: free-models-per-min" },
      }),
    });
  });

  it.each(["", "not-json"])(
    "keeps malformed or empty OpenRouter diagnostics generic (%j)",
    async (body) => {
      const fetchImpl = vi.fn<typeof fetch>(async () => new Response(body, { status: 429 }));
      await expect(
        completeOpenAiText({
          modelId: "meta-llama/llama-3.3-70b-instruct",
          openaiConfig: {
            apiKey: "router-key",
            baseURL: "https://openrouter.ai/api/v1",
            useChatCompletions: true,
            isOpenRouter: true,
          },
          context: { systemPrompt: null, messages: [{ role: "user", content: "hi" }] },
          signal: new AbortController().signal,
          fetchImpl,
        }),
      ).rejects.toMatchObject({
        message: "OpenAI API error (429).",
        statusCode: 429,
        responseBody: body,
      });
    },
  );

  it("keeps ordinary OpenAI error messages unchanged", async () => {
    const body = JSON.stringify({ error: { message: "Rate limit exceeded: provider" } });
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response(body, { status: 429 }));
    await expect(
      completeOpenAiText({
        modelId: "gpt-5.5",
        openaiConfig: {
          apiKey: "openai-key",
          baseURL: "https://api.openai.com/v1",
          useChatCompletions: false,
          isOpenRouter: false,
        },
        context: { systemPrompt: null, messages: [{ role: "user", content: "hi" }] },
        signal: new AbortController().signal,
        fetchImpl,
      }),
    ).rejects.toMatchObject({
      message: "OpenAI API error (429).",
      statusCode: 429,
      responseBody: body,
    });
  });
});
