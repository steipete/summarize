import type { Context } from "@earendil-works/pi-ai";
import { describe, expect, it, vi } from "vitest";
import { isRetryableLlmError } from "../src/llm/generate-text-shared.js";
import {
  completeOpenAiChatText,
  streamOpenAiChatText,
} from "../src/llm/providers/openai/chat-completions.js";

const context = {
  systemPrompt: " system ",
  messages: [{ role: "user", content: " hello " }],
} as Context;

function request(fetchImpl: typeof fetch) {
  return {
    modelId: "gpt-test",
    openaiConfig: {
      apiKey: "key",
      baseURL: "https://api.example.test",
      isOpenRouter: false,
      requestOptions: {
        reasoningEffort: "high" as const,
        serviceTier: "flex" as const,
        textVerbosity: "low" as const,
      },
    },
    context,
    temperature: 0,
    maxOutputTokens: 100,
    signal: new AbortController().signal,
    fetchImpl,
  };
}

describe("OpenAI chat-completions coverage", () => {
  it("posts completion options and parses string or content-block text", async () => {
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      expect(body).toMatchObject({
        model: "gpt-test",
        max_tokens: 100,
        temperature: 0,
        reasoning_effort: "high",
        service_tier: "flex",
        verbosity: "low",
      });
      return new Response(
        JSON.stringify({
          choices: [{ message: { content: [{ text: " block " }, null, {}, { text: "text " }] } }],
          usage: { input_tokens: 1, output_tokens: 2, total_tokens: 3 },
        }),
      );
    }) as typeof fetch;
    await expect(completeOpenAiChatText(request(fetchImpl))).resolves.toEqual({
      text: "block text",
      usage: { promptTokens: 1, completionTokens: 2, totalTokens: 3 },
      resolvedModelId: "gpt-test",
    });

    const stringFetch = vi.fn(async () =>
      Response.json({ choices: [{ message: { content: " string result " } }] }),
    ) as typeof fetch;
    await expect(
      completeOpenAiChatText({
        ...request(stringFetch),
        temperature: undefined,
        maxOutputTokens: undefined,
      }),
    ).resolves.toMatchObject({ text: "string result" });
  });

  it("reports HTTP and empty completion failures", async () => {
    const errorFetch = vi.fn(async () => new Response("bad", { status: 500 })) as typeof fetch;
    await expect(completeOpenAiChatText(request(errorFetch))).rejects.toThrow("OpenAI API error");
    const emptyFetch = vi.fn(async () =>
      Response.json({ choices: [{ message: { content: [null, {}, { text: " " }] } }] }),
    ) as typeof fetch;
    await expect(completeOpenAiChatText(request(emptyFetch))).rejects.toThrow("empty summary");
  });

  it.each([false, true])(
    "resolves usage when streaming ends (early close: %s)",
    async (earlyClose) => {
      const textEvent = `data: ${JSON.stringify({ choices: [{ delta: { content: "one" } }] })}\n\n`;
      const usageEvent = `data: ${JSON.stringify({ choices: [null], usage: { input_tokens: 2, output_tokens: 3, total_tokens: 5 } })}\n\n`;
      const events = earlyClose ? [usageEvent, textEvent] : [textEvent, usageEvent];
      const response = new Response(events.join("") + "data: [DONE]\n\n");
      const fetchImpl = vi.fn(async () => response) as typeof fetch;
      const result = await streamOpenAiChatText(request(fetchImpl));
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
    },
  );

  it("handles stream HTTP, missing-body, structured, and generic errors", async () => {
    const errorFetch = vi.fn(async () => new Response("bad", { status: 429 })) as typeof fetch;
    await expect(streamOpenAiChatText(request(errorFetch))).rejects.toThrow("OpenAI API error");

    const missingBodyFetch = vi.fn(
      async () => ({ ok: true, body: null }) as unknown as Response,
    ) as typeof fetch;
    await expect(streamOpenAiChatText(request(missingBodyFetch))).rejects.toThrow(
      "stream response was empty",
    );

    for (const { error, message, retryable } of [
      { error: { message: "specific failure" }, message: "specific failure", retryable: false },
      {
        error: { code: "server_error", message: "The server had an error" },
        message: "The server had an error",
        retryable: true,
      },
      { error: "bad", message: "stream failed", retryable: false },
    ]) {
      const fetchImpl = vi.fn(
        async () =>
          new Response(`data: ${JSON.stringify({ error })}\n\n`, {
            headers: { "content-type": "text/event-stream" },
          }),
      ) as typeof fetch;
      const result = await streamOpenAiChatText(request(fetchImpl));
      const caught = await (async () => {
        try {
          for await (const _chunk of result.textStream) {
            // consume
          }
        } catch (streamError) {
          return streamError;
        }
        throw new Error("Expected stream failure");
      })();
      expect(caught).toMatchObject({ message: expect.stringContaining(message) });
      expect(isRetryableLlmError(caught)).toBe(retryable);
      await expect(result.usage).resolves.toBeNull();
    }
  });
});
