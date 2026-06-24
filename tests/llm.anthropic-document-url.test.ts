import { describe, expect, it, vi } from "vitest";

// completeAnthropicDocument posts a base64 PDF document block to the Anthropic
// Messages API. The request URL must be built by JOINING `/v1/messages` onto the
// (optionally overridden) base URL so that a path prefix on a custom
// Anthropic-compatible gateway is preserved. Using `new URL("/v1/messages", base)`
// treats the path as root-relative and silently drops any prefix, so a gateway at
// `https://host/anthropic` would wrongly POST to `https://host/v1/messages` (404/400).

const docInput = {
  kind: "document" as const,
  mediaType: "application/pdf" as const,
  bytes: new Uint8Array([1, 2, 3]),
  filename: "test.pdf",
};

function mockOkFetch(captured: string[]) {
  return vi.fn(async (url: string) => {
    captured.push(String(url));
    return {
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify({
          content: [{ type: "text", text: "Summary result" }],
          usage: { input_tokens: 10, output_tokens: 5 },
        }),
    } as unknown as Response;
  });
}

describe("completeAnthropicDocument request URL", () => {
  it("preserves a path prefix on a custom gateway base URL", async () => {
    const captured: string[] = [];
    const { completeAnthropicDocument } = await import("../src/llm/providers/anthropic.js");

    await completeAnthropicDocument({
      modelId: "claude-opus-4-x",
      apiKey: "test-key",
      promptText: "Summarize this document",
      document: docInput,
      maxOutputTokens: 256,
      timeoutMs: 30000,
      fetchImpl: mockOkFetch(captured) as unknown as typeof fetch,
      anthropicBaseUrlOverride: "https://gateway.example/anthropic",
    });

    expect(captured.length).toBe(1);
    expect(captured[0]).toBe("https://gateway.example/anthropic/v1/messages");
  });

  it("tolerates a trailing slash on the override", async () => {
    const captured: string[] = [];
    const { completeAnthropicDocument } = await import("../src/llm/providers/anthropic.js");

    await completeAnthropicDocument({
      modelId: "claude-opus-4-x",
      apiKey: "test-key",
      promptText: "Summarize this document",
      document: docInput,
      timeoutMs: 30000,
      fetchImpl: mockOkFetch(captured) as unknown as typeof fetch,
      anthropicBaseUrlOverride: "https://gateway.example/anthropic/",
    });

    expect(captured[0]).toBe("https://gateway.example/anthropic/v1/messages");
  });

  it("matches the Anthropic SDK/text path for an already-versioned base (no special-casing)", async () => {
    // The streaming/text path stores ANTHROPIC_BASE_URL verbatim as the model
    // baseUrl (see resolveAnthropicModel) and lets @anthropic-ai/sdk append
    // `/v1/messages` via string concat. For a base that already ends in `/v1`
    // the SDK therefore produces `/v1/v1/messages`. The document path must stay
    // byte-for-byte consistent with that path rather than inventing a
    // document-only `/v1`-as-root heuristic (which would make PDF requests
    // diverge from text/streaming requests for the same configured base).
    const captured: string[] = [];
    const { completeAnthropicDocument } = await import("../src/llm/providers/anthropic.js");

    await completeAnthropicDocument({
      modelId: "claude-opus-4-x",
      apiKey: "test-key",
      promptText: "Summarize this document",
      document: docInput,
      timeoutMs: 30000,
      fetchImpl: mockOkFetch(captured) as unknown as typeof fetch,
      anthropicBaseUrlOverride: "https://anthropic.example/v1",
    });

    expect(captured[0]).toBe("https://anthropic.example/v1/v1/messages");
  });

  it("defaults to api.anthropic.com when no override is given", async () => {
    const captured: string[] = [];
    const { completeAnthropicDocument } = await import("../src/llm/providers/anthropic.js");

    await completeAnthropicDocument({
      modelId: "claude-opus-4-x",
      apiKey: "test-key",
      promptText: "Summarize this document",
      document: docInput,
      timeoutMs: 30000,
      fetchImpl: mockOkFetch(captured) as unknown as typeof fetch,
    });

    expect(captured[0]).toBe("https://api.anthropic.com/v1/messages");
  });
});
