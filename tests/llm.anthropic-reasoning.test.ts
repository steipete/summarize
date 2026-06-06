import type { Api, Model } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { prepareAnthropicReasoning } from "../src/llm/providers/anthropic.js";

function makeBase(
  modelId: string,
  reasoning: boolean,
  baseUrl = "https://api.anthropic.com",
): Model<Api> {
  return {
    id: modelId,
    name: `anthropic/${modelId}`,
    api: "anthropic-messages",
    provider: "anthropic",
    baseUrl,
    reasoning,
    input: ["text", "image"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 200_000,
    maxTokens: 32_000,
  };
}

describe("prepareAnthropicReasoning", () => {
  it("returns the base model untouched when no effort is requested", () => {
    const baseModel = makeBase("claude-opus-4-5", true);
    const result = prepareAnthropicReasoning({ modelId: "claude-opus-4-5", baseModel });
    expect(result.model).toBe(baseModel);
    expect(result.reasoning).toBeUndefined();
  });

  it("treats 'none' as off and does not forward reasoning", () => {
    const baseModel = makeBase("claude-opus-4-5", true);
    const result = prepareAnthropicReasoning({
      modelId: "claude-opus-4-5",
      baseModel,
      reasoningEffort: "none",
    });
    expect(result.reasoning).toBeUndefined();
    expect(result.model).toBe(baseModel);
  });

  it("forwards reasoning for a supported registered model without mutating metadata", () => {
    // Registered Anthropic model with reasoning support; resolveAnthropicModel
    // returns it intact so we should not flip any flags.
    const baseModel = makeBase("claude-opus-4-5", true);
    const result = prepareAnthropicReasoning({
      modelId: "claude-opus-4-5",
      baseModel,
      reasoningEffort: "xhigh",
    });
    expect(result.reasoning).toBe("xhigh");
    expect(result.model).toBe(baseModel);
    expect(result.model.reasoning).toBe(true);
  });

  it("drops reasoning on registered unsupported models (Claude 3/3.5) so pi-ai does not enable thinking", () => {
    // pi-ai 0.75.5 enables extended thinking whenever `options.reasoning` is
    // present, regardless of `model.reasoning`. For Claude 3/3.5 the API
    // rejects thinking blocks, so we must drop the reasoning option entirely
    // when the user has a global `thinking` setting active.
    const baseModel = makeBase("claude-3-5-sonnet-20241022", false);
    const result = prepareAnthropicReasoning({
      modelId: "claude-3-5-sonnet-20241022",
      baseModel,
      reasoningEffort: "high",
    });
    expect(result.model).toBe(baseModel);
    expect(result.model.reasoning).toBe(false);
    expect(result.reasoning).toBeUndefined();
  });

  it("opts synthetic models into thinking so the request body carries thinking", () => {
    // A custom modelId not in the pi-ai registry (e.g. `Claude-Opus-4.7`
    // routed through a jdcloud-style proxy) is built via createSyntheticModel
    // with reasoning: false. Without opting in, the pi-ai Anthropic adapter
    // would silently drop the thinking block.
    const baseModel = makeBase(
      "Definitely-Not-A-Real-Claude-Model-Id-42",
      false,
      "https://proxy.example/anthropic",
    );
    const result = prepareAnthropicReasoning({
      modelId: "Definitely-Not-A-Real-Claude-Model-Id-42",
      baseModel,
      reasoningEffort: "xhigh",
    });
    expect(result.reasoning).toBe("xhigh");
    expect(result.model).not.toBe(baseModel);
    expect(result.model.reasoning).toBe(true);
    // Other model fields should be preserved.
    expect(result.model.id).toBe(baseModel.id);
    expect(result.model.baseUrl).toBe(baseModel.baseUrl);
  });
});
