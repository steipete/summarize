import { describe, expect, it } from "vitest";
import { resolveConfigEnv } from "../src/config/env.js";
import { LEGACY_API_KEY_ENV_MAP } from "../src/config/legacy-api-keys.js";
import { parseModelConfig } from "../src/config/model.js";
import { parseCliProvider } from "../src/config/parse-helpers.js";
import { parseApiKeysConfig, parseCliConfig, parseOpenAiConfig } from "../src/config/sections.js";
import { resolveOpenAiCompatibleClientConfigForProvider } from "../src/llm/provider-capabilities.js";
import {
  CLI_PROVIDERS,
  getCliProviderProfile,
  getGatewayProviderProfile,
} from "../src/llm/provider-registry.js";
import { parseRequestedModelId } from "../src/model-spec.js";

const path = "/tmp/provider-config.json";
const compatibleProviders = ["zai", "nvidia", "minimax", "github-copilot", "ollama"] as const;

describe("provider registry contracts", () => {
  it.each(compatibleProviders)("rejects unprefixed %s names as unknown models", (provider) => {
    expect(() => parseRequestedModelId(provider)).toThrow("Unknown model");
    expect(() => parseRequestedModelId(`${provider}x`)).toThrow("Unknown model");
  });

  it.each(CLI_PROVIDERS)("uses the same %s provider in model IDs and configuration", (provider) => {
    const profile = getCliProviderProfile(provider);
    expect(parseCliProvider(` ${provider.toUpperCase()} `, path)).toBe(provider);
    expect(parseRequestedModelId(` CLI/ ${provider.toUpperCase()} `)).toMatchObject({
      transport: "cli",
      cliProvider: provider,
      cliModel: profile.defaultModel,
      requiredEnv: profile.requiredEnv,
    });
    expect(
      parseCliConfig({ cli: { [provider]: { binary: " executable ", model: " custom " } } }, path),
    ).toEqual({
      [provider]: { binary: "executable", model: "custom" },
    });
    expect(parseCliConfig({ cli: { [provider]: {} } }, path)).toEqual({ [provider]: {} });
    expect(parseCliConfig({ cli: { [provider]: false } }, path)).toBeUndefined();
    expect(() => parseCliConfig({ cli: { [provider]: { enabled: true } } }, path)).toThrow(
      `"cli.${provider}.enabled" is not supported`,
    );
  });

  it.each(compatibleProviders)("shares %s defaults without changing model spelling", (provider) => {
    const profile = getGatewayProviderProfile(provider);
    expect(parseRequestedModelId(` ${provider.toUpperCase()}/ MiXeD/Model `)).toEqual({
      kind: "fixed",
      transport: "native",
      userModelId: `${provider}/MiXeD/Model`,
      llmModelId: `${provider}/MiXeD/Model`,
      provider,
      openrouterProviders: null,
      forceOpenRouter: false,
      requiredEnv: profile.requiredEnv,
      openaiBaseUrlOverride: profile.defaultBaseUrl,
      forceChatCompletions: true,
    });
    expect(() => parseRequestedModelId(`${provider}/  `)).toThrow(
      `Invalid model id: ${provider}/… is missing the model id`,
    );
    const client = resolveOpenAiCompatibleClientConfigForProvider({
      provider,
      openaiApiKey: "synthetic-key",
      openrouterApiKey: null,
      requestOptions: { serviceTier: "flex" },
    });
    expect(client.baseURL).toBe(profile.defaultBaseUrl);
    expect(client.requestOptions).toEqual(
      provider === "github-copilot" ? undefined : { serviceTier: "flex" },
    );
  });

  it("keeps legacy keys separate from the model-provider inventory", () => {
    const apiKeys = Object.fromEntries(
      Object.keys(LEGACY_API_KEY_ENV_MAP).map((provider) => [
        ` ${provider.toUpperCase()} `,
        " synthetic-key ",
      ]),
    );
    const parsed = parseApiKeysConfig({ apiKeys }, path);
    expect(resolveConfigEnv({ apiKeys: parsed })).toEqual(
      Object.fromEntries(
        Object.values(LEGACY_API_KEY_ENV_MAP).map((name) => [name, "synthetic-key"]),
      ),
    );
    for (const unsupported of ["deepgram", "ollama", "github-copilot", "constructor", "toString"]) {
      expect(() =>
        parseApiKeysConfig({ apiKeys: { [unsupported]: "synthetic-key" } }, path),
      ).toThrow("unknown apiKeys provider");
    }
  });

  it("shares request-option aliases and conflict validation across config scopes", () => {
    const options = { serviceTier: " flex ", thinking: "extra-high", textVerbosity: "LOW" };
    const expected = { serviceTier: "flex", reasoningEffort: "xhigh", textVerbosity: "low" };
    expect(parseOpenAiConfig({ openai: options }, path)).toEqual(expected);
    expect(parseModelConfig({ id: "openai/example", ...options }, path, "models.test")).toEqual({
      id: "openai/example",
      ...expected,
    });
    const conflict = { reasoningEffort: "high", thinking: "low" };
    expect(() => parseOpenAiConfig({ openai: conflict }, path)).toThrow(
      '"openai.reasoningEffort" and "openai.thinking" must not conflict',
    );
    expect(() =>
      parseModelConfig({ id: "openai/example", ...conflict }, path, "models.test"),
    ).toThrow('"models.test.reasoningEffort" and "models.test.thinking" must not conflict');
  });
});
