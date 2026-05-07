import { describe, expect, it } from "vitest";
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
