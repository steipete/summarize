import { describe, expect, it } from "vitest";
import { parseOutputLanguage } from "../src/language.js";
import { resolveModelSelection } from "../src/run/run-models.js";

describe("run model selection", () => {
  it("resolves built-in GPT fast presets", () => {
    for (const name of ["gpt-fast", "fast"]) {
      const result = resolveModelSelection({
        config: null,
        configForCli: null,
        configPath: null,
        envForRun: {},
        explicitModelArg: name,
      });

      expect(result.isNamedModelSelection).toBe(true);
      expect(result.requestedModelInput).toBe(name);
      expect(result.requestedModelLabel).toBe(name);
      expect(result.requestedModel.kind).toBe("fixed");
      if (result.requestedModel.kind === "fixed") {
        expect(result.requestedModel.userModelId).toBe("openai/gpt-5.5");
        expect(result.requestedModel.transport).toBe("native");
        expect(result.requestedModel.llmModelId).toBe("openai/gpt-5.5");
        expect(result.requestedModel.requiredEnv).toBe("OPENAI_API_KEY");
        expect(result.requestedModel.requestOptions).toEqual({
          serviceTier: "fast",
          reasoningEffort: "medium",
        });
      }
    }
  });

  it("keeps the Codex fast preset available explicitly", () => {
    const result = resolveModelSelection({
      config: null,
      configForCli: null,
      configPath: null,
      envForRun: {},
      explicitModelArg: "codex-fast",
    });

    expect(result.requestedModel.kind).toBe("fixed");
    expect(result.requestedModel.userModelId).toBe("cli/codex/gpt-fast");
    if (result.requestedModel.kind === "fixed" && result.requestedModel.transport === "cli") {
      expect(result.requestedModel.cliProvider).toBe("codex");
      expect(result.requestedModel.cliModel).toBe("gpt-fast");
    }
  });

  it("lets config override the built-in GPT fast preset", () => {
    const result = resolveModelSelection({
      config: { models: { "gpt-fast": { id: "openai/gpt-5-nano" } } },
      configForCli: { models: { "gpt-fast": { id: "openai/gpt-5-nano" } } },
      configPath: null,
      envForRun: {},
      explicitModelArg: "gpt-fast",
    });

    expect(result.requestedModel.kind).toBe("fixed");
    if (result.requestedModel.kind === "fixed") {
      expect(result.requestedModel.userModelId).toBe("openai/gpt-5-nano");
    }
  });

  it("resolves provider-default OpenCode ids through summarize config", () => {
    const config = {
      cli: {
        opencode: {
          model: "openai/gpt-5.4",
        },
      },
    };

    const result = resolveModelSelection({
      config,
      configForCli: config,
      configPath: null,
      envForRun: {},
      explicitModelArg: "cli/opencode",
    });

    expect(result.requestedModel.kind).toBe("fixed");
    expect(result.requestedModel.userModelId).toBe("cli/opencode/openai/gpt-5.4");
    expect(result.requestedModelLabel).toBe("cli/opencode/openai/gpt-5.4");
    if (result.requestedModel.kind === "fixed" && result.requestedModel.transport === "cli") {
      expect(result.requestedModel.cliProvider).toBe("opencode");
      expect(result.requestedModel.cliModel).toBe("openai/gpt-5.4");
    }
  });

  it("resolves provider-default Copilot CLI ids through summarize config", () => {
    const config = {
      cli: {
        opencode: {
          model: "openai/gpt-5.4",
        },
        copilot: {
          model: "gpt-5.2",
        },
      },
    };

    const result = resolveModelSelection({
      config,
      configForCli: config,
      configPath: null,
      envForRun: {},
      explicitModelArg: "cli/copilot",
    });

    expect(result.requestedModel.kind).toBe("fixed");
    expect(result.requestedModel.userModelId).toBe("cli/copilot/gpt-5.2");
    expect(result.requestedModelLabel).toBe("cli/copilot/gpt-5.2");
    if (result.requestedModel.kind === "fixed" && result.requestedModel.transport === "cli") {
      expect(result.requestedModel.cliProvider).toBe("copilot");
      expect(result.requestedModel.cliModel).toBe("gpt-5.2");
    }
  });

  it("keeps bare OpenCode ids when no configured model is available", () => {
    const result = resolveModelSelection({
      config: { cli: { opencode: { model: "   " } } },
      configForCli: { cli: { opencode: { model: "   " } } },
      configPath: null,
      envForRun: {},
      explicitModelArg: "cli/opencode",
    });

    expect(result.requestedModel.kind).toBe("fixed");
    expect(result.requestedModel.userModelId).toBe("cli/opencode");
    expect(result.requestedModelLabel).toBe("cli/opencode");
    if (result.requestedModel.kind === "fixed" && result.requestedModel.transport === "cli") {
      expect(result.requestedModel.cliProvider).toBe("opencode");
      expect(result.requestedModel.cliModel).toBeNull();
    }
  });

  it("does not override explicit OpenCode model ids from config defaults", () => {
    const config = {
      cli: {
        opencode: {
          model: "openai/gpt-5.2",
        },
      },
    };

    const result = resolveModelSelection({
      config,
      configForCli: config,
      configPath: null,
      envForRun: {},
      explicitModelArg: "cli/opencode/openai/gpt-5.4",
    });

    expect(result.requestedModel.kind).toBe("fixed");
    expect(result.requestedModel.userModelId).toBe("cli/opencode/openai/gpt-5.4");
    expect(result.requestedModelLabel).toBe("cli/opencode/openai/gpt-5.4");
    if (result.requestedModel.kind === "fixed" && result.requestedModel.transport === "cli") {
      expect(result.requestedModel.cliProvider).toBe("opencode");
      expect(result.requestedModel.cliModel).toBe("openai/gpt-5.4");
    }
  });

  it("resolves named bare OpenCode models through cli config", () => {
    const config = {
      models: {
        localCli: {
          id: "cli/opencode",
        },
      },
      cli: {
        opencode: {
          model: "openai/gpt-5.4",
        },
      },
    };

    const result = resolveModelSelection({
      config,
      configForCli: config,
      configPath: "/tmp/summarize.json",
      envForRun: {},
      explicitModelArg: "localCli",
    });

    expect(result.isNamedModelSelection).toBe(true);
    expect(result.requestedModel.kind).toBe("fixed");
    expect(result.requestedModelLabel).toBe("localCli");
    if (result.requestedModel.kind === "fixed" && result.requestedModel.transport === "cli") {
      expect(result.requestedModel.userModelId).toBe("cli/opencode/openai/gpt-5.4");
      expect(result.requestedModel.cliProvider).toBe("opencode");
      expect(result.requestedModel.cliModel).toBe("openai/gpt-5.4");
    }
  });

  it("uses SUMMARIZE_MODEL when no explicit model is passed", () => {
    const result = resolveModelSelection({
      config: null,
      configForCli: null,
      configPath: null,
      envForRun: { SUMMARIZE_MODEL: "cli/opencode/openai/gpt-5.4" },
      explicitModelArg: null,
    });

    expect(result.requestedModelInput).toBe("cli/opencode/openai/gpt-5.4");
    expect(result.requestedModelLabel).toBe("cli/opencode/openai/gpt-5.4");
    expect(result.isImplicitAutoSelection).toBe(false);
    expect(result.isFallbackModel).toBe(false);
  });

  it("uses the configured named model when no explicit model is passed", () => {
    const config = {
      model: { name: "localCli" as const },
      models: {
        localCli: {
          id: "cli/opencode",
        },
      },
      cli: {
        opencode: {
          model: "openai/gpt-5.4",
        },
      },
    };

    const result = resolveModelSelection({
      config,
      configForCli: config,
      configPath: "/tmp/summarize.json",
      envForRun: {},
      explicitModelArg: null,
    });

    expect(result.requestedModelInput).toBe("localCli");
    expect(result.isNamedModelSelection).toBe(true);
    expect(result.requestedModelLabel).toBe("localCli");
    if (result.requestedModel.kind === "fixed" && result.requestedModel.transport === "cli") {
      expect(result.requestedModel.userModelId).toBe("cli/opencode/openai/gpt-5.4");
    }
  });

  it("routes English output to the configured local model when auto is selected", () => {
    const result = resolveModelSelection({
      config: {
        localRouting: {
          enabled: true,
          englishModel: "gemma-local",
          fallbackModel: "llama-local",
        },
      },
      configForCli: null,
      configPath: null,
      envForRun: {},
      explicitModelArg: null,
      outputLanguage: parseOutputLanguage("en"),
    });

    expect(result.requestedModelInput).toBe("openai/gemma-local");
    expect(result.requestedModelLabel).toBe("openai/gemma-local");
    expect(result.isFallbackModel).toBe(false);
    expect(result.requestedModel.kind).toBe("fixed");
    if (result.requestedModel.kind === "fixed") {
      expect(result.requestedModel.userModelId).toBe("openai/gemma-local");
    }
  });

  it("routes Traditional Chinese output to the configured local model", () => {
    const result = resolveModelSelection({
      config: {
        localRouting: {
          enabled: true,
          traditionalChineseModel: "openai/qwen3-local",
          fallbackModel: "llama-local",
        },
      },
      configForCli: null,
      configPath: null,
      envForRun: {},
      explicitModelArg: "auto",
      outputLanguage: parseOutputLanguage("Traditional Chinese"),
    });

    expect(result.requestedModelInput).toBe("openai/qwen3-local");
    expect(result.requestedModelLabel).toBe("openai/qwen3-local");
    expect(result.requestedModel.kind).toBe("fixed");
    if (result.requestedModel.kind === "fixed") {
      expect(result.requestedModel.userModelId).toBe("openai/qwen3-local");
    }
  });

  it("routes bilingual output to the configured local model", () => {
    const result = resolveModelSelection({
      config: {
        localRouting: {
          enabled: true,
          bilingualModel: "qwen3-bilingual-local",
          fallbackModel: "llama-local",
        },
      },
      configForCli: null,
      configPath: null,
      envForRun: {},
      explicitModelArg: null,
      outputLanguage: parseOutputLanguage("en+zh-TW bilingual"),
    });

    expect(result.requestedModelInput).toBe("openai/qwen3-bilingual-local");
    expect(result.requestedModel.kind).toBe("fixed");
    if (result.requestedModel.kind === "fixed") {
      expect(result.requestedModel.userModelId).toBe("openai/qwen3-bilingual-local");
    }
  });

  it("uses the fallback local model for auto or unknown output language", () => {
    const result = resolveModelSelection({
      config: {
        localRouting: {
          enabled: true,
          fallbackModel: "llama-local",
        },
      },
      configForCli: null,
      configPath: null,
      envForRun: {},
      explicitModelArg: null,
      outputLanguage: parseOutputLanguage("auto"),
    });

    expect(result.requestedModelInput).toBe("openai/llama-local");
    expect(result.requestedModel.kind).toBe("fixed");
    if (result.requestedModel.kind === "fixed") {
      expect(result.requestedModel.userModelId).toBe("openai/llama-local");
    }
  });

  it("keeps auto selection unchanged when local routing is disabled or missing", () => {
    const disabled = resolveModelSelection({
      config: { localRouting: { enabled: false, englishModel: "gemma-local" } },
      configForCli: null,
      configPath: null,
      envForRun: {},
      explicitModelArg: null,
      outputLanguage: parseOutputLanguage("en"),
    });
    const missing = resolveModelSelection({
      config: null,
      configForCli: null,
      configPath: null,
      envForRun: {},
      explicitModelArg: null,
      outputLanguage: parseOutputLanguage("en"),
    });

    expect(disabled.requestedModel.kind).toBe("auto");
    expect(disabled.requestedModelInput).toBe("auto");
    expect(missing.requestedModel.kind).toBe("auto");
    expect(missing.requestedModelInput).toBe("auto");
  });

  it("uses default local routing models when a bucket model is not configured", () => {
    const english = resolveModelSelection({
      config: { localRouting: { enabled: true } },
      configForCli: null,
      configPath: null,
      envForRun: {},
      explicitModelArg: null,
      outputLanguage: parseOutputLanguage("English"),
    });
    const traditionalChinese = resolveModelSelection({
      config: { localRouting: { enabled: true } },
      configForCli: null,
      configPath: null,
      envForRun: {},
      explicitModelArg: null,
      outputLanguage: parseOutputLanguage("zh-Hant"),
    });
    const bilingual = resolveModelSelection({
      config: { localRouting: { enabled: true } },
      configForCli: null,
      configPath: null,
      envForRun: {},
      explicitModelArg: null,
      outputLanguage: parseOutputLanguage("en+zh-TW bilingual"),
    });
    const fallback = resolveModelSelection({
      config: { localRouting: { enabled: true } },
      configForCli: null,
      configPath: null,
      envForRun: {},
      explicitModelArg: null,
      outputLanguage: parseOutputLanguage("auto"),
    });

    expect(english.requestedModelInput).toBe("openai/gemma4-31b");
    expect(traditionalChinese.requestedModelInput).toBe("openai/qwen3.6-27b");
    expect(bilingual.requestedModelInput).toBe("openai/qwen3.6-27b");
    expect(fallback.requestedModelInput).toBe("openai/gemma4-31b");
  });

  it("routes common Traditional Chinese aliases to the Qwen local default", () => {
    for (const language of [
      "Traditional Chinese",
      "Chinese (Traditional)",
      "\u7e41\u4e2d",
      "\u7e41\u9ad4\u4e2d\u6587",
      "\u6b63\u9ad4\u4e2d\u6587",
    ]) {
      const resolved = resolveModelSelection({
        config: { localRouting: { enabled: true } },
        configForCli: null,
        configPath: null,
        envForRun: {},
        explicitModelArg: null,
        outputLanguage: parseOutputLanguage(language),
      });

      expect(resolved.requestedModelInput, language).toBe("openai/qwen3.6-27b");
    }
  });

  it("falls back to bucket defaults for retired local routing model inputs", () => {
    const retiredQwen = ["qwen3.6", "35b", "a3b"].join("-");
    const traditionalChinese = resolveModelSelection({
      config: {
        localRouting: {
          enabled: true,
          traditionalChineseModel: retiredQwen,
          fallbackModel: "gemma-local",
        },
      },
      configForCli: null,
      configPath: null,
      envForRun: {},
      explicitModelArg: null,
      outputLanguage: parseOutputLanguage("zh-Hant"),
    });
    const bilingual = resolveModelSelection({
      config: {
        localRouting: {
          enabled: true,
          bilingualModel: `openai/${retiredQwen}`,
          fallbackModel: "gemma-local",
        },
      },
      configForCli: null,
      configPath: null,
      envForRun: {},
      explicitModelArg: null,
      outputLanguage: parseOutputLanguage("en+zh-TW bilingual"),
    });

    expect(traditionalChinese.requestedModelInput).toBe("openai/qwen3.6-27b");
    expect(bilingual.requestedModelInput).toBe("openai/qwen3.6-27b");
  });

  it("does not override explicit fixed models with local routing", () => {
    const explicit = resolveModelSelection({
      config: {
        localRouting: {
          enabled: true,
          englishModel: "gemma-local",
        },
      },
      configForCli: null,
      configPath: null,
      envForRun: {},
      explicitModelArg: "openai/gpt-5.2",
      outputLanguage: parseOutputLanguage("en"),
    });

    expect(explicit.requestedModelInput).toBe("openai/gpt-5.2");
    expect(explicit.requestedModel.kind).toBe("fixed");
    if (explicit.requestedModel.kind === "fixed") {
      expect(explicit.requestedModel.userModelId).toBe("openai/gpt-5.2");
    }
  });

  it("keeps Gemini 3.1 Pro explicit when local routing defaults apply", () => {
    const explicit = resolveModelSelection({
      config: { localRouting: { enabled: true } },
      configForCli: null,
      configPath: null,
      envForRun: {},
      explicitModelArg: "google/gemini-3.1-pro",
      outputLanguage: parseOutputLanguage("Traditional Chinese"),
    });

    expect(explicit.requestedModelInput).toBe("google/gemini-3.1-pro");
    expect(explicit.selectionSource).toBe("explicit");
    expect(explicit.requestedModel.kind).toBe("fixed");
    if (explicit.requestedModel.kind === "fixed") {
      expect(explicit.requestedModel.userModelId).toBe("google/gemini-3.1-pro");
    }
  });

  it("does not override env or config fixed model defaults with local routing", () => {
    const envDefault = resolveModelSelection({
      config: { localRouting: { enabled: true, englishModel: "gemma-local" } },
      configForCli: null,
      configPath: null,
      envForRun: { SUMMARIZE_MODEL: "openai/gpt-env" },
      explicitModelArg: null,
      outputLanguage: parseOutputLanguage("en"),
    });
    const configDefault = resolveModelSelection({
      config: {
        model: { id: "openai/gpt-config" },
        localRouting: { enabled: true, englishModel: "gemma-local" },
      },
      configForCli: null,
      configPath: null,
      envForRun: {},
      explicitModelArg: null,
      outputLanguage: parseOutputLanguage("en"),
    });

    expect(envDefault.requestedModelInput).toBe("openai/gpt-env");
    expect(configDefault.requestedModelInput).toBe("openai/gpt-config");
  });

  it("keeps bare --cli auto behavior out of local routing", () => {
    const result = resolveModelSelection({
      config: { localRouting: { enabled: true, englishModel: "gemma-local" } },
      configForCli: null,
      configPath: null,
      envForRun: {},
      explicitModelArg: "auto",
      outputLanguage: parseOutputLanguage("en"),
      allowLanguageAwareLocalRouting: false,
    });

    expect(result.requestedModel.kind).toBe("auto");
    expect(result.requestedModelInput).toBe("auto");
  });

  it("rejects unknown bare model ids with a config hint", () => {
    expect(() =>
      resolveModelSelection({
        config: null,
        configForCli: null,
        configPath: "/tmp/summarize.json",
        envForRun: {},
        explicitModelArg: "unknown",
      }),
    ).toThrow(/Define it in \/tmp\/summarize\.json under "models"/);
  });

  it("rejects named models that only alias another preset", () => {
    expect(() =>
      resolveModelSelection({
        config: {
          models: {
            nestedAlias: {
              name: "otherPreset",
            },
          },
        },
        configForCli: null,
        configPath: "/tmp/summarize.json",
        envForRun: {},
        explicitModelArg: "nestedAlias",
      }),
    ).toThrow(/unsupported model config/);
  });
});
