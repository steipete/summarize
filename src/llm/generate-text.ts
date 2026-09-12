import { completeSimple } from "@earendil-works/pi-ai/compat";
import { maybeGenerateDocumentText } from "./generate-text-document.js";
import {
  computeRetryDelayMs,
  isGoogleEmptySummaryError,
  isRetryableLlmError,
  promptToContext,
  resolveEffectiveTemperature,
  resolveGoogleEmptyResponseFallbackModelId,
  shouldRetryGpt5WithoutTokenCap,
  sleep,
} from "./generate-text-shared.js";
import { streamTextWithContext, type StreamTextResult } from "./generate-text-stream.js";
import type { LlmRequestOptions } from "./generate-text-types.js";
import { parseGatewayStyleModelId } from "./model-id.js";
import type { LlmProvider } from "./model-id.js";
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
import { resolveOpenAiCompatibleGatewayModel, resolveXaiModel } from "./providers/models.js";
import { completeOpenAiText } from "./providers/openai.js";
import { extractText, throwIfAssistantMessageFailed } from "./providers/shared.js";
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

class DocumentFallbackError extends Error {
  readonly fallbackError: unknown;

  constructor(fallbackError: unknown) {
    super("Document fallback failed", { cause: fallbackError });
    this.name = "DocumentFallbackError";
    this.fallbackError = fallbackError;
  }
}

type GenerateTextArgs = LlmRequestOptions & {
  prompt: Prompt;
  zaiBaseUrlOverride?: string | null;
  retries?: number;
  onRetry?: (notice: RetryNotice) => void;
};

export async function generateTextWithModelId(args: GenerateTextArgs): Promise<{
  text: string;
  canonicalModelId: string;
  provider: LlmProvider;
  usage: LlmTokenUsage | null;
}> {
  const {
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
  } = args;
  const parsed = parseGatewayStyleModelId(modelId);
  const providerProfile = getGatewayProviderProfile(parsed.provider);
  const effectiveTemperature = resolveEffectiveTemperature({
    provider: parsed.provider,
    model: parsed.model,
    temperature,
  });
  const maxRetries = Math.max(0, retries);

  let documentAttempt = 0;
  while (documentAttempt <= maxRetries) {
    try {
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
        retryWithModelId: async (fallbackModelId) => {
          try {
            return await generateTextWithModelId({
              ...args,
              modelId: fallbackModelId,
              retries: Math.max(0, maxRetries - documentAttempt),
            });
          } catch (error) {
            throw new DocumentFallbackError(error);
          }
        },
      });
      if (documentResult) return documentResult;
      break;
    } catch (error) {
      if (error instanceof DocumentFallbackError) throw error.fallbackError;
      const normalizedError =
        error instanceof DOMException && error.name === "AbortError"
          ? new Error(`LLM request timed out after ${timeoutMs}ms (model ${parsed.canonical}).`)
          : error;
      if (!isRetryableLlmError(normalizedError) || documentAttempt >= maxRetries) {
        throw normalizedError;
      }
      const delayMs = computeRetryDelayMs(documentAttempt);
      onRetry?.({
        attempt: documentAttempt + 1,
        maxRetries,
        delayMs,
        error: normalizedError,
      });
      await sleep(delayMs);
      documentAttempt += 1;
    }
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
    throwIfAssistantMessageFailed(result, parsed.canonical);
    const text = extractText(result);
    if (!text) throw new Error(`LLM returned an empty summary (model ${parsed.canonical}).`);
    return { text, usage: normalizeTokenUsage(result.usage) };
  };

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
        const result = await completeSimpleText({
          model,
          apiKey,
          signal: controller.signal,
        });
        return {
          ...result,
          canonicalModelId: parsed.canonical,
          provider: parsed.provider,
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
          ...args,
          modelId: parsed.canonical,
          maxOutputTokens: undefined,
          retries: Math.max(0, maxRetries - attempt),
        });
      }
      if (googleFallbackModelId) {
        return generateTextWithModelId({
          ...args,
          modelId: googleFallbackModelId,
          retries: Math.max(0, maxRetries - attempt),
        });
      }
      if (parsed.provider === "anthropic") {
        const normalized = normalizeAnthropicModelAccessError(normalizedError, parsed.model);
        if (normalized) throw normalized;
      }
      if (isRetryableLlmError(normalizedError) && attempt < maxRetries) {
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
  prompt,
  ...options
}: LlmRequestOptions & {
  prompt: Prompt;
}): Promise<StreamTextResult> {
  return streamTextWithContext({ ...options, context: promptToContext(prompt) });
}
