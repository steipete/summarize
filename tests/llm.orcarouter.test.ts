import { describe, expect, it } from "vitest";
import { normalizeGatewayStyleModelId, parseGatewayStyleModelId } from "../src/llm/model-id.js";
import {
  requiredEnvForGatewayProvider,
  resolveOpenAiCompatibleClientConfigForProvider,
} from "../src/llm/provider-capabilities.js";
import { DEFAULT_ORCAROUTER_BASE_URL } from "../src/llm/provider-profile.js";
import { resolveOrcarouterModel } from "../src/llm/providers/models.js";
import { parseRequestedModelId } from "../src/model-spec.js";

const emptyContext = { messages: [] };

describe("OrcaRouter provider", () => {
  it("keeps the upstream namespace in the model id", () => {
    // OrcaRouter routes by namespaced upstream id, so `openai/...` must survive parsing.
    expect(normalizeGatewayStyleModelId("orcarouter/openai/gpt-5.5")).toBe(
      "orcarouter/openai/gpt-5.5",
    );
    expect(parseGatewayStyleModelId("orcarouter/openai/gpt-5.5")).toEqual({
      provider: "orcarouter",
      model: "openai/gpt-5.5",
      canonical: "orcarouter/openai/gpt-5.5",
    });
    expect(parseGatewayStyleModelId("orcarouter/orcarouter/auto").model).toBe("orcarouter/auto");
  });

  it("parses orcarouter/... into a native attempt with the gateway defaults", () => {
    expect(parseRequestedModelId("orcarouter/openai/gpt-5.5")).toEqual({
      kind: "fixed",
      transport: "native",
      userModelId: "orcarouter/openai/gpt-5.5",
      llmModelId: "orcarouter/openai/gpt-5.5",
      provider: "orcarouter",
      openrouterProviders: null,
      forceOpenRouter: false,
      requiredEnv: "ORCAROUTER_API_KEY",
      openaiBaseUrlOverride: DEFAULT_ORCAROUTER_BASE_URL,
      forceChatCompletions: true,
    });
    expect(() => parseRequestedModelId("orcarouter/")).toThrow(/missing the model id/i);
  });

  it("requires ORCAROUTER_API_KEY", () => {
    expect(requiredEnvForGatewayProvider("orcarouter")).toBe("ORCAROUTER_API_KEY");
    expect(() =>
      resolveOpenAiCompatibleClientConfigForProvider({
        provider: "orcarouter",
        openaiApiKey: null,
        openrouterApiKey: null,
      }),
    ).toThrow("Missing ORCAROUTER_API_KEY for orcarouter/... model");
  });

  it("builds a chat-completions client against the OrcaRouter gateway", () => {
    expect(
      resolveOpenAiCompatibleClientConfigForProvider({
        provider: "orcarouter",
        openaiApiKey: "sk-orca-test",
        openrouterApiKey: null,
      }),
    ).toEqual({
      apiKey: "sk-orca-test",
      baseURL: DEFAULT_ORCAROUTER_BASE_URL,
      useChatCompletions: true,
      isOpenRouter: false,
    });
    expect(
      resolveOpenAiCompatibleClientConfigForProvider({
        provider: "orcarouter",
        openaiApiKey: "sk-orca-test",
        openrouterApiKey: null,
        openaiBaseUrlOverride: "https://proxy.example.com/v1",
      }).baseURL,
    ).toBe("https://proxy.example.com/v1");
  });

  it("sends client attribution headers like the other routing gateway", () => {
    const model = resolveOrcarouterModel({ modelId: "openai/gpt-5.5", context: emptyContext });
    expect(model).toMatchObject({
      id: "openai/gpt-5.5",
      api: "openai-completions",
      baseUrl: DEFAULT_ORCAROUTER_BASE_URL,
      input: ["text"],
      headers: {
        "HTTP-Referer": "https://github.com/steipete/summarize",
        "X-Title": "summarize",
      },
    });
  });

  it("honors a base URL override and image inputs", () => {
    const model = resolveOrcarouterModel({
      modelId: "anthropic/claude-sonnet-4.6",
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
    expect(model.baseUrl).toBe("https://proxy.example.com/v1");
    expect(model.input).toEqual(["text", "image"]);
  });
});
