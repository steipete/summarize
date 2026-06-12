import type { Context } from "@earendil-works/pi-ai";
import { completeSimple } from "@earendil-works/pi-ai";
import { maybeGenerateDocumentText } from "./generate-text-document.js";
import {
  computeRetryDelayMs,
  isGoogleEmptySummaryError,
  isRetryableTimeoutError,
  promptToContext,
  resolveEffectiveTemperature,
  resolveGoogleEmptyResponseFallbackModelId,
  shouldRetryGpt5WithoutTokenCap,
  sleep,
} from "./generate-text-shared.js";
import { streamTextWithContext } from "./generate-text-stream.js";
import type { LlmApiKeys } from "./generate-text-types.js";
import { parseGatewayStyleModelId } from "./model-id.js";
import type { LlmProvider } from "./model-id.js";
import type { ModelRequestOptions } from "./model-options.js";
import type { Prompt } from "./prompt.js";
import {
  getGatewayProviderProfile,
  isOpenAiCompatibleProvider,
  resolveOpenAiCompatibleClientConfigForProvider,
} from "./provider-capabilities.js";
import {
  completeAnthropicText,
  normalizeAnthropicModelAccessError,
} from "./providers/anthropic.js";
import { completeGoogleText } from "./providers/google.js";
import { enableMinimaxReasoningSplit } from "./providers/minimax.js";
import {
  resolveAnthropicModel,
  resolveGoogleModel,
  resolveOpenAiCompatibleGatewayModel,
  resolveXaiModel,
} from "./providers/models.js";
import { completeOpenAiText } from "./providers/openai.js";
import { extractText } from "./providers/shared.js";
import type { OpenAiClientConfig } from "./providers/types.js";
import type { LlmTokenUsage } from "./types.js";
import { normalizeTokenUsage } from "./usage.js";
export { streamTextWithContext } from "./generate-text-stream.js";

export type { LlmApiKeys } from "./generate-text-types.js";

export type OpenRouterOptions = {
  providers: string[] | null;
};

export type { LlmTokenUsage } from "./types.js";

type RetryNotice = {
  attempt: number;
  maxRetries: number;
  delayMs: number;
  error: unknown;
};

export async function generateTextWithModelId({
  modelId,
  apiKeys,
  prompt,
  temperature,
  maxOutputTokens,
  timeoutMs,
  fetchImpl,
  forceOpenRouter,
  openaiBaseUrlOverride,
  anthropicBaseUrlOverride,
  googleBaseUrlOverride,
  xaiBaseUrlOverride,
  zaiBaseUrlOverride,
  ollamaBaseUrlOverride,
  forceChatCompletions,
  requestOptions,
  retries = 0,
  onRetry,
}: {
  modelId: string;
  apiKeys: LlmApiKeys;
  prompt: Prompt;
  temperature?: number;
  maxOutputTokens?: number;
  timeoutMs: number;
  fetchImpl: typeof fetch;
  forceOpenRouter?: boolean;
  openaiBaseUrlOverride?: string | null;
  anthropicBaseUrlOverride?: string | null;
  googleBaseUrlOverride?: string | null;
  xaiBaseUrlOverride?: string | null;
  zaiBaseUrlOverride?: string | null;
  ollamaBaseUrlOverride?: string | null;
  forceChatCompletions?: boolean;
  requestOptions?: ModelRequestOptions;
  retries?: number;
  onRetry?: (notice: RetryNotice) => void;
}): Promise<{
  text: string;
  canonicalModelId: string;
  provider: LlmProvider;
  usage: LlmTokenUsage | null;
}> {
  const parsed = parseGatewayStyleModelId(modelId);
  const providerProfile = getGatewayProviderProfile(parsed.provider);
  const effectiveTemperature = resolveEffectiveTemperature({
    provider: parsed.provider,
    model: parsed.model,
    temperature,
  });

  const documentResult = await maybeGenerateDocumentText({
    parsed,
    apiKeys,
    prompt,
    maxOutputTokens,
    temperature: effectiveTemperature,
    timeoutMs,
    fetchImpl,
    forceOpenRouter,
    openaiBaseUrlOverride,
    anthropicBaseUrlOverride,
    googleBaseUrlOverride,
    forceChatCompletions,
    requestOptions,
    retryWithModelId: (fallbackModelId) =>
      generateTextWithModelId({
        modelId: fallbackModelId,
        apiKeys,
        prompt,
        temperature,
        maxOutputTokens,
        timeoutMs,
        fetchImpl,
        forceOpenRouter,
        openaiBaseUrlOverride,
        anthropicBaseUrlOverride,
        googleBaseUrlOverride,
        xaiBaseUrlOverride,
        zaiBaseUrlOverride,
        ollamaBaseUrlOverride,
        forceChatCompletions,
        requestOptions,
        retries,
        onRetry,
      }),
  });
  if (documentResult) {
    return documentResult;
  }

  const context = promptToContext(prompt);

  const resolveOpenAiConfig = (
    provider: "openai" | "github-copilot" = "openai",
  ): OpenAiClientConfig =>
    resolveOpenAiCompatibleClientConfigForProvider({
      provider,
      openaiApiKey: apiKeys.openaiApiKey,
      openrouterApiKey: apiKeys.openrouterApiKey,
      forceOpenRouter,
      openaiBaseUrlOverride,
      forceChatCompletions,
      requestOptions,
    });

  const completeSimpleText = async ({
    model,
    apiKey,
    signal,
    onPayload,
  }: {
    model: Parameters<typeof completeSimple>[0];
    apiKey: string;
    signal: AbortSignal;
    onPayload?: (payload: unknown) => unknown;
  }): Promise<{ text: string; usage: LlmTokenUsage | null }> => {
    const result = await completeSimple(model, context, {
      ...(typeof effectiveTemperature === "number" ? { temperature: effectiveTemperature } : {}),
      ...(typeof maxOutputTokens === "number" ? { maxTokens: maxOutputTokens } : {}),
      ...(onPayload ? { onPayload } : {}),
      apiKey,
      signal,
    });
    const text = extractText(result);
    if (!text) throw new Error(`LLM returned an empty summary (model ${parsed.canonical}).`);
    return { text, usage: normalizeTokenUsage(result.usage) };
  };

  const maxRetries = Math.max(0, retries);
  let attempt = 0;

  while (attempt <= maxRetries) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      if (providerProfile.execution === "simple") {
        const apiKey = apiKeys.xaiApiKey;
        if (!apiKey) throw new Error("Missing XAI_API_KEY for xai/... model");
        const model = resolveXaiModel({
          modelId: parsed.model,
          context,
          xaiBaseUrlOverride,
        });
        const result = await completeSimple(model, context, {
          ...(typeof effectiveTemperature === "number"
            ? { temperature: effectiveTemperature }
            : {}),
          ...(typeof maxOutputTokens === "number" ? { maxTokens: maxOutputTokens } : {}),
          apiKey,
          signal: controller.signal,
        });
        const text = extractText(result);
        if (!text) throw new Error(`LLM returned an empty summary (model ${parsed.canonical}).`);
        return {
          text,
          canonicalModelId: parsed.canonical,
          provider: parsed.provider,
          usage: normalizeTokenUsage(result.usage),
        };
      }

      if (providerProfile.execution === "google") {
        const apiKey = apiKeys.googleApiKey;
        if (!apiKey)
          throw new Error(
            "Missing GEMINI_API_KEY (or GOOGLE_GENERATIVE_AI_API_KEY / GOOGLE_API_KEY) for google/... model",
          );
        const result = await completeGoogleText({
          modelId: parsed.model,
          apiKey,
          context,
          temperature: effectiveTemperature,
          maxOutputTokens,
          signal: controller.signal,
          googleBaseUrlOverride,
        });
        return {
          text: result.text,
          canonicalModelId: parsed.canonical,
          provider: parsed.provider,
          usage: result.usage,
        };
      }

      if (providerProfile.execution === "anthropic") {
        const apiKey = apiKeys.anthropicApiKey;
        if (!apiKey) throw new Error("Missing ANTHROPIC_API_KEY for anthropic/... model");
        const result = await completeAnthropicText({
          modelId: parsed.model,
          apiKey,
          context,
          temperature: effectiveTemperature,
          maxOutputTokens,
          reasoningEffort: requestOptions?.reasoningEffort,
          signal: controller.signal,
          anthropicBaseUrlOverride,
        });
        return {
          text: result.text,
          canonicalModelId: parsed.canonical,
          provider: parsed.provider,
          usage: result.usage,
        };
      }

      if (isOpenAiCompatibleProvider(parsed.provider)) {
        const baseUrlOverride =
          parsed.provider === "ollama"
            ? (ollamaBaseUrlOverride ?? openaiBaseUrlOverride)
            : parsed.provider === "zai"
              ? (zaiBaseUrlOverride ?? openaiBaseUrlOverride)
              : openaiBaseUrlOverride;
        const openaiConfig = resolveOpenAiCompatibleClientConfigForProvider({
          provider: parsed.provider,
          openaiApiKey: apiKeys.openaiApiKey,
          openrouterApiKey: apiKeys.openrouterApiKey,
          openaiBaseUrlOverride: baseUrlOverride,
          requestOptions,
        });
        const model = resolveOpenAiCompatibleGatewayModel({
          provider: parsed.provider,
          modelId: parsed.model,
          context,
          openaiConfig,
        });
        const result = await completeSimpleText({
          model,
          apiKey: openaiConfig.apiKey,
          signal: controller.signal,
          ...(parsed.provider === "minimax" ? { onPayload: enableMinimaxReasoningSplit } : {}),
        });
        return {
          text: result.text,
          canonicalModelId: parsed.canonical,
          provider: parsed.provider,
          usage: result.usage,
        };
      }

      if (providerProfile.execution === "openai-http") {
        const provider = parsed.provider as "openai" | "github-copilot";
        const openaiConfig = resolveOpenAiConfig(provider);
        const result = await completeOpenAiText({
          modelId: parsed.model,
          openaiConfig,
          context,
          temperature: effectiveTemperature,
          maxOutputTokens,
          signal: controller.signal,
          fetchImpl,
        });
        return {
          text: result.text,
          canonicalModelId: result.resolvedModelId
            ? `${provider}/${result.resolvedModelId}`
            : parsed.canonical,
          provider,
          usage: result.usage,
        };
      }

      /* v8 ignore next */
      throw new Error(`Unknown provider ${parsed.provider}`);
    } catch (error) {
      const normalizedError =
        error instanceof DOMException && error.name === "AbortError"
          ? new Error(`LLM request timed out after ${timeoutMs}ms (model ${parsed.canonical}).`)
          : error;
      const googleFallbackModelId =
        parsed.provider === "google" &&
        isGoogleEmptySummaryError(normalizedError) &&
        resolveGoogleEmptyResponseFallbackModelId(parsed.canonical);
      if (
        shouldRetryGpt5WithoutTokenCap({
          provider: parsed.provider,
          model: parsed.model,
          maxOutputTokens,
          error: normalizedError,
        })
      ) {
        return generateTextWithModelId({
          modelId: parsed.canonical,
          apiKeys,
          prompt,
          temperature,
          timeoutMs,
          fetchImpl,
          forceOpenRouter,
          openaiBaseUrlOverride,
          anthropicBaseUrlOverride,
          googleBaseUrlOverride,
          xaiBaseUrlOverride,
          zaiBaseUrlOverride,
          ollamaBaseUrlOverride,
          forceChatCompletions,
          requestOptions,
          retries: Math.max(0, maxRetries - attempt),
          onRetry,
        });
      }
      if (googleFallbackModelId) {
        return generateTextWithModelId({
          modelId: googleFallbackModelId,
          apiKeys,
          prompt,
          temperature,
          maxOutputTokens,
          timeoutMs,
          fetchImpl,
          forceOpenRouter,
          openaiBaseUrlOverride,
          anthropicBaseUrlOverride,
          googleBaseUrlOverride,
          xaiBaseUrlOverride,
          zaiBaseUrlOverride,
          ollamaBaseUrlOverride,
          forceChatCompletions,
          requestOptions,
          retries: Math.max(0, maxRetries - attempt),
          onRetry,
        });
      }
      if (parsed.provider === "anthropic") {
        const normalized = normalizeAnthropicModelAccessError(normalizedError, parsed.model);
        if (normalized) throw normalized;
      }
      if (isRetryableTimeoutError(normalizedError) && attempt < maxRetries) {
        const delayMs = computeRetryDelayMs(attempt);
        onRetry?.({ attempt: attempt + 1, maxRetries, delayMs, error: normalizedError });
        await sleep(delayMs);
        attempt += 1;
        continue;
      }
      throw normalizedError;
    } finally {
      clearTimeout(timeout);
    }
  }

  throw new Error(`LLM request failed after ${maxRetries + 1} attempts.`);
}

export async function streamTextWithModelId({
  modelId,
  apiKeys,
  prompt,
  temperature,
  maxOutputTokens,
  timeoutMs,
  fetchImpl,
  forceOpenRouter,
  openaiBaseUrlOverride,
  anthropicBaseUrlOverride,
  googleBaseUrlOverride,
  xaiBaseUrlOverride,
  ollamaBaseUrlOverride,
  forceChatCompletions,
  requestOptions,
}: {
  modelId: string;
  apiKeys: LlmApiKeys;
  prompt: Prompt;
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
}): Promise<{
  textStream: AsyncIterable<string>;
  canonicalModelId: string;
  provider: LlmProvider;
  usage: Promise<LlmTokenUsage | null>;
  lastError: () => unknown;
}> {
  const context = promptToContext(prompt);
  return streamTextWithContext({
    modelId,
    apiKeys,
    context,
    temperature,
    maxOutputTokens,
    timeoutMs,
    fetchImpl,
    forceOpenRouter,
    openaiBaseUrlOverride,
    anthropicBaseUrlOverride,
    googleBaseUrlOverride,
    xaiBaseUrlOverride,
    ollamaBaseUrlOverride,
    forceChatCompletions,
    requestOptions,
  });
}
