import type { Api, Model } from "@earendil-works/pi-ai";

// Standard USD per million tokens: https://developers.openai.com/api/docs/pricing
// `requiresReasoning`: the model rejects `reasoning.effort: "none"`.
export const OPENAI_GPT6_MODELS = [
  { id: "gpt-6-astra", name: "GPT-6 Astra", input: 10, output: 50, requiresReasoning: true },
  { id: "gpt-6-sol", name: "GPT-6 Sol", input: 2, output: 10, requiresReasoning: false },
  { id: "gpt-6-luna", name: "GPT-6 Luna", input: 0.1, output: 0.5, requiresReasoning: false },
  { id: "gpt-6.1-sol", name: "GPT-6.1 Sol", input: 2, output: 10, requiresReasoning: true },
] as const;

export function findOpenAiGpt6Entry(modelId: string) {
  return OPENAI_GPT6_MODELS.find((model) => model.id === modelId.toLowerCase());
}

export function getOpenAiGpt6Model(modelId: string): Model<Api> | null {
  const entry = OPENAI_GPT6_MODELS.find((model) => model.id === modelId);
  if (!entry) return null;
  return {
    id: entry.id,
    name: entry.name,
    provider: "openai",
    api: "openai-responses",
    baseUrl: "https://api.openai.com/v1",
    reasoning: true,
    input: ["text", "image"],
    contextWindow: 1_050_000,
    maxTokens: 128_000,
    cost: {
      input: entry.input,
      output: entry.output,
      cacheRead: entry.input * 0.1,
      cacheWrite: entry.input * 1.25,
    },
  };
}
