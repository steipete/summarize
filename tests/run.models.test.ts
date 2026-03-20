import { describe, expect, it } from "vitest";
import { resolveModelSelection } from "../src/run/run-models.js";

describe("run model selection", () => {
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
});
