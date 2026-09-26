import { describe, expect, it } from "vitest";
import {
  isOpenAiGpt5Model,
  isRetryableLlmError,
  promptToContext,
  resolveEffectiveTemperature,
  resolveGoogleEmptyResponseFallbackModelId,
  shouldRetryGpt5WithoutTokenCap,
} from "../src/llm/generate-text-shared.js";

describe("generate-text shared helpers", () => {
  it("builds image prompt contexts and rejects unsupported attachments", () => {
    const imageContext = promptToContext({
      userText: "look",
      attachments: [{ kind: "image", mediaType: "image/png", bytes: new Uint8Array([1, 2, 3]) }],
    });

    expect(imageContext.messages).toHaveLength(1);

    expect(() =>
      promptToContext({
        userText: "bad",
        attachments: [
          { kind: "image", mediaType: "image/png", bytes: new Uint8Array([1]) },
          { kind: "image", mediaType: "image/png", bytes: new Uint8Array([2]) },
        ],
      }),
    ).toThrow(/only single image attachments/i);
  });

  it("omits temperature for OpenAI GPT-5 ids", () => {
    expect(
      resolveEffectiveTemperature({
        provider: "openai",
        model: "gpt-5",
        temperature: 0.4,
      }),
    ).toBeUndefined();
  });

  it("detects GPT-5-family retries that should drop maxOutputTokens", () => {
    expect(isOpenAiGpt5Model("openai", "gpt-5-mini")).toBe(true);
    expect(isOpenAiGpt5Model("openai", "openai/gpt-5-mini")).toBe(true);
    expect(isOpenAiGpt5Model("openai", "gpt-4.1")).toBe(false);

    expect(
      shouldRetryGpt5WithoutTokenCap({
        provider: "openai",
        model: "gpt-5-mini",
        maxOutputTokens: 200,
        error: new Error("LLM returned an empty summary (model openai/gpt-5-mini)."),
      }),
    ).toBe(true);
    expect(
      shouldRetryGpt5WithoutTokenCap({
        provider: "openai",
        model: "gpt-5-mini",
        maxOutputTokens: undefined,
        error: new Error("LLM returned an empty summary"),
      }),
    ).toBe(false);
    expect(
      shouldRetryGpt5WithoutTokenCap({
        provider: "openai",
        model: "gpt-4.1",
        maxOutputTokens: 200,
        error: new Error("LLM returned an empty summary"),
      }),
    ).toBe(false);
  });

  it("classifies transient LLM failures without retrying permanent HTTP errors", () => {
    expect(
      isRetryableLlmError(Object.assign(new Error("OpenAI API error (502)."), { statusCode: 502 })),
    ).toBe(true);
    expect(isRetryableLlmError(new Error("Request failed with status code 503"))).toBe(true);
    expect(isRetryableLlmError("503 Service Unavailable")).toBe(true);
    expect(isRetryableLlmError({ errorMessage: "429 Too Many Requests" })).toBe(true);
    expect(
      isRetryableLlmError(new Error('Google request failed for model "gemini": 503 unavailable')),
    ).toBe(true);
    expect(isRetryableLlmError({ errorMessage: "OpenAI API error (502): bad gateway" })).toBe(true);
    expect(isRetryableLlmError({ errorMessage: "Connection error." })).toBe(true);
    expect(isRetryableLlmError({ code: "ECONNRESET" })).toBe(true);
    expect(isRetryableLlmError({ code: "server_error" })).toBe(true);
    expect(isRetryableLlmError({ errorMessage: "Error Code rate_limit_exceeded: slow down" })).toBe(
      true,
    );
    expect(isRetryableLlmError(new Error("vector_store_timeout: try again"))).toBe(true);
    expect(isRetryableLlmError(new TypeError("fetch failed"))).toBe(true);
    expect(isRetryableLlmError(new Error("Stream ended without finish_reason"))).toBe(true);
    expect(isRetryableLlmError(new Error("Anthropic stream ended before message_stop"))).toBe(true);
    expect(
      isRetryableLlmError(new Error("WebSocket stream closed before response.completed")),
    ).toBe(true);
    expect(isRetryableLlmError(new Error("OpenAI stream response was empty."))).toBe(true);
    expect(
      isRetryableLlmError(
        new Error("Attempted to iterate over an Anthropic response with no body"),
      ),
    ).toBe(true);
    expect(isRetryableLlmError(new Error("Response body is empty"))).toBe(true);
    expect(isRetryableLlmError(new Error("Incomplete JSON segment at the end"))).toBe(true);
    expect(isRetryableLlmError({ errorMessage: "Provider finish_reason: network_error" })).toBe(
      true,
    );
    expect(
      isRetryableLlmError(
        new Error('{"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}'),
      ),
    ).toBe(true);
    expect(isRetryableLlmError(new SyntaxError("Unexpected end of JSON input"))).toBe(true);
    expect(isRetryableLlmError({ code: "ERR_STREAM_PREMATURE_CLOSE" })).toBe(true);
    expect(isRetryableLlmError({ status: "503" })).toBe(true);
    expect(isRetryableLlmError(new Error("request failed", { cause: { statusCode: 503 } }))).toBe(
      true,
    );
    expect(
      isRetryableLlmError(Object.assign(new Error("OpenAI API error (400)."), { statusCode: 400 })),
    ).toBe(false);
    expect(
      isRetryableLlmError(
        Object.assign(new Error("Network error while validating the request"), { statusCode: 400 }),
      ),
    ).toBe(false);
    expect(isRetryableLlmError(new Error("Invalid max output tokens: 500"))).toBe(false);
    expect(isRetryableLlmError(new Error("Unable to fetch configured model metadata"))).toBe(false);
  });

  it("only falls back preview or exp Google ids", () => {
    expect(resolveGoogleEmptyResponseFallbackModelId("google/gemini-3-flash-preview")).toBe(
      "google/gemini-2.5-flash",
    );
    expect(resolveGoogleEmptyResponseFallbackModelId("google/gemini-2.5-flash")).toBeNull();
    expect(resolveGoogleEmptyResponseFallbackModelId("openai/gpt-5")).toBeNull();
  });
});
