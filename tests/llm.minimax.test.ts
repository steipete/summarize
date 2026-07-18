import { describe, expect, it } from "vitest";
import { enableMinimaxReasoningSplit } from "../src/llm/providers/minimax.js";
import { resolveMinimaxModel } from "../src/llm/providers/models.js";

describe("MiniMax provider", () => {
  it("requests separated reasoning without mutating the original payload", () => {
    const payload = { model: "MiniMax-M3", stream: true };
    expect(enableMinimaxReasoningSplit(payload)).toEqual({
      model: "MiniMax-M3",
      stream: true,
      reasoning_split: true,
    });
    expect(payload).toEqual({ model: "MiniMax-M3", stream: true });
  });

  it("uses provider-native MiniMax metadata over the OpenAI-compatible transport", () => {
    const model = resolveMinimaxModel({
      modelId: "MiniMax-M3",
      context: {
        messages: [
          {
            role: "user",
            content: [{ type: "image", data: "aGVsbG8=", mimeType: "image/png" }],
            timestamp: Date.now(),
          },
        ],
      },
      openaiBaseUrlOverride: "https://proxy.example.com/v1",
    });

    expect(model).toMatchObject({
      id: "MiniMax-M3",
      provider: "minimax",
      api: "openai-completions",
      baseUrl: "https://proxy.example.com/v1",
      reasoning: true,
      input: ["text"],
      contextWindow: 1_000_000,
      cost: {
        input: 0.3,
        output: 1.2,
        cacheRead: 0.06,
      },
      compat: {
        supportsStore: false,
        supportsDeveloperRole: false,
        supportsReasoningEffort: false,
        maxTokensField: "max_completion_tokens",
        supportsStrictMode: false,
        supportsLongCacheRetention: false,
      },
    });
  });
});
