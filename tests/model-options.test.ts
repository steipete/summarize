import { describe, expect, it } from "vitest";
import {
  mergeModelRequestOptions,
  mergeRequestOptionsForProvider,
  parseOpenAiReasoningEffort,
  toOpenAiServiceTierParam,
} from "../src/llm/model-options.js";

describe("model request options", () => {
  it("treats thinking as a reasoning effort alias when merging", () => {
    expect(mergeModelRequestOptions({ thinking: "medium" })).toEqual({
      reasoningEffort: "medium",
    });
  });

  it("maps summarize fast/default tiers to OpenAI request params", () => {
    expect(toOpenAiServiceTierParam("fast")).toBe("priority");
    expect(toOpenAiServiceTierParam("default")).toBeUndefined();
    expect(toOpenAiServiceTierParam("flex")).toBe("flex");
  });

  it("accepts only live-supported OpenAI reasoning efforts", () => {
    expect(parseOpenAiReasoningEffort("off")).toBe("none");
    expect(parseOpenAiReasoningEffort("min")).toBe("low");
    expect(parseOpenAiReasoningEffort("mid")).toBe("medium");
    expect(parseOpenAiReasoningEffort("x-high")).toBe("xhigh");
    expect(() => parseOpenAiReasoningEffort("minimal")).toThrow(/expected none, low/);
  });
});

describe("mergeRequestOptionsForProvider", () => {
  const openaiGlobalDefault = { reasoningEffort: "high" as const };
  const openaiOverride = { serviceTier: "fast" };

  it("applies the OpenAI-scoped global default and override only for the openai provider", () => {
    const merged = mergeRequestOptionsForProvider({
      provider: "openai",
      openaiGlobalDefault,
      attemptOptions: undefined,
      openaiOverride,
    });
    expect(merged).toEqual({ reasoningEffort: "high", serviceTier: "fast" });
  });

  it("does not bleed the OpenAI-scoped global default into the anthropic provider", () => {
    const merged = mergeRequestOptionsForProvider({
      provider: "anthropic",
      openaiGlobalDefault,
      attemptOptions: undefined,
      openaiOverride,
    });
    expect(merged).toBeUndefined();
  });

  it("forwards the per-attempt reasoning effort to anthropic when the user opted in for that attempt", () => {
    const merged = mergeRequestOptionsForProvider({
      provider: "anthropic",
      openaiGlobalDefault,
      attemptOptions: { reasoningEffort: "xhigh" },
      openaiOverride,
    });
    expect(merged).toEqual({ reasoningEffort: "xhigh" });
  });

  it("isolates other non-openai providers (zai, google, xai) from openai-scoped defaults", () => {
    for (const provider of ["zai", "google", "xai", "nvidia", "ollama", "github-copilot"]) {
      const merged = mergeRequestOptionsForProvider({
        provider,
        openaiGlobalDefault,
        attemptOptions: undefined,
        openaiOverride,
      });
      expect(merged, `provider ${provider}`).toBeUndefined();
    }
  });
});
