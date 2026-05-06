import { describe, expect, it, vi } from "vitest";

// We test the payload structure that completeGoogleDocument sends to the Gemini API.
// The key requirement is that `temperature` and `maxOutputTokens` must be nested
// inside a `generationConfig` object, not placed at the top level of the request body.
// Placing them at the top level causes a 400 INVALID_ARGUMENT error from the Gemini API.

describe("completeGoogleDocument payload", () => {
  it("nests temperature and maxOutputTokens inside generationConfig", async () => {
    // Intercept fetch to capture the request payload
    const capturedBodies: string[] = [];
    const mockFetch = vi.fn(async (url: string, init: RequestInit) => {
      capturedBodies.push(init.body as string);
      return {
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({
            candidates: [{ content: { parts: [{ text: "Summary result" }] } }],
            usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5, totalTokenCount: 15 },
          }),
      };
    });

    const { completeGoogleDocument } = await import("../src/llm/providers/google.js");

    await completeGoogleDocument({
      modelId: "gemini-2.5-flash",
      apiKey: "test-key",
      promptText: "Summarize this document",
      document: {
        kind: "document",
        mediaType: "application/pdf",
        bytes: new Uint8Array([1, 2, 3]),
        filename: "test.pdf",
      },
      maxOutputTokens: 2048,
      temperature: 0,
      timeoutMs: 30000,
      fetchImpl: mockFetch as typeof fetch,
    });

    expect(capturedBodies.length).toBe(1);
    const payload = JSON.parse(capturedBodies[0]);

    // temperature and maxOutputTokens MUST be inside generationConfig, not at the top level
    expect(payload).not.toHaveProperty("temperature");
    expect(payload).not.toHaveProperty("maxOutputTokens");
    expect(payload).toHaveProperty("generationConfig");
    expect(payload.generationConfig).toEqual({
      temperature: 0,
      maxOutputTokens: 2048,
    });
  });

  it("omits generationConfig when neither temperature nor maxOutputTokens is set", async () => {
    const capturedBodies: string[] = [];
    const mockFetch = vi.fn(async (url: string, init: RequestInit) => {
      capturedBodies.push(init.body as string);
      return {
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({
            candidates: [{ content: { parts: [{ text: "Summary result" }] } }],
            usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5, totalTokenCount: 15 },
          }),
      };
    });

    const { completeGoogleDocument } = await import("../src/llm/providers/google.js");

    await completeGoogleDocument({
      modelId: "gemini-2.5-flash",
      apiKey: "test-key",
      promptText: "Summarize this document",
      document: {
        kind: "document",
        mediaType: "application/pdf",
        bytes: new Uint8Array([1, 2, 3]),
        filename: "test.pdf",
      },
      timeoutMs: 30000,
      fetchImpl: mockFetch as typeof fetch,
    });

    expect(capturedBodies.length).toBe(1);
    const payload = JSON.parse(capturedBodies[0]);

    // No generationConfig should be present when neither param is provided
    expect(payload).not.toHaveProperty("generationConfig");
    expect(payload).not.toHaveProperty("temperature");
    expect(payload).not.toHaveProperty("maxOutputTokens");
  });

  it("nests only temperature inside generationConfig when maxOutputTokens is omitted", async () => {
    const capturedBodies: string[] = [];
    const mockFetch = vi.fn(async (url: string, init: RequestInit) => {
      capturedBodies.push(init.body as string);
      return {
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({
            candidates: [{ content: { parts: [{ text: "Summary result" }] } }],
            usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5, totalTokenCount: 15 },
          }),
      };
    });

    const { completeGoogleDocument } = await import("../src/llm/providers/google.js");

    await completeGoogleDocument({
      modelId: "gemini-2.5-flash",
      apiKey: "test-key",
      promptText: "Summarize this document",
      document: {
        kind: "document",
        mediaType: "application/pdf",
        bytes: new Uint8Array([1, 2, 3]),
        filename: "test.pdf",
      },
      temperature: 0.7,
      timeoutMs: 30000,
      fetchImpl: mockFetch as typeof fetch,
    });

    const payload = JSON.parse(capturedBodies[0]);
    expect(payload).not.toHaveProperty("temperature");
    expect(payload.generationConfig).toEqual({ temperature: 0.7 });
  });

  it("includes response body detail in error messages", async () => {
    const mockFetch = vi.fn(async () => ({
      ok: false,
      status: 400,
      text: async () =>
        JSON.stringify({
          error: {
            message:
              'Invalid JSON payload received. Unknown name "temperature": Cannot find field.',
            status: "INVALID_ARGUMENT",
          },
        }),
    }));

    const { completeGoogleDocument } = await import("../src/llm/providers/google.js");

    await expect(
      completeGoogleDocument({
        modelId: "gemini-2.5-flash",
        apiKey: "test-key",
        promptText: "Summarize this document",
        document: {
          kind: "document",
          mediaType: "application/pdf",
          bytes: new Uint8Array([1, 2, 3]),
          filename: "test.pdf",
        },
        temperature: 0,
        timeoutMs: 30000,
        fetchImpl: mockFetch as typeof fetch,
      }),
    ).rejects.toThrow(/temperature/);
  });
});
