import { describe, expect, it } from "vitest";
import { resolveApiKeyForModel } from "../src/daemon/agent-model.js";

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
});
