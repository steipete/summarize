import { describe, expect, it } from "vitest";
import type { SummarizeConfig } from "../src/config.js";
import { resolveEnvState } from "../src/run/run-env.js";

describe("resolveEnvState", () => {
  it("resolves various API keys and configurations from env and config", () => {
    const envForRun = {
      OPENAI_API_KEY: "sk-openai",
      ANTHROPIC_API_KEY: "sk-anthropic",
      GEMINI_API_KEY: "sk-gemini",
      GROQ_API_KEY: "sk-groq",
      ASSEMBLYAI_API_KEY: "sk-assemblyai",
      XAI_API_KEY: "sk-xai",
      ZAI_API_KEY: "sk-zai",
      NVIDIA_API_KEY: "sk-nvidia",
      FAL_KEY: "sk-fal",
      FIRECRAWL_API_KEY: "sk-firecrawl",
      APIFY_API_TOKEN: "sk-apify",
      YT_DLP_PATH: "/custom/yt-dlp",
      SUMMARIZE_YT_DLP_COOKIES_FROM_BROWSER: "chrome",
    };

    const state = resolveEnvState({
      env: {},
      envForRun,
      configForCli: null,
    });

    expect(state.openaiApiKey).toBe("sk-openai");
    expect(state.anthropicApiKey).toBe("sk-anthropic");
    expect(state.googleApiKey).toBe("sk-gemini");
    expect(state.groqApiKey).toBe("sk-groq");
    expect(state.assemblyaiApiKey).toBe("sk-assemblyai");
    expect(state.xaiApiKey).toBe("sk-xai");
    expect(state.zaiApiKey).toBe("sk-zai");
    expect(state.nvidiaApiKey).toBe("sk-nvidia");
    expect(state.falApiKey).toBe("sk-fal");
    expect(state.firecrawlApiKey).toBe("sk-firecrawl");
    expect(state.apifyToken).toBe("sk-apify");
    expect(state.ytDlpPath).toBe("/custom/yt-dlp");
    expect(state.ytDlpCookiesFromBrowser).toBe("chrome");
    expect(state.googleConfigured).toBe(true);
    expect(state.anthropicConfigured).toBe(true);
    expect(state.firecrawlConfigured).toBe(true);
  });

  it("handles alternative env var names (GEMINI/GOOGLE, Z_AI/ZAI, NGC/NVIDIA)", () => {
    const state = resolveEnvState({
      env: {},
      envForRun: {
        GOOGLE_API_KEY: "sk-google",
        Z_AI_API_KEY: "sk-zai-alt",
        NGC_API_KEY: "sk-nvidia-alt",
        YT_DLP_COOKIES_FROM_BROWSER: "firefox",
      },
      configForCli: null,
    });

    expect(state.googleApiKey).toBe("sk-google");
    expect(state.zaiApiKey).toBe("sk-zai-alt");
    expect(state.nvidiaApiKey).toBe("sk-nvidia-alt");
    expect(state.ytDlpCookiesFromBrowser).toBe("firefox");
  });

  it("handles OpenRouter specific logic", () => {
    // Case 1: OpenRouter via base URL
    const state1 = resolveEnvState({
      env: {},
      envForRun: {
        OPENAI_BASE_URL: "https://openrouter.ai/api/v1",
        OPENROUTER_API_KEY: "sk-or",
      },
      configForCli: null,
    });
    expect(state1.openrouterApiKey).toBe("sk-or");
    expect(state1.apiKey).toBe("sk-or");

    // Case 2: OpenRouter via base URL but using OPENAI_API_KEY
    const state2 = resolveEnvState({
      env: {},
      envForRun: {
        OPENAI_BASE_URL: "https://openrouter.ai/api/v1",
        OPENAI_API_KEY: "sk-openai-as-or",
      },
      configForCli: null,
    });
    expect(state2.openrouterApiKey).toBe("sk-openai-as-or");
    expect(state2.apiKey).toBe("sk-openai-as-or");

    // Case 3: Explicit OPENROUTER_API_KEY without base URL override
    const state3 = resolveEnvState({
      env: {},
      envForRun: {
        OPENROUTER_API_KEY: "sk-or-explicit",
      },
      configForCli: null,
    });
    expect(state3.openrouterApiKey).toBe("sk-or-explicit");
    expect(state3.apiKey).toBeNull(); // apiKey follows OpenAI logic
  });

  it("resolves base URLs from env and config", () => {
    const state = resolveEnvState({
      env: {},
      envForRun: {
        OPENAI_BASE_URL: "https://custom-openai.com",
        GOOGLE_BASE_URL: "https://custom-google.com",
      },
      configForCli: {
        nvidia: { baseUrl: "https://custom-nvidia.com" },
      } satisfies SummarizeConfig,
    });

    expect(state.providerBaseUrls.openai).toBe("https://custom-openai.com");
    expect(state.providerBaseUrls.google).toBe("https://custom-google.com");
    expect(state.nvidiaBaseUrl).toBe("https://custom-nvidia.com");
  });

  it("trims whitespace from keys", () => {
    const state = resolveEnvState({
      env: {},
      envForRun: {
        OPENAI_API_KEY: "  sk-trim  ",
        GROQ_API_KEY: "  ",
      },
      configForCli: null,
    });

    expect(state.openaiApiKey).toBe("sk-trim");
    expect(state.groqApiKey).toBeNull();
  });
});
