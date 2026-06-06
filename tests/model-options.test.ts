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

  it("forwards an explicit CLI --thinking override to the anthropic provider", () => {
    const merged = mergeRequestOptionsForProvider({
      provider: "anthropic",
      openaiGlobalDefault,
      attemptOptions: undefined,
      openaiOverride,
      cliReasoningEffortOverride: "xhigh",
    });
    expect(merged).toEqual({ reasoningEffort: "xhigh" });
  });

  it("does not leak a persisted openai.thinking config default into anthropic without a CLI override", () => {
    const merged = mergeRequestOptionsForProvider({
      provider: "anthropic",
      openaiGlobalDefault: { reasoningEffort: "high" },
      attemptOptions: undefined,
      openaiOverride: undefined,
      cliReasoningEffortOverride: undefined,
    });
    expect(merged).toBeUndefined();
  });

  it("respects persisted openai.thinking for openai when no CLI override is set", () => {
    const merged = mergeRequestOptionsForProvider({
      provider: "openai",
      openaiGlobalDefault: { reasoningEffort: "high" },
      attemptOptions: undefined,
      openaiOverride: undefined,
      cliReasoningEffortOverride: undefined,
    });
    expect(merged).toEqual({ reasoningEffort: "high" });
  });

  it("lets a CLI --thinking override beat persisted openai.thinking for the openai provider", () => {
    const merged = mergeRequestOptionsForProvider({
      provider: "openai",
      openaiGlobalDefault: { reasoningEffort: "high" },
      attemptOptions: undefined,
      openaiOverride: undefined,
      cliReasoningEffortOverride: "xhigh",
    });
    expect(merged).toEqual({ reasoningEffort: "xhigh" });
  });

  it("forwards CLI --thinking to other non-openai providers (zai, google, xai, ...)", () => {
    for (const provider of ["zai", "google", "xai", "nvidia", "ollama", "github-copilot"]) {
      const merged = mergeRequestOptionsForProvider({
        provider,
        openaiGlobalDefault,
        attemptOptions: undefined,
        openaiOverride,
        cliReasoningEffortOverride: "xhigh",
      });
      expect(merged, `provider ${provider}`).toEqual({ reasoningEffort: "xhigh" });
    }
  });
});
