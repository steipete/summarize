import { describe, expect, it, vi } from "vitest";
import { buildMinimalPdf } from "./helpers/pdf.js";

const mocks = vi.hoisted(() => ({
  completeSimple: vi.fn(),
}));

vi.mock("@earendil-works/pi-ai/compat", () => ({
  completeSimple: mocks.completeSimple,
}));

import {
  completeOpenAiDocument,
  completeOpenAiText,
  resolveOpenAiClientConfig,
} from "../src/llm/providers/openai.js";

describe("openai provider helpers", () => {
  it("resolves openrouter config from keys and forced mode", () => {
    expect(
      resolveOpenAiClientConfig({
        apiKeys: {
          openaiApiKey: null,
          openrouterApiKey: "or-key",
        },
      }),
    ).toEqual({
      apiKey: "or-key",
      baseURL: "https://openrouter.ai/api/v1",
      useChatCompletions: true,
      isOpenRouter: true,
    });

    expect(
      resolveOpenAiClientConfig({
        apiKeys: {
          openaiApiKey: "oa-key",
          openrouterApiKey: null,
        },
        forceOpenRouter: true,
      }),
    ).toEqual({
      apiKey: "oa-key",
      baseURL: "https://openrouter.ai/api/v1",
      useChatCompletions: true,
      isOpenRouter: true,
    });

    expect(
      resolveOpenAiClientConfig({
        apiKeys: {
          openaiApiKey: "oa-key",
          openrouterApiKey: null,
        },
        forceOpenRouter: true,
        forceChatCompletions: false,
      }),
    ).toEqual({
      apiKey: "oa-key",
      baseURL: "https://openrouter.ai/api/v1",
      useChatCompletions: true,
      isOpenRouter: true,
    });
  });

  it("handles custom and invalid base URLs", () => {
    expect(
      resolveOpenAiClientConfig({
        apiKeys: {
          openaiApiKey: "oa-key",
          openrouterApiKey: null,
        },
        openaiBaseUrlOverride: "https://gateway.example/v1",
      }),
    ).toEqual({
      apiKey: "oa-key",
      baseURL: "https://gateway.example/v1",
      useChatCompletions: true,
      isOpenRouter: false,
    });

    expect(
      resolveOpenAiClientConfig({
        apiKeys: {
          openaiApiKey: "oa-key",
          openrouterApiKey: null,
        },
        openaiBaseUrlOverride: "not a url",
      }),
    ).toEqual({
      apiKey: "oa-key",
      baseURL: "not a url",
      useChatCompletions: false,
      isOpenRouter: false,
    });
  });

  it("respects forceChatCompletions=false for custom base URLs", () => {
    expect(
      resolveOpenAiClientConfig({
        apiKeys: {
          openaiApiKey: "oa-key",
          openrouterApiKey: null,
        },
        openaiBaseUrlOverride: "https://gateway.example/v1",
        forceChatCompletions: false,
      }),
    ).toEqual({
      apiKey: "oa-key",
      baseURL: "https://gateway.example/v1",
      useChatCompletions: false,
      isOpenRouter: false,
    });
  });

  it("raises missing key errors for OpenAI and OpenRouter modes", () => {
    expect(() =>
      resolveOpenAiClientConfig({
        apiKeys: {
          openaiApiKey: null,
          openrouterApiKey: null,
        },
      }),
    ).toThrow(/Missing OPENAI_API_KEY/);

    expect(() =>
      resolveOpenAiClientConfig({
        apiKeys: {
          openaiApiKey: null,
          openrouterApiKey: null,
        },
        forceOpenRouter: true,
      }),
    ).toThrow(/Missing OPENROUTER_API_KEY/);
  });

  it("builds OpenAI document response URLs for /responses, /v1, and root bases", async () => {
    const pdfBytes = buildMinimalPdf("Hello PDF");
    const fetchMock = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          output: [{ content: [{ text: "ok" }] }],
          usage: { input_tokens: 1, output_tokens: 2, total_tokens: 3 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });

    const promptText = "Summarize";
    const document = {
      kind: "document" as const,
      bytes: pdfBytes,
      filename: "test.pdf",
      mediaType: "application/pdf",
    };

    for (const baseURL of [
      "https://api.openai.com/responses",
      "https://api.openai.com/v1",
      "https://api.openai.com",
    ]) {
      const result = await completeOpenAiDocument({
        modelId: "gpt-5.2",
        openaiConfig: {
          apiKey: "oa-key",
          baseURL,
          useChatCompletions: true,
          isOpenRouter: false,
        },
        promptText,
        document,
        timeoutMs: 2000,
        fetchImpl: fetchMock as unknown as typeof fetch,
      });

      expect(result.text).toBe("ok");
    }

    expect(fetchMock.mock.calls.map((call) => String(call[0]))).toEqual([
      "https://api.openai.com/responses",
      "https://api.openai.com/v1/responses",
      "https://api.openai.com/v1/responses",
    ]);
  });

  it("rejects unsupported document attachment backends", async () => {
    const pdfBytes = buildMinimalPdf("Hello PDF");
    const document = {
      kind: "document" as const,
      bytes: pdfBytes,
      filename: "test.pdf",
      mediaType: "application/pdf",
    };

    await expect(
      completeOpenAiDocument({
        modelId: "gpt-5.2",
        openaiConfig: {
          apiKey: "oa-key",
          baseURL: "https://openrouter.ai/api/v1",
          useChatCompletions: true,
          isOpenRouter: true,
        },
        promptText: "Summarize",
        document,
        timeoutMs: 2000,
        fetchImpl: globalThis.fetch.bind(globalThis),
      }),
    ).rejects.toThrow(/OpenRouter does not support PDF attachments/);

    await expect(
      completeOpenAiDocument({
        modelId: "gpt-5.2",
        openaiConfig: {
          apiKey: "oa-key",
          baseURL: "https://gateway.example/v1",
          useChatCompletions: true,
          isOpenRouter: false,
        },
        promptText: "Summarize",
        document,
        timeoutMs: 2000,
        fetchImpl: globalThis.fetch.bind(globalThis),
      }),
    ).rejects.toThrow(/Document attachments require api.openai.com/);
  });

  it("rejects non-document attachments for the document API", async () => {
    await expect(
      completeOpenAiDocument({
        modelId: "gpt-5.2",
        openaiConfig: {
          apiKey: "oa-key",
          baseURL: "https://api.openai.com/v1",
          useChatCompletions: true,
          isOpenRouter: false,
        },
        promptText: "Summarize",
        document: {
          kind: "image",
          bytes: new Uint8Array([1, 2, 3]),
          filename: "test.png",
          mediaType: "image/png",
        },
        timeoutMs: 2000,
        fetchImpl: globalThis.fetch.bind(globalThis),
      }),
    ).rejects.toThrow(/expected a document attachment/);
  });

  it("surfaces document API failures and empty document outputs", async () => {
    const pdfBytes = buildMinimalPdf("Hello PDF");
    const document = {
      kind: "document" as const,
      bytes: pdfBytes,
      filename: "test.pdf",
      mediaType: "application/pdf",
    };

    await expect(
      completeOpenAiDocument({
        modelId: "gpt-5.2",
        openaiConfig: {
          apiKey: "oa-key",
          baseURL: "https://api.openai.com/v1",
          useChatCompletions: true,
          isOpenRouter: false,
        },
        promptText: "Summarize",
        document,
        timeoutMs: 2000,
        fetchImpl: (async () =>
          new Response(JSON.stringify({ error: "boom" }), { status: 500 })) as typeof fetch,
      }),
    ).rejects.toThrow(/OpenAI API error \(500\)/);

    await expect(
      completeOpenAiDocument({
        modelId: "gpt-5.2",
        openaiConfig: {
          apiKey: "oa-key",
          baseURL: "https://api.openai.com/v1",
          useChatCompletions: true,
          isOpenRouter: false,
        },
        promptText: "Summarize",
        document,
        timeoutMs: 2000,
        fetchImpl: (async () =>
          new Response(JSON.stringify({ output: [{ content: [{ text: "   " }] }] }), {
            status: 200,
          })) as typeof fetch,
      }),
    ).rejects.toThrow(/empty summary/);
  });

  it("uses the Responses API for OpenAI GPT-5-family text models", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe("https://api.openai.com/v1/responses");
      const body = JSON.parse(String(init?.body)) as {
        model: string;
        instructions?: string;
        input: Array<{ role: string; content: Array<{ type: string; text: string }> }>;
      };
      expect(body.model).toBe("gpt-5.4");
      expect(body.instructions).toBe("system");
      expect(body.input).toEqual([
        { role: "user", content: [{ type: "input_text", text: "hello" }] },
        { role: "assistant", content: [{ type: "input_text", text: "seen" }] },
      ]);
      return new Response(
        JSON.stringify({
          output: [{ content: [{ text: "Hello from responses" }] }],
          usage: { input_tokens: 1, output_tokens: 2, total_tokens: 3 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });

    const result = await completeOpenAiText({
      modelId: "gpt-5.4",
      openaiConfig: {
        apiKey: "oa-key",
        baseURL: "https://api.openai.com/v1",
        useChatCompletions: false,
        isOpenRouter: false,
      },
      context: {
        systemPrompt: "system",
        messages: [
          { role: "user", content: "hello" },
          { role: "assistant", content: [{ type: "text", text: "seen" }] },
        ],
      },
      signal: new AbortController().signal,
      fetchImpl: fetchMock as typeof fetch,
    });

    expect(result.text).toBe("Hello from responses");
    expect(result.resolvedModelId).toBe("gpt-5.4");
  });

  it("forwards OpenAI Responses request options", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as {
        service_tier?: string;
        reasoning?: { effort?: string };
        text?: { verbosity?: string };
      };
      expect(body.service_tier).toBe("priority");
      expect(body.reasoning?.effort).toBe("medium");
      expect(body.text?.verbosity).toBe("low");
      return new Response(JSON.stringify({ output_text: "ok" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });

    const result = await completeOpenAiText({
      modelId: "gpt-5.5",
      openaiConfig: {
        apiKey: "oa-key",
        baseURL: "https://api.openai.com/v1",
        useChatCompletions: false,
        isOpenRouter: false,
        requestOptions: {
          serviceTier: "fast",
          reasoningEffort: "medium",
          textVerbosity: "low",
        },
      },
      context: {
        systemPrompt: null,
        messages: [{ role: "user", content: "hello" }],
      },
      signal: new AbortController().signal,
      fetchImpl: fetchMock as typeof fetch,
    });

    expect(result.text).toBe("ok");
  });

  it("requests strict structured output through the Responses API", async () => {
    const schema = {
      type: "object",
      additionalProperties: false,
      properties: { name: { type: "string" } },
      required: ["name"],
    };
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe("https://api.openai.com/v1/responses");
      const body = JSON.parse(String(init?.body)) as {
        text?: {
          verbosity?: string;
          format?: {
            type?: string;
            name?: string;
            strict?: boolean;
            schema?: unknown;
          };
        };
      };
      expect(body.text).toEqual({
        verbosity: "low",
        format: {
          type: "json_schema",
          name: "person",
          strict: true,
          schema,
        },
      });
      return new Response(JSON.stringify({ output_text: '{"name":"Chris Williamson"}' }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });

    const result = await completeOpenAiText({
      modelId: "gpt-5.5",
      openaiConfig: {
        apiKey: "oa-key",
        baseURL: "https://api.openai.com/v1",
        useChatCompletions: true,
        isOpenRouter: false,
        requestOptions: { textVerbosity: "low" },
      },
      context: {
        systemPrompt: "Return a person.",
        messages: [{ role: "user", content: "Who is speaking?" }],
      },
      signal: new AbortController().signal,
      fetchImpl: fetchMock as typeof fetch,
      structuredOutput: { name: "person", schema },
    });

    expect(result.text).toBe('{"name":"Chris Williamson"}');
  });

  it("forwards OpenAI Chat Completions request options", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as {
        service_tier?: string;
        reasoning_effort?: string;
        verbosity?: string;
      };
      expect(body.service_tier).toBe("priority");
      expect(body.reasoning_effort).toBe("low");
      expect(body.verbosity).toBe("high");
      return new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });

    const result = await completeOpenAiText({
      modelId: "gpt-5.5",
      openaiConfig: {
        apiKey: "oa-key",
        baseURL: "https://api.openai.com/v1",
        useChatCompletions: true,
        isOpenRouter: false,
        requestOptions: {
          serviceTier: "fast",
          reasoningEffort: "low",
          textVerbosity: "high",
        },
      },
      context: {
        systemPrompt: null,
        messages: [{ role: "user", content: "hello" }],
      },
      signal: new AbortController().signal,
      fetchImpl: fetchMock as typeof fetch,
    });

    expect(result.text).toBe("ok");
  });

  it("uses chat completions directly for OpenRouter GPT-5-family text models", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe("https://openrouter.ai/api/v1/chat/completions");
      expect((init?.headers as Record<string, string>)?.["HTTP-Referer"]).toBe(
        "https://github.com/steipete/summarize",
      );
      expect((init?.headers as Record<string, string>)?.["X-Title"]).toBe("summarize");
      const body = JSON.parse(String(init?.body)) as {
        model: string;
        messages: Array<{ role: string; content: string }>;
      };
      expect(body.model).toBe("openai/gpt-5-mini");
      expect(body.messages).toEqual([{ role: "user", content: "hello" }]);
      return new Response(
        JSON.stringify({
          choices: [{ message: { content: "Hello from OpenRouter" } }],
          usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });

    const result = await completeOpenAiText({
      modelId: "openai/gpt-5-mini",
      openaiConfig: {
        apiKey: "or-key",
        baseURL: "https://openrouter.ai/api/v1",
        useChatCompletions: true,
        isOpenRouter: true,
      },
      context: {
        systemPrompt: null,
        messages: [{ role: "user", content: "hello" }],
      },
      signal: new AbortController().signal,
      fetchImpl: fetchMock as typeof fetch,
    });

    expect(result.text).toBe("Hello from OpenRouter");
    expect(result.resolvedModelId).toBe("openai/gpt-5-mini");
  });
});
