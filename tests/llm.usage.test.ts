import { describe, expect, it } from "vitest";
import {
  normalizeAnthropicUsage,
  normalizeGoogleUsage,
  normalizeOpenAiUsage,
  normalizeTokenUsage,
} from "../src/llm/usage.js";

describe("llm usage normalization", () => {
  it("normalizes generic usage payloads", () => {
    expect(normalizeTokenUsage(null)).toBeNull();
    expect(normalizeTokenUsage({})).toBeNull();
    expect(normalizeTokenUsage({ input: 5 })).toMatchObject({ promptTokens: 5 });
    expect(normalizeTokenUsage({ output: 7, totalTokens: 10 })).toMatchObject({
      completionTokens: 7,
      totalTokens: 10,
    });
  });

  it("normalizes Anthropic usage payloads", () => {
    expect(normalizeAnthropicUsage(null)).toBeNull();
    expect(normalizeAnthropicUsage({})).toBeNull();
    expect(normalizeAnthropicUsage({ input_tokens: 12, output_tokens: 4 })).toEqual({
      promptTokens: 12,
      completionTokens: 4,
      totalTokens: 16,
    });
  });

  it("normalizes OpenAI usage payloads", () => {
    expect(normalizeOpenAiUsage(null)).toBeNull();
    expect(normalizeOpenAiUsage({})).toBeNull();
    expect(normalizeOpenAiUsage({ prompt_tokens: 2, completion_tokens: 3 })).toEqual({
      promptTokens: 2,
      completionTokens: 3,
      totalTokens: 5,
    });
    expect(normalizeOpenAiUsage({ input_tokens: 2, output_tokens: 3 })).toEqual({
      promptTokens: 2,
      completionTokens: 3,
      totalTokens: 5,
    });
    expect(normalizeOpenAiUsage({ input_tokens: 2, output_tokens: 3, total_tokens: 9 })).toEqual({
      promptTokens: 2,
      completionTokens: 3,
      totalTokens: 9,
    });
  });

  it("normalizes Google usage payloads", () => {
    expect(normalizeGoogleUsage(null)).toBeNull();
    expect(normalizeGoogleUsage({})).toBeNull();
    expect(normalizeGoogleUsage({ promptTokenCount: 10, candidatesTokenCount: 5 })).toMatchObject({
      promptTokens: 10,
      completionTokens: 5,
      totalTokens: 15,
    });
    expect(
      normalizeGoogleUsage({ promptTokenCount: 10, candidatesTokenCount: 5, totalTokenCount: 40 }),
    ).toMatchObject({
      promptTokens: 10,
      completionTokens: 5,
      totalTokens: 40,
    });
  });
});
