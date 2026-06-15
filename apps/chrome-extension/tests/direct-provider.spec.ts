import { expect, test } from "@playwright/test";
import {
  completeDirectText,
  resolveDirectModel,
  streamDirectModel,
} from "../src/lib/direct-provider";
import type { DirectProvider, ProviderSettings } from "../src/lib/settings";

function providerSettings(
  provider: DirectProvider,
  baseUrl = "https://provider.test",
): ProviderSettings {
  return {
    provider,
    apiKeys: { [provider]: "test-key" },
    baseUrls: { [provider]: baseUrl },
  };
}

function sseResponse(blocks: string[]): Response {
  return new Response(blocks.join(""), {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

async function finalAssistant(options: Parameters<typeof streamDirectModel>[0]) {
  let assistant = null;
  for await (const event of streamDirectModel(options)) {
    if (event.type === "assistant") assistant = event.assistant;
  }
  if (!assistant) throw new Error("Missing assistant event");
  return assistant;
}

test("direct provider resolves all supported gateways", () => {
  const providers: DirectProvider[] = [
    "openai",
    "openrouter",
    "anthropic",
    "google",
    "xai",
    "zai",
    "nvidia",
    "minimax",
    "github",
    "ollama",
  ];
  for (const provider of providers) {
    const resolved = resolveDirectModel("auto", providerSettings(provider));
    expect(resolved.provider).toBe(provider);
    expect(resolved.model).not.toBe("");
    expect(resolved.baseUrl).toBe("https://provider.test");
  }
});

test("direct provider routes the Free preset exclusively through OpenRouter", () => {
  const resolved = resolveDirectModel("free", {
    provider: "openai",
    apiKeys: {
      openai: "openai-key",
      openrouter: "openrouter-key",
    },
    baseUrls: {},
  });

  expect(resolved.provider).toBe("openrouter");
  expect(resolved.model).toBe("openrouter/free");
  expect(resolved.apiKey).toBe("openrouter-key");
});

test("direct provider requires an OpenRouter key for the Free preset", () => {
  expect(() =>
    resolveDirectModel("free", {
      provider: "openai",
      apiKeys: { openai: "openai-key" },
      baseUrls: {},
    }),
  ).toThrow("Add an API key for OpenRouter");
});

test("direct provider Auto does not fall back to an unselected stored key", () => {
  expect(() =>
    resolveDirectModel("auto", {
      provider: "openai",
      apiKeys: { anthropic: "anthropic-key" },
      baseUrls: {},
    }),
  ).toThrow("Add an API key for OpenAI");
});

test("direct provider parses OpenAI-compatible streaming text", async () => {
  const requests: Array<{ url: string; body: Record<string, unknown> }> = [];
  const result = await completeDirectText({
    model: "openai/test-model",
    providerSettings: providerSettings("openai"),
    system: "System",
    prompt: "Prompt",
    signal: new AbortController().signal,
    fetchImpl: async (input, init) => {
      requests.push({
        url: String(input),
        body: JSON.parse(String(init?.body)) as Record<string, unknown>,
      });
      return sseResponse([
        `data: ${JSON.stringify({ choices: [{ delta: { content: "Hello " } }] })}\n\n`,
        `data: ${JSON.stringify({ choices: [{ delta: { content: "world" } }] })}\n\n`,
        "data: [DONE]\n\n",
      ]);
    },
  });

  expect(result.text).toBe("Hello world");
  expect(requests[0]?.url).toBe("https://provider.test/chat/completions");
  expect(requests[0]?.body.model).toBe("test-model");
});

test("direct provider parses Anthropic streaming text", async () => {
  const result = await completeDirectText({
    model: "anthropic/test-model",
    providerSettings: providerSettings("anthropic"),
    system: "System",
    prompt: "Prompt",
    signal: new AbortController().signal,
    fetchImpl: async () =>
      sseResponse([
        `event: content_block_delta\ndata: ${JSON.stringify({
          index: 0,
          delta: { type: "text_delta", text: "Anthropic " },
        })}\n\n`,
        `event: content_block_delta\ndata: ${JSON.stringify({
          index: 0,
          delta: { type: "text_delta", text: "works" },
        })}\n\n`,
        "event: message_stop\ndata: {}\n\n",
      ]),
  });

  expect(result.text).toBe("Anthropic works");
});

test("direct provider parses Gemini streaming text", async () => {
  const result = await completeDirectText({
    model: "google/test-model",
    providerSettings: providerSettings("google"),
    system: "System",
    prompt: "Prompt",
    signal: new AbortController().signal,
    fetchImpl: async () =>
      sseResponse([
        `data: ${JSON.stringify({
          candidates: [{ content: { parts: [{ text: "Gemini " }] } }],
        })}\n\n`,
        `data: ${JSON.stringify({
          candidates: [{ content: { parts: [{ text: "works" }] } }],
        })}\n\n`,
      ]),
  });

  expect(result.text).toBe("Gemini works");
});

test("direct provider accepts CRLF SSE framing and OpenAI tool calls", async () => {
  const assistant = await finalAssistant({
    model: "openai/test-model",
    providerSettings: providerSettings("openai"),
    system: "System",
    messages: [{ role: "user", content: "Use a tool", timestamp: Date.now() }],
    signal: new AbortController().signal,
    fetchImpl: async () =>
      sseResponse([
        `data: ${JSON.stringify({
          choices: [
            {
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: "call-1",
                    function: { name: "navigate", arguments: '{"url":' },
                  },
                ],
              },
            },
          ],
        })}\r\n\r\n`,
        `data: ${JSON.stringify({
          choices: [
            {
              delta: {
                tool_calls: [{ index: 0, function: { arguments: '"https://example.com"}' } }],
              },
            },
          ],
        })}\r\n\r\n`,
        "data: [DONE]\r\n\r\n",
      ]),
  });

  expect(assistant.content).toContainEqual({
    type: "toolCall",
    id: "call-1",
    name: "navigate",
    arguments: { url: "https://example.com" },
  });
});

test("direct provider parses Anthropic tool calls", async () => {
  const assistant = await finalAssistant({
    model: "anthropic/test-model",
    providerSettings: providerSettings("anthropic"),
    system: "System",
    messages: [{ role: "user", content: "Use a tool", timestamp: Date.now() }],
    signal: new AbortController().signal,
    fetchImpl: async () =>
      sseResponse([
        `event: content_block_start\ndata: ${JSON.stringify({
          index: 0,
          content_block: { type: "tool_use", id: "tool-1", name: "repl", input: {} },
        })}\n\n`,
        `event: content_block_delta\ndata: ${JSON.stringify({
          index: 0,
          delta: { type: "input_json_delta", partial_json: '{"code":"2 + 2"}' },
        })}\n\n`,
        "event: message_stop\ndata: {}\n\n",
      ]),
  });

  expect(assistant.content).toContainEqual({
    type: "toolCall",
    id: "tool-1",
    name: "repl",
    arguments: { code: "2 + 2" },
  });
});

test("direct provider parses Gemini tool calls", async () => {
  const assistant = await finalAssistant({
    model: "google/test-model",
    providerSettings: providerSettings("google"),
    system: "System",
    messages: [{ role: "user", content: "Use a tool", timestamp: Date.now() }],
    signal: new AbortController().signal,
    fetchImpl: async () =>
      sseResponse([
        `data: ${JSON.stringify({
          candidates: [
            {
              content: {
                parts: [
                  {
                    functionCall: {
                      name: "summarize",
                      args: { url: "https://example.com" },
                    },
                  },
                ],
              },
            },
          ],
        })}\n\n`,
      ]),
  });

  expect(assistant.content).toEqual([
    expect.objectContaining({
      type: "toolCall",
      name: "summarize",
      arguments: { url: "https://example.com" },
    }),
  ]);
});
