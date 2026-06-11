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
  xaiApiKey: null,
  zaiApiKey: null,
  nvidiaApiKey: null,
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
