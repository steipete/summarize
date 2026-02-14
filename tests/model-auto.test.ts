import { describe, expect, it } from "vitest";
import type { SummarizeConfig } from "../src/config.js";
import { buildAutoModelAttempts } from "../src/model-auto.js";

describe("auto model selection", () => {
  it("supports minimax aliases in auto candidates", () => {
    const config: SummarizeConfig = {
      model: {
        mode: "auto",
        rules: [{ candidates: ["minimax", "minimax/MiniMax-M2.5"] }],
      },
    };
    const attempts = buildAutoModelAttempts({
      kind: "text",
      promptTokens: 100,
      desiredOutputTokens: 50,
      requiresVideoUnderstanding: false,
      env: { MINIMAX_API_KEY: "mm-key" },
      config,
      catalog: null,
      openrouterProvidersFromEnv: null,
    });

    expect(attempts).toHaveLength(1);
    expect(attempts[0]?.userModelId).toBe("openai/minimax-m2.5");
    expect(attempts[0]?.llmModelId).toBe("openai/minimax-m2.5");
    expect(attempts[0]?.requiredEnv).toBe("MINIMAX_API_KEY");
  });

  it("supports kimi aliases in auto candidates", () => {
    const config: SummarizeConfig = {
      model: {
        mode: "auto",
        rules: [{ candidates: ["kimi", "kimi/kimi-k2-thinking"] }],
      },
    };
    const attempts = buildAutoModelAttempts({
      kind: "text",
      promptTokens: 100,
      desiredOutputTokens: 50,
      requiresVideoUnderstanding: false,
      env: { KIMI_API_KEY: "kimi-key" },
      config,
      catalog: null,
      openrouterProvidersFromEnv: null,
    });

    expect(attempts).toHaveLength(2);
    expect(attempts[0]?.userModelId).toBe("openai/kimi-k2.5");
    expect(attempts[0]?.requiredEnv).toBe("KIMI_API_KEY");
    expect(attempts[1]?.userModelId).toBe("openai/kimi-k2-thinking");
    expect(attempts[1]?.requiredEnv).toBe("KIMI_API_KEY");
  });

  it("preserves candidate order (native then OpenRouter fallback)", () => {
    const config: SummarizeConfig = {
      model: {
        mode: "auto",
        rules: [{ candidates: ["openai/gpt-5-mini", "xai/grok-4-fast"] }],
      },
    };
    const attempts = buildAutoModelAttempts({
      kind: "text",
      promptTokens: 100,
      desiredOutputTokens: 50,
      requiresVideoUnderstanding: false,
      env: { OPENROUTER_API_KEY: "sk-or-test" },
      config,
      catalog: null,
      openrouterProvidersFromEnv: null,
      openrouterModelIds: ["openai/gpt-5-mini", "x-ai/grok-4-fast"],
    });

    expect(attempts[0]?.userModelId).toBe("openai/gpt-5-mini");
    expect(attempts[1]?.userModelId).toBe("openrouter/openai/gpt-5-mini");
    expect(attempts[2]?.userModelId).toBe("xai/grok-4-fast");
    expect(attempts[3]?.userModelId).toBe("openrouter/x-ai/grok-4-fast");
  });

  it("skips OpenRouter fallback when no mapping is found", () => {
    const config: SummarizeConfig = {
      model: {
        mode: "auto",
        rules: [{ candidates: ["xai/grok-4-fast-non-reasoning"] }],
      },
    };
    const attempts = buildAutoModelAttempts({
      kind: "text",
      promptTokens: 100,
      desiredOutputTokens: 50,
      requiresVideoUnderstanding: false,
      env: { OPENROUTER_API_KEY: "sk-or-test" },
      config,
      catalog: null,
      openrouterProvidersFromEnv: null,
      openrouterModelIds: ["openai/gpt-5-mini", "x-ai/grok-4-fast"],
    });

    expect(attempts.map((a) => a.userModelId)).toEqual(["xai/grok-4-fast-non-reasoning"]);
  });

  it("skips OpenRouter fallback when multiple OpenRouter ids match the same slug", () => {
    const config: SummarizeConfig = {
      model: {
        mode: "auto",
        rules: [{ candidates: ["xai/grok-4-fast"] }],
      },
    };
    const attempts = buildAutoModelAttempts({
      kind: "text",
      promptTokens: 100,
      desiredOutputTokens: 50,
      requiresVideoUnderstanding: false,
      env: { OPENROUTER_API_KEY: "sk-or-test" },
      config,
      catalog: null,
      openrouterProvidersFromEnv: null,
      openrouterModelIds: ["x-ai/grok-4-fast", "other/grok-4-fast"],
    });

    expect(attempts.map((a) => a.userModelId)).toEqual(["xai/grok-4-fast"]);
  });

  it("matches OpenRouter ids when punctuation differs in slug", () => {
    const config: SummarizeConfig = {
      model: {
        mode: "auto",
        rules: [{ candidates: ["xai/grok-4-1-fast"] }],
      },
    };
    const attempts = buildAutoModelAttempts({
      kind: "text",
      promptTokens: 100,
      desiredOutputTokens: 50,
      requiresVideoUnderstanding: false,
      env: { OPENROUTER_API_KEY: "sk-or-test" },
      config,
      catalog: null,
      openrouterProvidersFromEnv: null,
      openrouterModelIds: ["x-ai/grok-4.1-fast"],
    });

    expect(attempts.map((a) => a.userModelId)).toEqual([
      "xai/grok-4-1-fast",
      "openrouter/x-ai/grok-4.1-fast",
    ]);
  });

  it("skips OpenRouter fallback when normalized slug is ambiguous", () => {
    const config: SummarizeConfig = {
      model: {
        mode: "auto",
        rules: [{ candidates: ["xai/grok-4-1-fast"] }],
      },
    };
    const attempts = buildAutoModelAttempts({
      kind: "text",
      promptTokens: 100,
      desiredOutputTokens: 50,
      requiresVideoUnderstanding: false,
      env: { OPENROUTER_API_KEY: "sk-or-test" },
      config,
      catalog: null,
      openrouterProvidersFromEnv: null,
      openrouterModelIds: ["x-ai/grok-4.1-fast", "other/grok-4.1-fast"],
    });

    expect(attempts.map((a) => a.userModelId)).toEqual(["xai/grok-4-1-fast"]);
  });

  it("prefers exact OpenRouter id even if slug is ambiguous", () => {
    const config: SummarizeConfig = {
      model: {
        mode: "auto",
        rules: [{ candidates: ["xai/grok-4-fast"] }],
      },
    };
    const attempts = buildAutoModelAttempts({
      kind: "text",
      promptTokens: 100,
      desiredOutputTokens: 50,
      requiresVideoUnderstanding: false,
      env: { OPENROUTER_API_KEY: "sk-or-test" },
      config,
      catalog: null,
      openrouterProvidersFromEnv: null,
      openrouterModelIds: ["xai/grok-4-fast", "other/grok-4-fast"],
    });

    expect(attempts.map((a) => a.userModelId)).toEqual([
      "xai/grok-4-fast",
      "openrouter/xai/grok-4-fast",
    ]);
  });

  it("matches OpenRouter ids case-insensitively", () => {
    const config: SummarizeConfig = {
      model: {
        mode: "auto",
        rules: [{ candidates: ["openai/gpt-5-mini"] }],
      },
    };
    const attempts = buildAutoModelAttempts({
      kind: "text",
      promptTokens: 100,
      desiredOutputTokens: 50,
      requiresVideoUnderstanding: false,
      env: { OPENROUTER_API_KEY: "sk-or-test" },
      config,
      catalog: null,
      openrouterProvidersFromEnv: null,
      openrouterModelIds: ["OpenAI/GPT-5-Mini"],
    });

    expect(attempts.map((a) => a.userModelId)).toEqual([
      "openai/gpt-5-mini",
      "openrouter/openai/gpt-5-mini",
    ]);
  });

  it("does not add OpenRouter fallback without OPENROUTER_API_KEY", () => {
    const config: SummarizeConfig = {
      model: {
        mode: "auto",
        rules: [{ candidates: ["openai/gpt-5-mini"] }],
      },
    };
    const attempts = buildAutoModelAttempts({
      kind: "text",
      promptTokens: 100,
      desiredOutputTokens: 50,
      requiresVideoUnderstanding: false,
      env: {},
      config,
      catalog: null,
      openrouterProvidersFromEnv: null,
      openrouterModelIds: ["openai/gpt-5-mini"],
    });

    expect(attempts.map((a) => a.userModelId)).toEqual(["openai/gpt-5-mini"]);
  });

  it("skips OpenRouter fallback when OpenRouter catalog is empty", () => {
    const config: SummarizeConfig = {
      model: {
        mode: "auto",
        rules: [{ candidates: ["openai/gpt-5-mini"] }],
      },
    };
    const attempts = buildAutoModelAttempts({
      kind: "text",
      promptTokens: 100,
      desiredOutputTokens: 50,
      requiresVideoUnderstanding: false,
      env: { OPENROUTER_API_KEY: "sk-or-test" },
      config,
      catalog: null,
      openrouterProvidersFromEnv: null,
      openrouterModelIds: [],
    });

    expect(attempts.map((a) => a.userModelId)).toEqual(["openai/gpt-5-mini"]);
  });

  it("adds an OpenRouter fallback attempt when OPENROUTER_API_KEY is set", () => {
    const config: SummarizeConfig = {
      model: { mode: "auto", rules: [{ candidates: ["openai/gpt-5-mini"] }] },
    };
    const attempts = buildAutoModelAttempts({
      kind: "text",
      promptTokens: 100,
      desiredOutputTokens: 50,
      requiresVideoUnderstanding: false,
      env: { OPENROUTER_API_KEY: "sk-or-test" },
      config,
      catalog: null,
      openrouterProvidersFromEnv: ["groq"],
    });

    expect(attempts.some((a) => a.forceOpenRouter)).toBe(true);
    expect(attempts.some((a) => a.userModelId === "openai/gpt-5-mini")).toBe(true);
    expect(attempts.some((a) => a.userModelId === "openrouter/openai/gpt-5-mini")).toBe(true);
  });

  it("does not add an OpenRouter fallback when video understanding is required", () => {
    const config: SummarizeConfig = {
      model: { mode: "auto", rules: [{ candidates: ["google/gemini-3-flash-preview"] }] },
    };
    const attempts = buildAutoModelAttempts({
      kind: "video",
      promptTokens: 100,
      desiredOutputTokens: 50,
      requiresVideoUnderstanding: true,
      env: { OPENROUTER_API_KEY: "sk-or-test" },
      config,
      catalog: null,
      openrouterProvidersFromEnv: ["groq"],
    });

    expect(attempts.every((a) => a.forceOpenRouter === false)).toBe(true);
  });

  it("respects explicit openrouter/... candidates (no native attempt)", () => {
    const config: SummarizeConfig = {
      model: { mode: "auto", rules: [{ candidates: ["openrouter/openai/gpt-5-nano"] }] },
    };
    const attempts = buildAutoModelAttempts({
      kind: "text",
      promptTokens: 100,
      desiredOutputTokens: 50,
      requiresVideoUnderstanding: false,
      env: { OPENROUTER_API_KEY: "sk-or-test" },
      config,
      catalog: null,
      openrouterProvidersFromEnv: null,
    });

    expect(attempts.some((a) => a.userModelId === "openrouter/openai/gpt-5-nano")).toBe(true);
    expect(attempts.some((a) => a.userModelId === "openai/gpt-5-nano")).toBe(false);
  });

  it("treats OpenRouter model ids as opaque (meta-llama/... etc)", () => {
    const config: SummarizeConfig = {
      model: {
        mode: "auto",
        rules: [{ candidates: ["openrouter/meta-llama/llama-3.3-70b-instruct:free"] }],
      },
    };
    const attempts = buildAutoModelAttempts({
      kind: "text",
      promptTokens: 100,
      desiredOutputTokens: 50,
      requiresVideoUnderstanding: false,
      env: { OPENROUTER_API_KEY: "sk-or-test" },
      config,
      catalog: null,
      openrouterProvidersFromEnv: null,
    });

    expect(attempts[0]?.userModelId).toBe("openrouter/meta-llama/llama-3.3-70b-instruct:free");
    expect(attempts[0]?.llmModelId).toBe("openai/meta-llama/llama-3.3-70b-instruct:free");
  });

  it("selects candidates via token bands (first match wins)", () => {
    const config: SummarizeConfig = {
      model: {
        mode: "auto",
        rules: [
          {
            when: ["text"],
            bands: [
              { token: { max: 100 }, candidates: ["openai/gpt-5-nano"] },
              { token: { max: 1000 }, candidates: ["openai/gpt-5-mini"] },
              { candidates: ["xai/grok-4-fast-non-reasoning"] },
            ],
          },
        ],
      },
    };

    const attempts = buildAutoModelAttempts({
      kind: "text",
      promptTokens: 200,
      desiredOutputTokens: 50,
      requiresVideoUnderstanding: false,
      env: {},
      config,
      catalog: null,
      openrouterProvidersFromEnv: null,
    });

    expect(attempts[0]?.userModelId).toBe("openai/gpt-5-mini");
  });

  it("filters candidates by LiteLLM max input tokens (skips too-small context)", () => {
    const config: SummarizeConfig = {
      model: {
        mode: "auto",
        rules: [{ candidates: ["openai/gpt-5-nano", "openai/gpt-5-mini"] }],
      },
    };

    const catalog = {
      "gpt-5-nano": { max_input_tokens: 10 },
      "gpt-5-mini": { max_input_tokens: 1000 },
    };

    const attempts = buildAutoModelAttempts({
      kind: "text",
      promptTokens: 100,
      desiredOutputTokens: 50,
      requiresVideoUnderstanding: false,
      env: { OPENAI_API_KEY: "test" },
      config,
      catalog,
      openrouterProvidersFromEnv: null,
    });

    expect(attempts[0]?.userModelId).toBe("openai/gpt-5-mini");
  });

  it('supports multi-kind "when" arrays', () => {
    const config: SummarizeConfig = {
      model: {
        mode: "auto",
        rules: [
          { when: ["youtube", "website"], candidates: ["openai/gpt-5-nano"] },
          { when: ["text"], candidates: ["openai/gpt-5-mini"] },
        ],
      },
    };

    const attemptsWebsite = buildAutoModelAttempts({
      kind: "website",
      promptTokens: 100,
      desiredOutputTokens: 50,
      requiresVideoUnderstanding: false,
      env: { OPENAI_API_KEY: "test" },
      config,
      catalog: null,
      openrouterProvidersFromEnv: null,
    });
    expect(attemptsWebsite[0]?.userModelId).toBe("openai/gpt-5-nano");

    const attemptsText = buildAutoModelAttempts({
      kind: "text",
      promptTokens: 100,
      desiredOutputTokens: 50,
      requiresVideoUnderstanding: false,
      env: { OPENAI_API_KEY: "test" },
      config,
      catalog: null,
      openrouterProvidersFromEnv: null,
    });
    expect(attemptsText[0]?.userModelId).toBe("openai/gpt-5-mini");
  });

  it("does not prepend CLI candidates unless enabled", () => {
    const attempts = buildAutoModelAttempts({
      kind: "text",
      promptTokens: 100,
      desiredOutputTokens: 50,
      requiresVideoUnderstanding: false,
      env: {},
      config: null,
      catalog: null,
      openrouterProvidersFromEnv: null,
      cliAvailability: { claude: true, codex: true, gemini: true },
    });

    expect(attempts[0]?.userModelId).toBe("google/gemini-3-flash-preview");
  });

  it("prepends CLI candidates when enabled", () => {
    const config: SummarizeConfig = {
      cli: { enabled: ["claude", "gemini", "codex"] },
      model: { mode: "auto", rules: [{ candidates: ["openai/gpt-5-mini"] }] },
    };
    const attempts = buildAutoModelAttempts({
      kind: "text",
      promptTokens: 100,
      desiredOutputTokens: 50,
      requiresVideoUnderstanding: false,
      env: {},
      config,
      catalog: null,
      openrouterProvidersFromEnv: null,
      cliAvailability: { claude: true },
    });

    expect(attempts[0]?.userModelId).toBe("cli/claude/sonnet");
  });

  it("prepends auto CLI fallback candidates for implicit auto when no API keys are set", () => {
    const config: SummarizeConfig = {
      model: { mode: "auto", rules: [{ candidates: ["openai/gpt-5-mini"] }] },
    };
    const attempts = buildAutoModelAttempts({
      kind: "text",
      promptTokens: 100,
      desiredOutputTokens: 50,
      requiresVideoUnderstanding: false,
      env: {},
      config,
      catalog: null,
      openrouterProvidersFromEnv: null,
      cliAvailability: { claude: true },
      isImplicitAutoSelection: true,
    });

    expect(attempts[0]?.userModelId).toBe("cli/claude/sonnet");
  });

  it("does not prepend auto CLI fallback candidates for explicit --model auto", () => {
    const config: SummarizeConfig = {
      model: { mode: "auto", rules: [{ candidates: ["openai/gpt-5-mini"] }] },
    };
    const attempts = buildAutoModelAttempts({
      kind: "text",
      promptTokens: 100,
      desiredOutputTokens: 50,
      requiresVideoUnderstanding: false,
      env: {},
      config,
      catalog: null,
      openrouterProvidersFromEnv: null,
      cliAvailability: { claude: true },
      isImplicitAutoSelection: false,
    });

    expect(attempts[0]?.userModelId).toBe("openai/gpt-5-mini");
  });

  it("does not prepend auto CLI fallback candidates when API keys are present", () => {
    const config: SummarizeConfig = {
      model: { mode: "auto", rules: [{ candidates: ["openai/gpt-5-mini"] }] },
    };
    const attempts = buildAutoModelAttempts({
      kind: "text",
      promptTokens: 100,
      desiredOutputTokens: 50,
      requiresVideoUnderstanding: false,
      env: { OPENAI_API_KEY: "test" },
      config,
      catalog: null,
      openrouterProvidersFromEnv: null,
      cliAvailability: { claude: true },
      isImplicitAutoSelection: true,
    });

    expect(attempts[0]?.userModelId).toBe("openai/gpt-5-mini");
  });

  it("prioritizes last successful CLI provider in auto CLI fallback mode", () => {
    const config: SummarizeConfig = {
      model: { mode: "auto", rules: [{ candidates: ["openai/gpt-5-mini"] }] },
    };
    const attempts = buildAutoModelAttempts({
      kind: "text",
      promptTokens: 100,
      desiredOutputTokens: 50,
      requiresVideoUnderstanding: false,
      env: {},
      config,
      catalog: null,
      openrouterProvidersFromEnv: null,
      cliAvailability: { claude: true, gemini: true },
      isImplicitAutoSelection: true,
      lastSuccessfulCliProvider: "gemini",
    });

    expect(attempts[0]?.userModelId).toBe("cli/gemini/gemini-3-flash-preview");
    expect(attempts[1]?.userModelId).toBe("cli/claude/sonnet");
  });
});
