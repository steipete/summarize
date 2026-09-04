import type { ModelRequestOptions } from "./model-options.js";

export type LlmApiKeys = {
  xaiApiKey: string | null;
  openaiApiKey: string | null;
  googleApiKey: string | null;
  anthropicApiKey: string | null;
  openrouterApiKey: string | null;
};

export type LlmRequestOptions = {
  modelId: string;
  apiKeys: LlmApiKeys;
  temperature?: number;
  maxOutputTokens?: number;
  timeoutMs: number;
  fetchImpl: typeof fetch;
  forceOpenRouter?: boolean;
  openaiBaseUrlOverride?: string | null;
  anthropicBaseUrlOverride?: string | null;
  googleBaseUrlOverride?: string | null;
  xaiBaseUrlOverride?: string | null;
  ollamaBaseUrlOverride?: string | null;
  forceChatCompletions?: boolean;
  requestOptions?: ModelRequestOptions;
};
