import { describe, expect, it } from "vitest";
import {
  resolveModelAttempts,
  selectPreferredInteractiveModelAttempt,
} from "../src/application/model-attempts.js";
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
});
