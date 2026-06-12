import { streamSimple } from "@earendil-works/pi-ai";
import type { Context } from "@earendil-works/pi-ai";
import { createUnsupportedFunctionalityError } from "./errors.js";
import { resolveEffectiveTemperature, streamUsageWithTimeout } from "./generate-text-shared.js";
import type { LlmApiKeys } from "./generate-text-types.js";
import { parseGatewayStyleModelId } from "./model-id.js";
import type { LlmProvider } from "./model-id.js";
import type { ModelRequestOptions } from "./model-options.js";
import {
  getGatewayProviderProfile,
  isOpenAiCompatibleProvider,
  resolveOpenAiCompatibleClientConfigForProvider,
  supportsStreaming,
} from "./provider-capabilities.js";
import {
  normalizeAnthropicModelAccessError,
  prepareAnthropicReasoning,
} from "./providers/anthropic.js";
import { enableMinimaxReasoningSplit } from "./providers/minimax.js";
import {
  resolveAnthropicModel,
  resolveGoogleModel,
  resolveOpenAiModel,
  resolveOpenAiCompatibleGatewayModel,
  resolveXaiModel,
} from "./providers/models.js";
import { completeOpenAiText, streamOpenAiText } from "./providers/openai.js";
import type { OpenAiClientConfig } from "./providers/types.js";
import type { LlmTokenUsage } from "./types.js";

export type StreamTextWithContextArgs = {
  modelId: string;
  apiKeys: LlmApiKeys;
  context: Context;
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

export type StreamTextResult = {
  textStream: AsyncIterable<string>;
  canonicalModelId: string;
  provider: LlmProvider;
  usage: Promise<LlmTokenUsage | null>;
  lastError: () => unknown;
};

function createTimedTextStream({
  textStream,
  timeoutMs,
  controller,
  setLastError,
}: {
  textStream: AsyncIterable<string>;
  timeoutMs: number;
  controller: AbortController;
  setLastError: (error: unknown) => void;
}): AsyncIterable<string> {
  let timeoutId: ReturnType<typeof setTimeout> | null = null;
  const startedAtMs = Date.now();
  const timeoutError = new Error("LLM request timed out");
  const markTimedOut = () => {
    setLastError(timeoutError);
    controller.abort();
  };
  const startTimeout = () => {
    if (timeoutId) return;
    timeoutId = setTimeout(markTimedOut, timeoutMs);
  };
  const stopTimeout = () => {
    if (!timeoutId) return;
    clearTimeout(timeoutId);
    timeoutId = null;
  };
  const nextWithDeadline = async <T>(promise: Promise<T>): Promise<T> => {
    const elapsed = Date.now() - startedAtMs;
    const remaining = timeoutMs - elapsed;
    if (remaining <= 0) {
      markTimedOut();
      throw timeoutError;
    }
    let timer: ReturnType<typeof setTimeout> | null = null;
    try {
      return await Promise.race([
        promise,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            markTimedOut();
            reject(timeoutError);
          }, remaining);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  };

  return {
    async *[Symbol.asyncIterator]() {
      startTimeout();
      const iterator = textStream[Symbol.asyncIterator]();
      try {
        while (true) {
          let result: IteratorResult<string>;
          try {
            result = await nextWithDeadline(iterator.next());
          } catch (error) {
            setLastError(error);
            throw error;
          }
          if (result.done) break;
          yield result.value;
        }
      } finally {
        stopTimeout();
        if (typeof iterator.return === "function") {
          const cleanup = iterator.return();
          const cleanupPromise =
            typeof cleanup === "undefined" ? undefined : (cleanup as Promise<unknown>);
          if (typeof cleanupPromise?.catch === "function") {
            void cleanupPromise.catch(() => {});
          }
        }
      }
    },
  };
}

async function withRequestDeadline<T>({
  promise,
  timeoutMs,
  controller,
  setLastError,
}: {
  promise: Promise<T>;
  timeoutMs: number;
  controller: AbortController;
  setLastError: (error: unknown) => void;
}): Promise<T> {
  const timeoutError = new Error("LLM request timed out");
  if (timeoutMs <= 0) {
    setLastError(timeoutError);
    controller.abort();
    throw timeoutError;
  }

  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          setLastError(timeoutError);
          controller.abort();
          reject(timeoutError);
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function collectTextDeltas({
  stream,
  onError,
}: {
  stream: AsyncIterable<{ type: string; delta?: string; error?: unknown }>;
  onError: (error: unknown) => void;
}): AsyncIterable<string> {
  return {
    async *[Symbol.asyncIterator]() {
      for await (const event of stream) {
        if (event.type === "text_delta" && typeof event.delta === "string") {
          yield event.delta;
        }
        if (event.type === "error") {
          onError(event.error);
          break;
        }
      }
    },
  };
}

export async function streamTextWithContext({
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
}: StreamTextWithContextArgs): Promise<StreamTextResult> {
  const parsed = parseGatewayStyleModelId(modelId);
  const providerProfile = getGatewayProviderProfile(parsed.provider);
  if (!supportsStreaming(parsed.provider)) {
    throw createUnsupportedFunctionalityError(
      `streaming is not supported for ${parsed.provider}/... models`,
    );
  }
  const effectiveTemperature = resolveEffectiveTemperature({
    provider: parsed.provider,
    model: parsed.model,
    temperature,
  });
  void fetchImpl;

  const controller = new AbortController();
  let lastError: unknown = null;
  const setLastError = (error: unknown) => {
    if ((lastError as Error | null)?.message === "LLM request timed out") return;
    lastError = error;
  };

  try {
    if (providerProfile.execution === "simple") {
      const apiKey = apiKeys.xaiApiKey;
      if (!apiKey) throw new Error("Missing XAI_API_KEY for xai/... model");
      const model = resolveXaiModel({
        modelId: parsed.model,
        context,
        xaiBaseUrlOverride,
      });
      const stream = streamSimple(model, context, {
        ...(typeof effectiveTemperature === "number" ? { temperature: effectiveTemperature } : {}),
        ...(typeof maxOutputTokens === "number" ? { maxTokens: maxOutputTokens } : {}),
        apiKey,
        signal: controller.signal,
      });
      const textDeltas = collectTextDeltas({
        stream,
        onError: (error) => {
          lastError = error;
        },
      });
      return {
        textStream: createTimedTextStream({
          textStream: textDeltas,
          timeoutMs,
          controller,
          setLastError,
        }),
        canonicalModelId: parsed.canonical,
        provider: parsed.provider,
        usage: streamUsageWithTimeout({ result: stream.result(), timeoutMs }),
        lastError: () => lastError,
      };
    }

    if (providerProfile.execution === "google") {
      const apiKey = apiKeys.googleApiKey;
      if (!apiKey) {
        throw new Error(
          "Missing GEMINI_API_KEY (or GOOGLE_GENERATIVE_AI_API_KEY / GOOGLE_API_KEY) for google/... model",
        );
      }
      const model = resolveGoogleModel({
        modelId: parsed.model,
        context,
        googleBaseUrlOverride,
      });
      const stream = streamSimple(model, context, {
        ...(typeof effectiveTemperature === "number" ? { temperature: effectiveTemperature } : {}),
        ...(typeof maxOutputTokens === "number" ? { maxTokens: maxOutputTokens } : {}),
        apiKey,
        signal: controller.signal,
      });
      const textDeltas = collectTextDeltas({
        stream,
        onError: (error) => {
          lastError = error;
        },
      });
      return {
        textStream: createTimedTextStream({
          textStream: textDeltas,
          timeoutMs,
          controller,
          setLastError,
        }),
        canonicalModelId: parsed.canonical,
        provider: parsed.provider,
        usage: streamUsageWithTimeout({ result: stream.result(), timeoutMs }),
        lastError: () => lastError,
      };
    }

    if (providerProfile.execution === "anthropic") {
      const apiKey = apiKeys.anthropicApiKey;
      if (!apiKey) throw new Error("Missing ANTHROPIC_API_KEY for anthropic/... model");
      const baseModel = resolveAnthropicModel({
        modelId: parsed.model,
        context,
        anthropicBaseUrlOverride,
      });
      const { model, reasoning } = prepareAnthropicReasoning({
        modelId: parsed.model,
        baseModel,
        reasoningEffort: requestOptions?.reasoningEffort,
      });
      const stream = streamSimple(model, context, {
        ...(typeof effectiveTemperature === "number" ? { temperature: effectiveTemperature } : {}),
        ...(typeof maxOutputTokens === "number" ? { maxTokens: maxOutputTokens } : {}),
        ...(reasoning ? { reasoning } : {}),
        apiKey,
        signal: controller.signal,
      });
      return {
        textStream: createTimedTextStream({
          textStream: collectTextDeltas({
            stream,
            onError: (error) => {
              lastError = normalizeAnthropicModelAccessError(error, parsed.model) ?? error;
            },
          }),
          timeoutMs,
          controller,
          setLastError,
        }),
        canonicalModelId: parsed.canonical,
        provider: parsed.provider,
        usage: streamUsageWithTimeout({ result: stream.result(), timeoutMs }),
        lastError: () => lastError,
      };
    }

    if (
      providerProfile.execution === "openai-http" ||
      isOpenAiCompatibleProvider(parsed.provider)
    ) {
      const provider = parsed.provider as
        | "openai"
        | "zai"
        | "nvidia"
        | "minimax"
        | "github-copilot"
        | "ollama";
      const openaiConfig: OpenAiClientConfig = resolveOpenAiCompatibleClientConfigForProvider({
        provider,
        openaiApiKey: apiKeys.openaiApiKey,
        openrouterApiKey: apiKeys.openrouterApiKey,
        forceOpenRouter,
        openaiBaseUrlOverride:
          parsed.provider === "ollama"
            ? (ollamaBaseUrlOverride ?? openaiBaseUrlOverride)
            : openaiBaseUrlOverride,
        forceChatCompletions,
        requestOptions,
      });
      if (
        parsed.provider === "github-copilot" ||
        (parsed.provider === "openai" && requestOptions)
      ) {
        if (parsed.provider === "openai") {
          const streamResult = await withRequestDeadline({
            promise: streamOpenAiText({
              modelId: parsed.model,
              openaiConfig,
              context,
              temperature: effectiveTemperature,
              maxOutputTokens,
              signal: controller.signal,
              fetchImpl,
            }),
            timeoutMs,
            controller,
            setLastError,
          });
          if (streamResult) {
            return {
              textStream: createTimedTextStream({
                textStream: streamResult.textStream,
                timeoutMs,
                controller,
                setLastError,
              }),
              canonicalModelId: streamResult.resolvedModelId
                ? `${parsed.provider}/${streamResult.resolvedModelId}`
                : parsed.canonical,
              provider: parsed.provider,
              usage: streamResult.usage,
              lastError: () => lastError,
            };
          }
        }
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
          textStream: createTimedTextStream({
            textStream: {
              async *[Symbol.asyncIterator]() {
                yield result.text;
              },
            },
            timeoutMs,
            controller,
            setLastError,
          }),
          canonicalModelId: result.resolvedModelId
            ? `${parsed.provider}/${result.resolvedModelId}`
            : parsed.canonical,
          provider: parsed.provider,
          usage: Promise.resolve(result.usage),
          lastError: () => lastError,
        };
      }
      const model = isOpenAiCompatibleProvider(parsed.provider)
        ? resolveOpenAiCompatibleGatewayModel({
            provider: parsed.provider,
            modelId: parsed.model,
            context,
            openaiConfig,
          })
        : resolveOpenAiModel({ modelId: parsed.model, context, openaiConfig });
      const stream = streamSimple(model, context, {
        ...(typeof effectiveTemperature === "number" ? { temperature: effectiveTemperature } : {}),
        ...(typeof maxOutputTokens === "number" ? { maxTokens: maxOutputTokens } : {}),
        ...(parsed.provider === "minimax" ? { onPayload: enableMinimaxReasoningSplit } : {}),
        apiKey: openaiConfig.apiKey,
        signal: controller.signal,
      });
      const textDeltas = collectTextDeltas({
        stream,
        onError: (error) => {
          lastError = error;
        },
      });
      return {
        textStream: createTimedTextStream({
          textStream: textDeltas,
          timeoutMs,
          controller,
          setLastError,
        }),
        canonicalModelId: parsed.canonical,
        provider: parsed.provider,
        usage: streamUsageWithTimeout({ result: stream.result(), timeoutMs }),
        lastError: () => lastError,
      };
    }

    throw new Error(`Unknown provider ${parsed.provider}`);
  } catch (error) {
    if (parsed.provider === "anthropic") {
      const normalized = normalizeAnthropicModelAccessError(error, parsed.model);
      if (normalized) throw normalized;
    }
    if (error instanceof DOMException && error.name === "AbortError") {
      throw new Error("LLM request timed out");
    }
    throw error;
  }
}
