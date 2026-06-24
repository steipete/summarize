import { getModels } from "@earendil-works/pi-ai/compat";
import { describe, expect, it } from "vitest";
import type { SummarizeConfig } from "../../src/config.js";
import { generateTextWithModelId } from "../../src/llm/generate-text.js";
import { buildAutoModelAttempts } from "../../src/model-auto.js";

const LIVE = process.env.SUMMARIZE_LIVE_TEST === "1";

function shouldSoftSkipLiveError(message: string): boolean {
  return /(model.*not found|does not exist|permission|access|unauthorized|forbidden|404|not_found|model_not_found|no allowed providers are available|rate limit)/i.test(
    message,
  );
}

(LIVE ? describe : describe.skip)("live OpenRouter auto fallback", () => {
  const timeoutMs = 120_000;

  it(
    "maps native model to OpenRouter id and returns text",
    async ({ skip }) => {
      const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY?.trim() ?? "";
      if (!OPENROUTER_API_KEY) {
        skip("requires OPENROUTER_API_KEY");
      }

      const config: SummarizeConfig = {
        model: { mode: "auto", rules: [{ candidates: ["xai/grok-4-1-fast"] }] },
      };

      const attempts = buildAutoModelAttempts({
        kind: "text",
        promptTokens: 100,
        desiredOutputTokens: 50,
        requiresVideoUnderstanding: false,
        env: { OPENROUTER_API_KEY },
        config,
        catalog: null,
        openrouterProvidersFromEnv: null,
      });

      const openrouterAttempt = attempts.find((attempt) => attempt.forceOpenRouter);
      expect(openrouterAttempt).toBeTruthy();
      const openrouterModelId = (openrouterAttempt?.userModelId ?? "").replace(/^openrouter\//, "");

      const openrouterCatalog = new Set(
        getModels("openrouter").map((model) => model.id.toLowerCase()),
      );
      expect(openrouterCatalog.has(openrouterModelId.toLowerCase())).toBe(true);

      if (!openrouterAttempt?.llmModelId) return;

      try {
        const result = await generateTextWithModelId({
          modelId: openrouterAttempt.llmModelId,
          apiKeys: {
            xaiApiKey: null,
            openaiApiKey: null,
            googleApiKey: null,
            anthropicApiKey: null,
            openrouterApiKey: OPENROUTER_API_KEY,
          },
          prompt: { userText: "Say exactly: ok" },
          maxOutputTokens: 32,
          timeoutMs,
          fetchImpl: globalThis.fetch.bind(globalThis),
          forceOpenRouter: true,
        });
        expect(result.text.trim().length).toBeGreaterThan(0);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (shouldSoftSkipLiveError(message)) return;
        throw error;
      }
    },
    timeoutMs,
  );
});
