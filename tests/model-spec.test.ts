import { describe, expect, it } from "vitest";
import { parseRequestedModelId } from "../src/model-spec.js";

describe("model spec parsing", () => {
  it("rejects empty model ids", () => {
    expect(() => parseRequestedModelId("   ")).toThrow(/Missing model id/);
  });

  it("rejects unknown keyword-like model ids", () => {
    expect(() => parseRequestedModelId("free")).toThrow(/Unknown model/);
    expect(() => parseRequestedModelId("foobar")).toThrow(/Unknown model/);
  });

  it("parses cli model ids", () => {
    const parsed = parseRequestedModelId("cli/claude/sonnet");
    expect(parsed.kind).toBe("fixed");
    expect(parsed.transport).toBe("cli");
    expect(parsed.cliProvider).toBe("claude");
    expect(parsed.cliModel).toBe("sonnet");
  });

  it("uses the Codex runtime default model when missing", () => {
    const parsed = parseRequestedModelId("cli/codex");
    expect(parsed.kind).toBe("fixed");
    expect(parsed.transport).toBe("cli");
    expect(parsed.userModelId).toBe("cli/codex");
    expect(parsed.cliProvider).toBe("codex");
    expect(parsed.cliModel).toBeNull();
    expect(parsed.requiredEnv).toBe("CLI_CODEX");
  });

  it("defaults agent cli models when missing", () => {
    const parsed = parseRequestedModelId("cli/agent");
    expect(parsed.kind).toBe("fixed");
    expect(parsed.transport).toBe("cli");
    expect(parsed.cliProvider).toBe("agent");
    expect(parsed.cliModel).toBe("auto");
    expect(parsed.requiredEnv).toBe("CLI_AGENT");
  });

  it("defaults openclaw cli models when missing", () => {
    const parsed = parseRequestedModelId("cli/openclaw");
    expect(parsed.kind).toBe("fixed");
    expect(parsed.transport).toBe("cli");
    expect(parsed.cliProvider).toBe("openclaw");
    expect(parsed.cliModel).toBe("main");
    expect(parsed.requiredEnv).toBe("CLI_OPENCLAW");
  });

  it("parses openclaw shorthand model ids", () => {
    const parsed = parseRequestedModelId("openclaw/custom-agent");
    expect(parsed.kind).toBe("fixed");
    expect(parsed.transport).toBe("cli");
    expect(parsed.cliProvider).toBe("openclaw");
    expect(parsed.cliModel).toBe("custom-agent");
    expect(parsed.userModelId).toBe("openclaw/custom-agent");
  });

  it("defaults gemini cli models when missing", () => {
    const parsed = parseRequestedModelId("cli/gemini");
    expect(parsed.kind).toBe("fixed");
    expect(parsed.transport).toBe("cli");
    expect(parsed.cliProvider).toBe("gemini");
    expect(parsed.cliModel).toBe("flash");
    expect(parsed.requiredEnv).toBe("CLI_GEMINI");
  });

  it("uses the OpenCode runtime default model when missing", () => {
    const parsed = parseRequestedModelId("cli/opencode");
    expect(parsed.kind).toBe("fixed");
    expect(parsed.transport).toBe("cli");
    expect(parsed.userModelId).toBe("cli/opencode");
    expect(parsed.cliProvider).toBe("opencode");
    expect(parsed.cliModel).toBeNull();
    expect(parsed.requiredEnv).toBe("CLI_OPENCODE");
  });

  it("uses agy's active session model and rejects model suffixes", () => {
    const parsed = parseRequestedModelId("cli/agy");
    expect(parsed.kind).toBe("fixed");
    expect(parsed.transport).toBe("cli");
    expect(parsed.userModelId).toBe("cli/agy");
    expect(parsed.cliProvider).toBe("agy");
    expect(parsed.cliModel).toBeNull();
    expect(parsed.requiredEnv).toBe("CLI_AGY");
    expect(() => parseRequestedModelId("cli/agy/Gemini 3.5 Flash (Medium)")).toThrow(
      /without a model suffix/,
    );
  });

  it("uses the pi runtime default model and accepts model suffixes", () => {
    const runtimeDefault = parseRequestedModelId("cli/pi");
    expect(runtimeDefault.kind).toBe("fixed");
    expect(runtimeDefault.transport).toBe("cli");
    expect(runtimeDefault.userModelId).toBe("cli/pi");
    expect(runtimeDefault.cliProvider).toBe("pi");
    expect(runtimeDefault.cliModel).toBeNull();
    expect(runtimeDefault.requiredEnv).toBe("CLI_PI");

    const explicitModel = parseRequestedModelId("cli/pi/openai/gpt-5.4");
    expect(explicitModel.kind).toBe("fixed");
    expect(explicitModel.transport).toBe("cli");
    expect(explicitModel.userModelId).toBe("cli/pi/openai/gpt-5.4");
    expect(explicitModel.cliProvider).toBe("pi");
    expect(explicitModel.cliModel).toBe("openai/gpt-5.4");
    expect(explicitModel.requiredEnv).toBe("CLI_PI");
  });

  it("rejects invalid cli providers", () => {
    expect(() => parseRequestedModelId("cli/unknown/model")).toThrow(/Invalid CLI model id/);
  });

  it("parses openrouter model ids", () => {
    const parsed = parseRequestedModelId("openrouter/openai/gpt-5-nano");
    expect(parsed.kind).toBe("fixed");
    expect(parsed.transport).toBe("openrouter");
    expect(parsed.openrouterModelId).toBe("openai/gpt-5-nano");
    expect(parsed.requiredEnv).toBe("OPENROUTER_API_KEY");
  });

  it("rejects invalid openrouter model ids", () => {
    expect(() => parseRequestedModelId("openrouter/")).toThrow(/missing the OpenRouter model id/);
    expect(() => parseRequestedModelId("openrouter/openai")).toThrow('Expected "author/slug"');
  });

  it("parses native model ids and providers", () => {
    const parsed = parseRequestedModelId("xai/grok-4-fast-non-reasoning");
    expect(parsed.kind).toBe("fixed");
    expect(parsed.transport).toBe("native");
    expect(parsed.provider).toBe("xai");
    expect(parsed.requiredEnv).toBe("XAI_API_KEY");
  });

  it("maps OpenAI GPT fast suffixes to service tier request options", () => {
    const parsed = parseRequestedModelId("openai/gpt-5.4-mini-fast");
    expect(parsed.kind).toBe("fixed");
    expect(parsed.transport).toBe("native");
    expect(parsed.userModelId).toBe("openai/gpt-5.4-mini-fast");
    expect(parsed.llmModelId).toBe("openai/gpt-5.4-mini");
    expect(parsed.requestOptions).toEqual({ serviceTier: "fast" });
  });

  it("maps bare OpenAI GPT fast suffixes to OpenAI", () => {
    const parsed = parseRequestedModelId("gpt-5.5-fast");
    expect(parsed.kind).toBe("fixed");
    expect(parsed.transport).toBe("native");
    expect(parsed.userModelId).toBe("gpt-5.5-fast");
    expect(parsed.llmModelId).toBe("openai/gpt-5.5");
    expect(parsed.requiredEnv).toBe("OPENAI_API_KEY");
    expect(parsed.requestOptions).toEqual({ serviceTier: "fast" });
  });

  it("maps native providers to required env", () => {
    const google = parseRequestedModelId("google/gemini-3-flash-preview");
    expect(google.kind).toBe("fixed");
    expect(google.transport).toBe("native");
    expect(google.requiredEnv).toBe("GEMINI_API_KEY");

    const anthropic = parseRequestedModelId("anthropic/claude-sonnet-4-5");
    expect(anthropic.kind).toBe("fixed");
    expect(anthropic.transport).toBe("native");
    expect(anthropic.requiredEnv).toBe("ANTHROPIC_API_KEY");

    const zai = parseRequestedModelId("zai/glm-4.7");
    expect(zai.kind).toBe("fixed");
    expect(zai.transport).toBe("native");
    expect(zai.requiredEnv).toBe("Z_AI_API_KEY");
    expect(zai.llmModelId).toBe("zai/glm-4.7");

    const nvidia = parseRequestedModelId("nvidia/z-ai/glm5");
    expect(nvidia.kind).toBe("fixed");
    expect(nvidia.transport).toBe("native");
    expect(nvidia.provider).toBe("nvidia");
    expect(nvidia.requiredEnv).toBe("NVIDIA_API_KEY");
    expect(nvidia.llmModelId).toBe("nvidia/z-ai/glm5");

    const minimax = parseRequestedModelId("minimax/MiniMax-M3");
    expect(minimax.kind).toBe("fixed");
    expect(minimax.transport).toBe("native");
    if (minimax.kind === "fixed" && minimax.transport === "native") {
      expect(minimax.provider).toBe("minimax");
      expect(minimax.requiredEnv).toBe("MINIMAX_API_KEY");
      expect(minimax.llmModelId).toBe("minimax/MiniMax-M3");
      expect(minimax.openaiBaseUrlOverride).toBe("https://api.minimax.io/v1");
      expect(minimax.forceChatCompletions).toBe(true);
    }

    const ollama = parseRequestedModelId("ollama/qwen3:14b");
    expect(ollama.kind).toBe("fixed");
    expect(ollama.transport).toBe("native");
    if (ollama.kind === "fixed" && ollama.transport === "native") {
      expect(ollama.provider).toBe("ollama");
      expect(ollama.requiredEnv).toBe("OLLAMA_BASE_URL");
      expect(ollama.llmModelId).toBe("ollama/qwen3:14b");
      expect(ollama.openaiBaseUrlOverride).toBe("http://localhost:11434/v1");
      expect(ollama.forceChatCompletions).toBe(true);
    }
  });

  it("parses github-copilot model ids as native gateway models", () => {
    const parsed = parseRequestedModelId("github-copilot/gpt-4.1");
    expect(parsed.kind).toBe("fixed");
    expect(parsed.transport).toBe("native");
    expect(parsed.provider).toBe("github-copilot");
    expect(parsed.requiredEnv).toBe("GITHUB_TOKEN");
    expect(parsed.llmModelId).toBe("github-copilot/openai/gpt-4.1");
    expect(parsed.forceChatCompletions).toBe(true);
  });

  it("rejects empty zai model id", () => {
    expect(() => parseRequestedModelId("zai/")).toThrow(/missing the model id/);
  });

  it("rejects empty nvidia model id", () => {
    expect(() => parseRequestedModelId("nvidia/")).toThrow(/missing the model id/);
  });

  it("rejects empty minimax model id", () => {
    expect(() => parseRequestedModelId("minimax/")).toThrow(/missing the model id/);
  });

  it("rejects empty ollama model id", () => {
    expect(() => parseRequestedModelId("ollama/")).toThrow(/missing the model id/);
  });

  it("rejects empty github-copilot model id", () => {
    expect(() => parseRequestedModelId("github-copilot/")).toThrow(/missing the model id/);
  });
});
