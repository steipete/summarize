import { describe, expect, it } from "vitest";
import type { SummarizeConfig } from "../src/config.js";
import { resolveEnvState } from "../src/run/run-env.js";

describe("run env", () => {
  it("falls back to config zai.baseUrl when env is blank", () => {
    const configForCli: SummarizeConfig = {
      zai: { baseUrl: "https://api.zhipuai.cn/paas/v4" },
    };

    const state = resolveEnvState({
      env: {},
      envForRun: { Z_AI_BASE_URL: "   " },
      configForCli,
    });

    expect(state.zaiBaseUrl).toBe("https://api.zhipuai.cn/paas/v4");
  });
});
