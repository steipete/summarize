import { isOpenRouterBaseUrl, normalizeBaseUrl } from "@steipete/summarize-core";
import type { ModelRequestOptions } from "./model-options.js";
import type { OpenAiClientConfig } from "./providers/types.js";

export type OpenAiClientConfigInput = {
  apiKeys: {
    openaiApiKey: string | null;
    openrouterApiKey: string | null;
  };
  forceOpenRouter?: boolean;
  openaiBaseUrlOverride?: string | null;
  forceChatCompletions?: boolean;
  requestOptions?: ModelRequestOptions;
};

export function resolveOpenAiClientConfig({
  apiKeys,
  forceOpenRouter,
  openaiBaseUrlOverride,
  forceChatCompletions,
  requestOptions,
}: OpenAiClientConfigInput): OpenAiClientConfig {
  const baseUrlRaw =
    openaiBaseUrlOverride ??
    (typeof process !== "undefined" ? process.env.OPENAI_BASE_URL : undefined);
  const baseUrl = normalizeBaseUrl(baseUrlRaw);
  const isOpenRouterViaBaseUrl = baseUrl ? isOpenRouterBaseUrl(baseUrl) : false;
  const hasOpenRouterKey = apiKeys.openrouterApiKey != null;
  const hasOpenAiKey = apiKeys.openaiApiKey != null;
  const isOpenRouter =
    Boolean(forceOpenRouter) ||
    isOpenRouterViaBaseUrl ||
    (hasOpenRouterKey && !baseUrl && !hasOpenAiKey);

  const apiKey = isOpenRouter
    ? (apiKeys.openrouterApiKey ?? apiKeys.openaiApiKey)
    : apiKeys.openaiApiKey;
  if (!apiKey) {
    throw new Error(
      isOpenRouter
        ? "Missing OPENROUTER_API_KEY (or OPENAI_API_KEY) for OpenRouter"
        : "Missing OPENAI_API_KEY for openai/... model",
    );
  }

  const baseURL = forceOpenRouter
    ? "https://openrouter.ai/api/v1"
    : (baseUrl ?? (isOpenRouter ? "https://openrouter.ai/api/v1" : undefined));

  const isCustomBaseURL = (() => {
    if (!baseURL) return false;
    try {
      const url = new URL(baseURL);
      return url.host !== "api.openai.com" && url.host !== "openrouter.ai";
    } catch {
      return false;
    }
  })();

  const useChatCompletions = isOpenRouter
    ? true
    : typeof forceChatCompletions === "boolean"
      ? forceChatCompletions
      : isCustomBaseURL;
  return {
    apiKey,
    baseURL: baseURL ?? undefined,
    useChatCompletions,
    isOpenRouter,
    ...(requestOptions ? { requestOptions } : {}),
  };
}
