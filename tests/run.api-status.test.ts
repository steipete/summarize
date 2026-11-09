import { describe, expect, it } from "vitest";
import { resolveRunApiStatus } from "../src/application/api-status.js";
import { resolveEnvState } from "../src/application/environment-state.js";

describe("run API status", () => {
  it("projects provider and extraction runtime state without CLI selection fields", () => {
    const env = {
      OPENAI_API_KEY: "openai",
      OPENROUTER_API_KEY: "openrouter",
      GEMINI_API_KEY: "google",
      ANTHROPIC_API_KEY: "anthropic",
      NVIDIA_API_KEY: "nvidia",
      ZAI_API_KEY: "zai",
      MINIMAX_API_KEY: "minimax",
      FIRECRAWL_API_KEY: "firecrawl",
      APIFY_API_TOKEN: "apify",
      FAL_KEY: "fal",
      GROQ_API_KEY: "groq",
      ASSEMBLYAI_API_KEY: "assembly",
      DEEPGRAM_API_KEY: "deepgram",
      ELEVENLABS_API_KEY: "eleven",
    };
    const envState = resolveEnvState({ env, envForRun: env, configForCli: null });
    const status = resolveRunApiStatus(envState);

    expect(status).toMatchObject({
      apiKey: "openai",
      openrouterApiKey: "openrouter",
      googleApiKey: "google",
      anthropicApiKey: "anthropic",
      nvidiaApiKey: "nvidia",
      zaiApiKey: "zai",
      minimaxApiKey: "minimax",
      firecrawlApiKey: "firecrawl",
      apifyToken: "apify",
      falApiKey: "fal",
      groqApiKey: "groq",
      assemblyaiApiKey: "assembly",
      deepgramApiKey: "deepgram",
      elevenlabsApiKey: "eleven",
    });
    expect(status).not.toHaveProperty("cliAvailability");
    expect(status).not.toHaveProperty("envForAuto");
  });
});
