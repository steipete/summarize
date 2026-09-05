import type { Context } from "@earendil-works/pi-ai";
import { describe, expect, it, vi } from "vitest";
import { isRetryableLlmError } from "../src/llm/generate-text-shared.js";
import {
  completeOpenAiDocument,
  completeOpenAiResponsesText,
  streamOpenAiResponsesText,
} from "../src/llm/providers/openai/responses.js";

const context = {
  systemPrompt: " system ",
  messages: [{ role: "user", content: "hello" }],
} as Context;

const config = {
  apiKey: "key",
  baseURL: "https://api.openai.com/v1",
  isOpenRouter: false,
  requestOptions: { reasoningEffort: "high" as const },
};

function request(fetchImpl: typeof fetch) {
  return {
    modelId: "gpt-5",
    openaiConfig: config,
    context,
    temperature: 0,
    maxOutputTokens: 100,
    signal: new AbortController().signal,
    fetchImpl,
  };
}

describe("OpenAI Responses coverage", () => {
  it("parses output text, content blocks, request options, HTTP errors, and empty output", async () => {
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      expect(body).toMatchObject({
        model: "gpt-5",
        instructions: "system",
        max_output_tokens: 100,
        temperature: 0,
        reasoning: { effort: "high" },
      });
      return Response.json({
        output: [{ content: [{ text: " block " }, {}, { text: "text " }] }],
        usage: { input_tokens: 1, output_tokens: 2, total_tokens: 3 },
      });
    }) as typeof fetch;
    await expect(
      completeOpenAiResponsesText({
        ...request(fetchImpl),
        structuredOutput: { name: "result", schema: { type: "object" } },
      }),
    ).resolves.toEqual({
      text: "block text",
      usage: { promptTokens: 1, completionTokens: 2, totalTokens: 3 },
      resolvedModelId: "gpt-5",
    });
    await expect(
      completeOpenAiResponsesText({
        ...request(vi.fn(async () => Response.json({ output_text: " direct " })) as typeof fetch),
        temperature: undefined,
        maxOutputTokens: undefined,
      }),
    ).resolves.toMatchObject({ text: "direct" });
    await expect(
      completeOpenAiResponsesText({
        ...request(vi.fn(async () => new Response("bad", { status: 500 })) as typeof fetch),
      }),
    ).rejects.toThrow("OpenAI API error");
    await expect(
      completeOpenAiResponsesText({
        ...request(
          vi.fn(async () => Response.json({ output: [{}, { content: [] }] })) as typeof fetch,
        ),
      }),
    ).rejects.toThrow("empty summary");
  });

  it.each([false, true])(
    "streams deltas and usage with failures (early close: %s)",
    async (earlyClose) => {
      const stream = [
        `data: ${JSON.stringify({ type: "response.output_text.delta", delta: "one" })}\n\n`,
        `data: ${JSON.stringify({ type: "response.completed", response: { usage: { input_tokens: 2, output_tokens: 3 } } })}\n\n`,
      ];
      if (earlyClose) stream.reverse();
      const response = new Response(stream.join(""));
      const result = await streamOpenAiResponsesText(
        request(vi.fn(async () => response) as typeof fetch),
      );
      const chunks: string[] = [];
      for await (const chunk of result.textStream) {
        chunks.push(chunk);
        if (earlyClose) break;
      }
      expect(chunks).toEqual(["one"]);
      expect(response.body?.locked).toBe(false);
      await expect(result.usage).resolves.toEqual({
        promptTokens: 2,
        completionTokens: 3,
        totalTokens: 5,
      });

      await expect(
        streamOpenAiResponsesText(
          request(vi.fn(async () => new Response("bad", { status: 500 })) as typeof fetch),
        ),
      ).rejects.toThrow("OpenAI API error");
      await expect(
        streamOpenAiResponsesText(
          request(vi.fn(async () => ({ ok: true, body: null }) as Response) as typeof fetch),
        ),
      ).rejects.toThrow("stream response was empty");

      for (const { event, message, retryable } of [
        {
          event: {
            type: "response.failed",
            response: { error: { code: "server_error", message: "specific" } },
          },
          message: "specific",
          retryable: true,
        },
        {
          event: { type: "error", code: "rate_limit_exceeded", message: "slow down" },
          message: "slow down",
          retryable: true,
        },
        {
          event: { type: "error", error: "bad" },
          message: "stream failed",
          retryable: false,
        },
      ]) {
        const failed = await streamOpenAiResponsesText(
          request(
            vi.fn(async () => new Response(`data: ${JSON.stringify(event)}\n\n`)) as typeof fetch,
          ),
        );
        const error = await (async () => {
          try {
            for await (const _chunk of failed.textStream) {
              // consume
            }
          } catch (caught) {
            return caught;
          }
          throw new Error("Expected stream failure");
        })();
        expect(error).toMatchObject({ message: expect.stringContaining(message) });
        expect(isRetryableLlmError(error)).toBe(retryable);
        await expect(failed.usage).resolves.toBeNull();
      }
    },
  );

  it("validates and completes PDF document requests", async () => {
    const base = {
      modelId: "gpt-5",
      openaiConfig: { ...config, extraHeaders: { authorization: "override", "X-Extra": "value" } },
      promptText: "summarize",
      maxOutputTokens: 100,
      temperature: 0,
      timeoutMs: 1_000,
      fetchImpl: vi.fn(async (_input, init) => {
        expect(init?.headers).toEqual({
          "content-type": "application/json",
          authorization: "Bearer key",
        });
        return Response.json({
          output_text: "document result",
          usage: { input_tokens: 1, output_tokens: 2 },
        });
      }) as typeof fetch,
    };
    await expect(
      completeOpenAiDocument({
        ...base,
        document: { kind: "document", mediaType: "application/pdf", bytes: new Uint8Array([1]) },
      }),
    ).resolves.toEqual({
      text: "document result",
      usage: { promptTokens: 1, completionTokens: 2, totalTokens: 3 },
    });
    await expect(
      completeOpenAiDocument({
        ...base,
        document: { kind: "image", mediaType: "image/png", bytes: new Uint8Array() },
      }),
    ).rejects.toThrow("expected a document");
    await expect(
      completeOpenAiDocument({
        ...base,
        openaiConfig: { ...config, isOpenRouter: true },
        document: { kind: "document", mediaType: "application/pdf", bytes: new Uint8Array() },
      }),
    ).rejects.toThrow("OpenRouter");
    await expect(
      completeOpenAiDocument({
        ...base,
        openaiConfig: { ...config, baseURL: "https://example.test/v1" },
        document: { kind: "document", mediaType: "application/pdf", bytes: new Uint8Array() },
      }),
    ).rejects.toThrow("api.openai.com");
  });
});
