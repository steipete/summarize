import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { resolveAgentModel, resolveApiKeyForModel } from "../src/daemon/agent-model.js";

const emptyApiKeys = {
  openaiApiKey: null,
  openrouterApiKey: null,
  anthropicApiKey: null,
  googleApiKey: null,
  evolinkApiKey: null,
  xaiApiKey: null,
  zaiApiKey: null,
  nvidiaApiKey: null,
  minimaxApiKey: null,
  githubApiKey: null,
};

describe("daemon agent model resolution", () => {
  it("uses synthetic local auth for Ollama agents without OPENAI_API_KEY", () => {
    expect(resolveApiKeyForModel({ provider: "ollama", apiKeys: emptyApiKeys })).toBe("ollama");
  });

  it("forwards OPENAI_API_KEY for auth-fronted Ollama agent proxies", () => {
    expect(
      resolveApiKeyForModel({
        provider: "ollama",
        apiKeys: { ...emptyApiKeys, openaiApiKey: "proxy-secret" },
      }),
    ).toBe("proxy-secret");
  });

  it("uses provider registry requirements in missing-key errors", () => {
    expect(() => resolveApiKeyForModel({ provider: "minimax", apiKeys: emptyApiKeys })).toThrow(
      "Missing MINIMAX_API_KEY for minimax model",
    );
    expect(() => resolveApiKeyForModel({ provider: "unknown", apiKeys: emptyApiKeys })).toThrow(
      "Missing API key for provider: unknown",
    );
  });

  it("resolves GitHub Models credentials and gateway settings", async () => {
    expect(
      resolveApiKeyForModel({
        provider: "github-copilot",
        apiKeys: { ...emptyApiKeys, githubApiKey: "gh-token" },
      }),
    ).toBe("gh-token");

    const home = mkdtempSync(join(tmpdir(), "summarize-agent-github-models-"));
    const resolved = await resolveAgentModel({
      env: { HOME: home, GH_TOKEN: "gh-token" },
      pageContent: "Hello",
      modelOverride: "github-copilot/gpt-5.4",
    });

    expect(resolved.provider).toBe("github-copilot");
    expect(resolved.model).toMatchObject({
      id: "openai/gpt-5.4",
      api: "openai-completions",
      baseUrl: "https://models.github.ai/inference",
      headers: {
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2026-03-10",
      },
    });
  });

  it("honors explicit OpenAI Responses routing for agent custom base URLs", async () => {
    const home = mkdtempSync(join(tmpdir(), "summarize-agent-openai-responses-"));

    const resolved = await resolveAgentModel({
      env: {
        HOME: home,
        OPENAI_API_KEY: "sk-openai",
        OPENAI_BASE_URL: "https://gateway.example/v1",
        OPENAI_USE_CHAT_COMPLETIONS: "false",
      },
      pageContent: "Hello",
      modelOverride: "openai/gpt-5.4",
    });

    expect(resolved.provider).toBe("openai");
    expect(resolved.model?.api).toBe("openai-responses");
    expect(resolved.model?.baseUrl).toBe("https://gateway.example/v1");
  });

  it("keeps OpenRouter base URLs on chat completions for agents", async () => {
    const home = mkdtempSync(join(tmpdir(), "summarize-agent-openrouter-base-"));

    const resolved = await resolveAgentModel({
      env: {
        HOME: home,
        OPENAI_API_KEY: "sk-openrouter-via-openai",
        OPENAI_BASE_URL: "https://openrouter.ai/api/v1",
        OPENAI_USE_CHAT_COMPLETIONS: "false",
      },
      pageContent: "Hello",
      modelOverride: "openai/openai/gpt-5-mini",
    });

    expect(resolved.provider).toBe("openai");
    expect(resolved.model?.api).toBe("openai-completions");
    expect(resolved.model?.baseUrl).toBe("https://openrouter.ai/api/v1");
  });

  it("keeps NVIDIA agent models on chat completions", async () => {
    const home = mkdtempSync(join(tmpdir(), "summarize-agent-nvidia-"));

    const resolved = await resolveAgentModel({
      env: {
        HOME: home,
        NVIDIA_API_KEY: "sk-nvidia",
        OPENAI_USE_CHAT_COMPLETIONS: "false",
      },
      pageContent: "Hello",
      modelOverride: "nvidia/z-ai/glm5",
    });

    expect(resolved.provider).toBe("nvidia");
    expect(resolved.model?.api).toBe("openai-completions");
    expect(resolved.model?.baseUrl).toBe("https://integrate.api.nvidia.com/v1");
  });

  it("keeps EvoLink agent models on chat completions", async () => {
    const home = mkdtempSync(join(tmpdir(), "summarize-agent-evolink-"));

    const resolved = await resolveAgentModel({
      env: {
        HOME: home,
        EVOLINK_API_KEY: "sk-evolink",
        EVOLINK_BASE_URL: "https://evolink.example.com/v1",
        OPENAI_USE_CHAT_COMPLETIONS: "false",
      },
      pageContent: "Hello",
      modelOverride: "evolink/gpt-5.2",
    });

    expect(resolved.provider).toBe("evolink");
    expect(resolved.model).toMatchObject({
      provider: "openai",
      id: "gpt-5.2",
      api: "openai-completions",
      baseUrl: "https://evolink.example.com/v1",
    });
  });

  it("keeps MiniMax agent metadata and compatibility settings", async () => {
    const home = mkdtempSync(join(tmpdir(), "summarize-agent-minimax-"));

    const resolved = await resolveAgentModel({
      env: {
        HOME: home,
        MINIMAX_API_KEY: "sk-minimax",
        MINIMAX_BASE_URL: "https://minimax.example.com/v1",
      },
      pageContent: "Hello",
      modelOverride: "minimax/MiniMax-M3",
    });

    expect(resolved.provider).toBe("minimax");
    expect(resolved.model).toMatchObject({
      provider: "minimax",
      api: "openai-completions",
      baseUrl: "https://minimax.example.com/v1",
      compat: {
        supportsStore: false,
        supportsDeveloperRole: false,
        supportsReasoningEffort: false,
        maxTokensField: "max_completion_tokens",
        supportsStrictMode: false,
      },
    });
  });

  it("keeps Ollama agent models on chat completions", async () => {
    const home = mkdtempSync(join(tmpdir(), "summarize-agent-ollama-"));

    const resolved = await resolveAgentModel({
      env: {
        HOME: home,
        OLLAMA_BASE_URL: "http://ollama-box:11434/v1",
        OPENAI_USE_CHAT_COMPLETIONS: "false",
      },
      pageContent: "Hello",
      modelOverride: "ollama/qwen3:14b",
    });

    expect(resolved.provider).toBe("ollama");
    expect(resolved.model?.api).toBe("openai-completions");
    expect(resolved.model?.baseUrl).toBe("http://ollama-box:11434/v1");
  });
});
