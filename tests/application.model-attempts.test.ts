import { describe, expect, it, vi } from "vitest";
import {
  resolveModelAttempts,
  selectPreferredInteractiveModelAttempt,
} from "../src/application/model-attempts.js";
import { runModelAttempts } from "../src/engine/model-attempts.js";
import { generateTextWithModelId } from "../src/llm/generate-text.js";
import type { ProviderRuntimeBindings } from "../src/llm/provider-profile.js";

const providerRuntime: ProviderRuntimeBindings = {
  apiKeys: {
    openai: "openai-key",
    minimax: "minimax-key",
  },
  baseUrls: {
    openai: "https://openai.example/v1",
    minimax: "https://minimax.example/v1",
  },
  openaiUseChatCompletions: false,
};

describe("application model attempts", () => {
  it("binds fixed provider and configured CLI models through one planner", () => {
    const fixed = resolveModelAttempts({
      requestedModel: {
        kind: "fixed",
        transport: "native",
        userModelId: "minimax/MiniMax-M3",
        llmModelId: "minimax/MiniMax-M3",
        provider: "minimax",
        openrouterProviders: null,
        forceOpenRouter: false,
        requiredEnv: "MINIMAX_API_KEY",
      },
      kind: "text",
      promptTokens: null,
      desiredOutputTokens: null,
      requiresVideoUnderstanding: false,
      envForAuto: {},
      configForModelSelection: null,
      catalog: null,
      openrouterProvidersFromEnv: null,
      cliAvailability: {},
      providerRuntime,
    });
    const cli = resolveModelAttempts({
      requestedModel: {
        kind: "fixed",
        transport: "cli",
        userModelId: "cli/opencode/openai/gpt-5.4",
        llmModelId: null,
        openrouterProviders: null,
        forceOpenRouter: false,
        requiredEnv: "CLI_OPENCODE",
        cliProvider: "opencode",
        cliModel: "openai/gpt-5.4",
      },
      kind: "text",
      promptTokens: null,
      desiredOutputTokens: null,
      requiresVideoUnderstanding: false,
      envForAuto: {},
      configForModelSelection: null,
      catalog: null,
      openrouterProvidersFromEnv: null,
      cliAvailability: { opencode: true },
      providerRuntime,
    });

    expect(fixed[0]).toMatchObject({
      userModelId: "minimax/MiniMax-M3",
      openaiApiKeyOverride: "minimax-key",
      openaiBaseUrlOverride: "https://minimax.example/v1",
      forceChatCompletions: true,
    });
    expect(cli[0]).toMatchObject({
      cliProvider: "opencode",
      cliModel: "openai/gpt-5.4",
    });
  });

  it("selects an available API attempt before a CLI fallback", () => {
    const attempts = [
      {
        transport: "cli" as const,
        userModelId: "cli/codex/gpt-5.4",
        llmModelId: null,
        openrouterProviders: null,
        forceOpenRouter: false,
        requiredEnv: "CLI_CODEX" as const,
        cliProvider: "codex" as const,
        cliModel: "gpt-5.4",
      },
      {
        transport: "native" as const,
        userModelId: "openai/gpt-5.4",
        llmModelId: "openai/gpt-5.4",
        openrouterProviders: null,
        forceOpenRouter: false,
        requiredEnv: "OPENAI_API_KEY" as const,
      },
    ];

    expect(
      selectPreferredInteractiveModelAttempt({
        attempts,
        envForAuto: { OPENAI_API_KEY: "key" },
        cliAvailability: { codex: true },
      })?.userModelId,
    ).toBe("openai/gpt-5.4");
    expect(
      selectPreferredInteractiveModelAttempt({
        attempts,
        envForAuto: {},
        cliAvailability: { codex: true },
      })?.userModelId,
    ).toBe("cli/codex/gpt-5.4");
  });

  it("detects OpenRouter no-provider diagnostics from the direct HTTP error", async () => {
    const fetchImpl = vi.fn<typeof fetch>(
      async () =>
        new Response(
          JSON.stringify({
            error: { message: "No allowed providers are available for the selected model" },
          }),
          { status: 400, headers: { "content-type": "application/json" } },
        ),
    );
    const result = await runModelAttempts({
      attempts: [
        {
          transport: "openrouter",
          userModelId: "openrouter/meta-llama/llama-3.3-70b-instruct",
          llmModelId: "openai/meta-llama/llama-3.3-70b-instruct",
          openrouterProviders: null,
          forceOpenRouter: true,
          requiredEnv: "OPENROUTER_API_KEY",
        },
      ],
      isFallbackModel: true,
      isNamedModelSelection: true,
      envHasKeyFor: () => true,
      formatMissingModelError: () => "missing",
      runAttempt: async () =>
        generateTextWithModelId({
          modelId: "openai/meta-llama/llama-3.3-70b-instruct",
          apiKeys: {
            openaiApiKey: null,
            openrouterApiKey: "key",
            googleApiKey: null,
            anthropicApiKey: null,
            xaiApiKey: null,
          },
          forceOpenRouter: true,
          prompt: { userText: "hi" },
          timeoutMs: 100,
          fetchImpl,
        }),
    });

    expect(result.sawOpenRouterNoAllowedProviders).toBe(true);
    expect(result.lastError).toBeInstanceOf(Error);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});
