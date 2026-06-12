import { describe, expect, it } from "vitest";
import {
  DEFAULT_AUTO_CLI_ORDER,
  DEFAULT_CLI_MODELS,
  cliProviderForRequiredEnv,
  envHasRequiredKey,
  formatMissingCliModelError,
  gatewayProviderForRequiredEnv,
  getCliProviderProfile,
  isGatewayProvider,
  isVideoUnderstandingCapableModelId,
  parseCliProviderName,
  requiredEnvForCliProvider,
  requiredEnvForGatewayProvider,
  resolveOpenAiCompatibleClientConfigForProvider,
  resolveProviderOpenAiOverrides,
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
      "copilot",
    ]);
    expect(DEFAULT_CLI_MODELS.codex).toBeNull();
    expect(DEFAULT_CLI_MODELS.gemini).toBe("flash");
    expect(DEFAULT_CLI_MODELS.openclaw).toBe("main");
    expect(DEFAULT_CLI_MODELS.opencode).toBeNull();
    expect(DEFAULT_CLI_MODELS.copilot).toBeNull();
    expect(DEFAULT_CLI_MODELS.agy).toBeNull();
    expect(DEFAULT_CLI_MODELS.pi).toBeNull();
    expect(parseCliProviderName(" GeMiNi ")).toBe("gemini");
    expect(parseCliProviderName(" openclaw ")).toBe("openclaw");
    expect(parseCliProviderName(" opencode ")).toBe("opencode");
    expect(parseCliProviderName(" OpenCode ")).toBe("opencode");
    expect(parseCliProviderName(" Copilot ")).toBe("copilot");
    expect(parseCliProviderName(" Agy ")).toBe("agy");
    expect(parseCliProviderName(" Pi ")).toBe("pi");
    expect(parseCliProviderName("nope")).toBeNull();
    expect(requiredEnvForCliProvider("agent")).toBe("CLI_AGENT");
    expect(requiredEnvForCliProvider("openclaw")).toBe("CLI_OPENCLAW");
    expect(requiredEnvForCliProvider("opencode")).toBe("CLI_OPENCODE");
    expect(requiredEnvForCliProvider("copilot")).toBe("CLI_COPILOT");
    expect(requiredEnvForCliProvider("agy")).toBe("CLI_AGY");
    expect(requiredEnvForCliProvider("pi")).toBe("CLI_PI");
    expect(cliProviderForRequiredEnv("CLI_OPENCODE")).toBe("opencode");
    expect(cliProviderForRequiredEnv("OPENAI_API_KEY")).toBeNull();
    expect(gatewayProviderForRequiredEnv("OPENAI_API_KEY")).toBe("openai");
    expect(gatewayProviderForRequiredEnv("OPENROUTER_API_KEY")).toBeNull();
    expect(isGatewayProvider("minimax")).toBe(true);
    expect(isGatewayProvider("openrouter")).toBe(false);
  });

  it("owns CLI missing-binary guidance in provider profiles", () => {
    expect(getCliProviderProfile("gemini")).toMatchObject({
      requiredEnv: "CLI_GEMINI",
      defaultModel: "flash",
      pathEnv: "GEMINI_PATH",
    });

    const cases = [
      [
        "CLI_CLAUDE",
        "Claude CLI not found for model cli/test. Install Claude CLI or set CLAUDE_PATH.",
      ],
      ["CLI_CODEX", "Codex CLI not found for model cli/test. Install Codex CLI or set CODEX_PATH."],
      [
        "CLI_GEMINI",
        "Gemini CLI not found for model cli/test. Install Gemini CLI or set GEMINI_PATH.",
      ],
      [
        "CLI_AGENT",
        "Cursor Agent CLI not found for model cli/test. Install Cursor CLI or set AGENT_PATH.",
      ],
      [
        "CLI_OPENCLAW",
        "OpenClaw CLI not found for model cli/test. Install OpenClaw CLI or set OPENCLAW_PATH.",
      ],
      [
        "CLI_OPENCODE",
        "OpenCode CLI not found for model cli/test. Install OpenCode CLI or set OPENCODE_PATH.",
      ],
      [
        "CLI_COPILOT",
        "GitHub Copilot CLI not found for model cli/test. Install Copilot CLI or set COPILOT_PATH.",
      ],
      ["CLI_AGY", "Antigravity CLI not found for model cli/test. Install agy or set AGY_PATH."],
      ["CLI_PI", "pi CLI not found for model cli/test. Install pi or set PI_PATH."],
    ] as const;

    for (const [requiredEnv, expected] of cases) {
      expect(formatMissingCliModelError({ requiredEnv, userModelId: "cli/test" })).toBe(expected);
    }
    expect(
      formatMissingCliModelError({
        requiredEnv: "OPENAI_API_KEY",
        userModelId: "openai/gpt-5",
      }),
    ).toBeNull();
  });

  it("tracks native provider capabilities centrally", () => {
    expect(requiredEnvForGatewayProvider("google")).toBe("GEMINI_API_KEY");
    expect(requiredEnvForGatewayProvider("github-copilot")).toBe("GITHUB_TOKEN");
    expect(supportsDocumentAttachments("google")).toBe(true);
    expect(supportsDocumentAttachments("github-copilot")).toBe(false);
    expect(supportsDocumentAttachments("xai")).toBe(false);
    expect(supportsStreaming("anthropic")).toBe(true);
    expect(supportsStreaming("github-copilot")).toBe(true);
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
    expect(envHasRequiredKey({ GH_TOKEN: "gh" }, "GITHUB_TOKEN")).toBe(true);
    expect(envHasRequiredKey({}, "OPENAI_API_KEY")).toBe(false);
  });

  it("resolves provider requirements and OpenAI-compatible config centrally", () => {
    expect(resolveRequiredEnvForModelId("cli/gemini")).toBe("CLI_GEMINI");
    expect(resolveRequiredEnvForModelId("openclaw/main")).toBe("CLI_OPENCLAW");
    expect(resolveRequiredEnvForModelId("cli/opencode")).toBe("CLI_OPENCODE");
    expect(resolveRequiredEnvForModelId("cli/opencode/openai/gpt-5.4")).toBe("CLI_OPENCODE");
    expect(resolveRequiredEnvForModelId("cli/agy")).toBe("CLI_AGY");
    expect(resolveRequiredEnvForModelId("cli/pi")).toBe("CLI_PI");
    expect(resolveRequiredEnvForModelId("cli/pi/openai/gpt-5.4")).toBe("CLI_PI");
    expect(resolveRequiredEnvForModelId("cli/nope/test")).toBe("CLI_CLAUDE");
    expect(resolveRequiredEnvForModelId("openrouter/openai/gpt-5-mini")).toBe("OPENROUTER_API_KEY");
    expect(resolveRequiredEnvForModelId("nvidia/meta/llama-3.1-8b-instruct")).toBe(
      "NVIDIA_API_KEY",
    );
    expect(resolveRequiredEnvForModelId("minimax/MiniMax-M3")).toBe("MINIMAX_API_KEY");
    expect(resolveRequiredEnvForModelId("github-copilot/gpt-4.1")).toBe("GITHUB_TOKEN");
    expect(resolveRequiredEnvForModelId("ollama/qwen3:14b")).toBe("OLLAMA_BASE_URL");

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

    expect(
      resolveOpenAiCompatibleClientConfigForProvider({
        provider: "github-copilot",
        openaiApiKey: "gh-token",
        openrouterApiKey: null,
        openaiBaseUrlOverride: null,
      }),
    ).toEqual({
      apiKey: "gh-token",
      baseURL: "https://models.github.ai/inference",
      useChatCompletions: true,
      isOpenRouter: false,
      extraHeaders: {
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2026-03-10",
      },
    });

    // ollama: no api key required — defaults to localhost + dummy bearer + chat completions
    expect(
      resolveOpenAiCompatibleClientConfigForProvider({
        provider: "ollama",
        openaiApiKey: null,
        openrouterApiKey: null,
        openaiBaseUrlOverride: null,
      }),
    ).toEqual({
      apiKey: "ollama",
      baseURL: "http://localhost:11434/v1",
      useChatCompletions: true,
      isOpenRouter: false,
    });

    // ollama: honors baseUrl override (e.g. remote Ollama host)
    expect(
      resolveOpenAiCompatibleClientConfigForProvider({
        provider: "ollama",
        openaiApiKey: null,
        openrouterApiKey: null,
        openaiBaseUrlOverride: "http://gpu-rig.lan:11434/v1",
      }),
    ).toEqual({
      apiKey: "ollama",
      baseURL: "http://gpu-rig.lan:11434/v1",
      useChatCompletions: true,
      isOpenRouter: false,
    });

    // ollama: honors explicit api key (when sitting behind a proxy that enforces auth)
    expect(
      resolveOpenAiCompatibleClientConfigForProvider({
        provider: "ollama",
        openaiApiKey: "proxy-secret",
        openrouterApiKey: null,
        openaiBaseUrlOverride: null,
      }),
    ).toEqual({
      apiKey: "proxy-secret",
      baseURL: "http://localhost:11434/v1",
      useChatCompletions: true,
      isOpenRouter: false,
    });
  });

  it("resolves runtime OpenAI-compatible overrides from provider profiles", () => {
    const runtime = {
      apiKeys: {
        zai: "z-key",
        nvidia: "n-key",
        minimax: "m-key",
        "github-copilot": "gh-key",
      },
      baseUrls: {
        openai: "https://openai.example/v1",
        zai: "https://zai.example/v1",
        nvidia: "https://nvidia.example/v1",
        minimax: "https://minimax.example/v1",
        ollama: "http://ollama.example:11434/v1",
      },
      openaiUseChatCompletions: false,
    } as const;

    expect(resolveProviderOpenAiOverrides({ provider: "zai", runtime })).toEqual({
      openaiApiKeyOverride: "z-key",
      openaiBaseUrlOverride: "https://zai.example/v1",
      forceChatCompletions: true,
    });
    expect(resolveProviderOpenAiOverrides({ provider: "nvidia", runtime })).toEqual({
      openaiApiKeyOverride: "n-key",
      openaiBaseUrlOverride: "https://nvidia.example/v1",
      forceChatCompletions: true,
    });
    expect(resolveProviderOpenAiOverrides({ provider: "minimax", runtime })).toEqual({
      openaiApiKeyOverride: "m-key",
      openaiBaseUrlOverride: "https://minimax.example/v1",
      forceChatCompletions: true,
    });
    expect(resolveProviderOpenAiOverrides({ provider: "github-copilot", runtime })).toEqual({
      openaiApiKeyOverride: "gh-key",
      openaiBaseUrlOverride: "https://models.github.ai/inference",
      forceChatCompletions: true,
    });
    expect(resolveProviderOpenAiOverrides({ provider: "ollama", runtime })).toEqual({
      openaiApiKeyOverride: null,
      openaiBaseUrlOverride: "http://ollama.example:11434/v1",
      forceChatCompletions: true,
    });
    expect(resolveProviderOpenAiOverrides({ provider: "openai", runtime })).toEqual({
      openaiBaseUrlOverride: "https://openai.example/v1",
      forceChatCompletions: false,
    });
    expect(resolveProviderOpenAiOverrides({ provider: "anthropic", runtime })).toEqual({});
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
    expect(() =>
      resolveOpenAiCompatibleClientConfigForProvider({
        provider: "minimax",
        openaiApiKey: null,
        openrouterApiKey: null,
        openaiBaseUrlOverride: null,
      }),
    ).toThrow(/Missing MINIMAX_API_KEY/);
    expect(() =>
      resolveOpenAiCompatibleClientConfigForProvider({
        provider: "github-copilot",
        openaiApiKey: null,
        openrouterApiKey: null,
        openaiBaseUrlOverride: null,
      }),
    ).toThrow(/Missing GITHUB_TOKEN/);
  });
});
