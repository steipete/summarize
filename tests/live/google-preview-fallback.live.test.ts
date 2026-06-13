import { describe, expect, it } from "vitest";
import { generateTextWithModelId } from "../../src/llm/generate-text.js";

const LIVE = process.env.SUMMARIZE_LIVE_TEST === "1";

(LIVE ? describe : describe.skip)("live Google preview compatibility", () => {
  const timeoutMs = 120_000;

  it(
    "returns non-empty text for google/gemini-3-flash-preview",
    async ({ skip }) => {
      const googleApiKey =
        process.env.GEMINI_API_KEY ??
        process.env.GOOGLE_GENERATIVE_AI_API_KEY ??
        process.env.GOOGLE_API_KEY ??
        null;
      if (!googleApiKey) {
        skip("requires GEMINI_API_KEY");
      }

      const result = await generateTextWithModelId({
        modelId: "google/gemini-3-flash-preview",
        apiKeys: {
          xaiApiKey: null,
          openaiApiKey: null,
          googleApiKey,
          anthropicApiKey: null,
          openrouterApiKey: null,
        },
        prompt: { userText: "Say exactly: ok" },
        maxOutputTokens: 32,
        timeoutMs,
        fetchImpl: globalThis.fetch.bind(globalThis),
      });

      expect(result.text.trim().length).toBeGreaterThan(0);
    },
    timeoutMs,
  );
});
