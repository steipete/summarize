import { describe, expect, it } from "vitest";
import {
  DEFAULT_AUTO_CLI_ORDER,
  DEFAULT_CLI_MODELS,
  envHasRequiredKey,
  isVideoUnderstandingCapableModelId,
  parseCliProviderName,
  requiredEnvForCliProvider,
  requiredEnvForGatewayProvider,
  resolveOpenAiCompatibleClientConfigForProvider,
  resolveRequiredEnvForModelId,
  supportsDocumentAttachments,
  supportsStreaming,
} from "../src/llm/provider-capabilities.js";

describe("llm provider capabilities", () => {
  it("exposes stable CLI defaults and parsing", () => {
    expect(DEFAULT_AUTO_CLI_ORDER).toEqual([
      "claude",
      "gemini",
      "codex",
      "agent",
      "openclaw",
      "opencode",
    ]);
    expect(DEFAULT_CLI_MODELS.gemini).toBe("gemini-3-flash");
    expect(DEFAULT_CLI_MODELS.openclaw).toBe("main");
    expect(DEFAULT_CLI_MODELS.opencode).toBeNull();
    expect(parseCliProviderName(" GeMiNi ")).toBe("gemini");
    expect(parseCliProviderName(" openclaw ")).toBe("openclaw");
    expect(parseCliProviderName(" opencode ")).toBe("opencode");
    expect(parseCliProviderName(" OpenCode ")).toBe("opencode");
    expect(parseCliProviderName("nope")).toBeNull();
    expect(requiredEnvForCliProvider("agent")).toBe("CLI_AGENT");
    expect(requiredEnvForCliProvider("openclaw")).toBe("CLI_OPENCLAW");
    expect(requiredEnvForCliProvider("opencode")).toBe("CLI_OPENCODE");
  });

  it("tracks native provider capabilities centrally", () => {
    expect(requiredEnvForGatewayProvider("google")).toBe("GEMINI_API_KEY");
    expect(supportsDocumentAttachments("google")).toBe(true);
    expect(supportsDocumentAttachments("xai")).toBe(false);
    expect(supportsStreaming("anthropic")).toBe(true);
    expect(isVideoUnderstandingCapableModelId("google/gemini-3-flash")).toBe(true);
    expect(isVideoUnderstandingCapableModelId("openai/gpt-5.2")).toBe(false);
  });

  it("handles provider env aliases", () => {
    expect(
      envHasRequiredKey(
        {
          GOOGLE_GENERATIVE_AI_API_KEY: "gemini",
        },
        "GEMINI_API_KEY",
      ),
    ).toBe(true);
    expect(envHasRequiredKey({ ZAI_API_KEY: "z" }, "Z_AI_API_KEY")).toBe(true);
    expect(envHasRequiredKey({}, "OPENAI_API_KEY")).toBe(false);
  });

  it("resolves provider requirements and OpenAI-compatible config centrally", () => {
    expect(resolveRequiredEnvForModelId("cli/gemini")).toBe("CLI_GEMINI");
    expect(resolveRequiredEnvForModelId("openclaw/main")).toBe("CLI_OPENCLAW");
    expect(resolveRequiredEnvForModelId("cli/opencode")).toBe("CLI_OPENCODE");
    expect(resolveRequiredEnvForModelId("cli/opencode/openai/gpt-5.4")).toBe("CLI_OPENCODE");
    expect(resolveRequiredEnvForModelId("cli/nope/test")).toBe("CLI_CLAUDE");
    expect(resolveRequiredEnvForModelId("openrouter/openai/gpt-5-mini")).toBe("OPENROUTER_API_KEY");
    expect(resolveRequiredEnvForModelId("nvidia/meta/llama-3.1-8b-instruct")).toBe(
      "NVIDIA_API_KEY",
    );

    expect(
      resolveOpenAiCompatibleClientConfigForProvider({
        provider: "zai",
        openaiApiKey: "z-key",
        openrouterApiKey: null,
        openaiBaseUrlOverride: null,
      }),
    ).toEqual({
      apiKey: "z-key",
      baseURL: "https://api.z.ai/api/paas/v4",
      useChatCompletions: true,
      isOpenRouter: false,
    });
  });

  it("returns false for invalid video model ids and requires provider keys", () => {
    expect(isVideoUnderstandingCapableModelId("not-a-model")).toBe(false);
    expect(isVideoUnderstandingCapableModelId("invalid-provider/model")).toBe(false);
    expect(() =>
      resolveOpenAiCompatibleClientConfigForProvider({
        provider: "zai",
        openaiApiKey: null,
        openrouterApiKey: null,
        openaiBaseUrlOverride: null,
      }),
    ).toThrow(/Missing Z_AI_API_KEY/);
    expect(() =>
      resolveOpenAiCompatibleClientConfigForProvider({
        provider: "nvidia",
        openaiApiKey: null,
        openrouterApiKey: null,
        openaiBaseUrlOverride: null,
      }),
    ).toThrow(/Missing NVIDIA_API_KEY/);
  });
});
