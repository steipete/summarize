import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { resolveConfigState } from "../src/run/run-config.js";

function resolveTestConfigState(programOpts: Record<string, unknown>) {
  return resolveConfigState({
    envForRun: { HOME: mkdtempSync(join(tmpdir(), "summarize-run-config-")) },
    programOpts: { videoMode: "auto", ...programOpts },
    languageExplicitlySet: false,
    videoModeExplicitlySet: false,
    cliFlagPresent: false,
    cliProviderArg: null,
  });
}

function resolveTestConfigStateWithEnv(
  envForRun: Record<string, string | undefined>,
  programOpts: Record<string, unknown> = {},
) {
  return resolveConfigState({
    envForRun: {
      HOME: mkdtempSync(join(tmpdir(), "summarize-run-config-")),
      ...envForRun,
    },
    programOpts: { videoMode: "auto", ...programOpts },
    languageExplicitlySet: false,
    videoModeExplicitlySet: false,
    cliFlagPresent: false,
    cliProviderArg: null,
  });
}

describe("run config", () => {
  it("maps --fast and --thinking to OpenAI request overrides", () => {
    expect(
      resolveTestConfigState({ fast: true, thinking: "mid" }).openaiRequestOptionsOverride,
    ).toEqual({
      serviceTier: "fast",
      reasoningEffort: "medium",
    });
  });

  it("maps --service-tier to OpenAI request overrides", () => {
    expect(resolveTestConfigState({ serviceTier: "flex" }).openaiRequestOptionsOverride).toEqual({
      serviceTier: "flex",
    });
  });

  it("lets --service-tier default explicitly clear a configured tier", () => {
    expect(resolveTestConfigState({ serviceTier: "default" }).openaiRequestOptionsOverride).toEqual(
      {
        serviceTier: "default",
      },
    );
  });

  it("rejects conflicting --fast and --service-tier values", () => {
    expect(() => resolveTestConfigState({ fast: true, serviceTier: "flex" })).toThrow(
      /Use either --fast or --service-tier/,
    );
  });

  it("keeps OPENAI_USE_CHAT_COMPLETIONS=false as an explicit false value", () => {
    expect(
      resolveTestConfigStateWithEnv({ OPENAI_USE_CHAT_COMPLETIONS: "false" })
        .openaiUseChatCompletions,
    ).toBe(false);
  });

  it("leaves openaiUseChatCompletions unset when there is no env or config override", () => {
    expect(resolveTestConfigState({}).openaiUseChatCompletions).toBeUndefined();
  });
});
