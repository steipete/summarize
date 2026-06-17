import { describe, expect, it } from "vitest";
import { resolveEnvState } from "../src/application/environment-state.js";
import { resolveProviderRuntimeBindings } from "../src/application/provider-runtime.js";

describe("provider runtime bindings", () => {
  it("maps every configured gateway provider into shared runtime bindings", () => {
    const env = {
      XAI_API_KEY: "x-key",
      XAI_BASE_URL: "https://xai.example/v1",
      OPENAI_API_KEY: "o-key",
      OPENAI_BASE_URL: "https://openai.example/v1",
      EVOLINK_API_KEY: "ev-key",
      EVOLINK_BASE_URL: "https://evolink.example/v1",
      GOOGLE_API_KEY: "g-key",
      GOOGLE_BASE_URL: "https://google.example/v1",
      ANTHROPIC_API_KEY: "a-key",
      ANTHROPIC_BASE_URL: "https://anthropic.example/v1",
      ZAI_API_KEY: "z-key",
      NVIDIA_API_KEY: "n-key",
      MINIMAX_API_KEY: "m-key",
      GH_TOKEN: "gh-key",
      OLLAMA_BASE_URL: "http://ollama.example:11434/v1",
    };
    const envState = resolveEnvState({ env, envForRun: env, configForCli: null });

    expect(resolveProviderRuntimeBindings({ env, envState, configForCli: null })).toMatchObject({
      apiKeys: {
        xai: "x-key",
        openai: "o-key",
        evolink: "ev-key",
        google: "g-key",
        anthropic: "a-key",
        zai: "z-key",
        nvidia: "n-key",
        minimax: "m-key",
        "github-copilot": "gh-key",
        ollama: null,
      },
      baseUrls: {
        xai: "https://xai.example/v1",
        openai: "https://openai.example/v1",
        evolink: "https://evolink.example/v1",
        google: "https://google.example/v1",
        anthropic: "https://anthropic.example/v1",
        ollama: "http://ollama.example:11434/v1",
      },
    });
  });

  it("uses the effective OpenRouter credential for an OpenRouter-backed OpenAI endpoint", () => {
    const env = {
      OPENROUTER_API_KEY: "or-key",
      OPENAI_BASE_URL: "https://openrouter.ai/api/v1",
    };
    const envState = resolveEnvState({ env, envForRun: env, configForCli: null });

    expect(
      resolveProviderRuntimeBindings({ env, envState, configForCli: null }).apiKeys.openai,
    ).toBe("or-key");
  });
});
