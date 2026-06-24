import type { Api, Context, Model } from "@earendil-works/pi-ai";
import { DEFAULT_MINIMAX_BASE_URL, DEFAULT_OLLAMA_BASE_URL } from "../provider-profile.js";
import {
  createSyntheticModel,
  resolveBaseUrlOverride,
  tryGetModel,
  wantsImages,
} from "./shared.js";
import type { OpenAiClientConfig } from "./types.js";

export function resolveOpenAiModel({
  modelId,
  context,
  openaiConfig,
}: {
  modelId: string;
  context: Context;
  openaiConfig: OpenAiClientConfig;
}): Model<Api> {
  const allowImages = wantsImages(context);
  const base = tryGetModel("openai", modelId);
  const api = openaiConfig.useChatCompletions ? "openai-completions" : "openai-responses";
  const baseUrl = openaiConfig.baseURL ?? base?.baseUrl ?? "https://api.openai.com/v1";
  const headers = openaiConfig.isOpenRouter
    ? {
        ...(base?.headers ?? {}),
        "HTTP-Referer": "https://github.com/steipete/summarize",
        "X-Title": "summarize",
      }
    : openaiConfig.extraHeaders
      ? {
          ...(base?.headers ?? {}),
          ...openaiConfig.extraHeaders,
        }
      : base?.headers;
  return {
    ...(base ?? createSyntheticModel({ provider: "openai", modelId, api, baseUrl, allowImages })),
    api,
    baseUrl,
    ...(headers ? { headers } : {}),
  };
}

export function resolveZaiModel({
  modelId,
  context,
  openaiBaseUrlOverride,
}: {
  modelId: string;
  context: Context;
  openaiBaseUrlOverride?: string | null;
}): Model<Api> {
  const allowImages = wantsImages(context);
  const base = tryGetModel("zai", modelId);
  const api = "openai-completions";
  const baseUrl = openaiBaseUrlOverride ?? base?.baseUrl ?? "https://api.z.ai/api/paas/v4";
  return {
    ...(base ?? createSyntheticModel({ provider: "zai", modelId, api, baseUrl, allowImages })),
    api,
    baseUrl,
    input: allowImages ? ["text", "image"] : ["text"],
  };
}

export function resolveNvidiaModel({
  modelId,
  context,
  openaiBaseUrlOverride,
}: {
  modelId: string;
  context: Context;
  openaiBaseUrlOverride?: string | null;
}): Model<Api> {
  const allowImages = wantsImages(context);
  // The NVIDIA Integrate API is OpenAI-compatible; treat it like an OpenAI gateway.
  const base = tryGetModel("openai", modelId);
  const api = "openai-completions";
  const baseUrl = openaiBaseUrlOverride ?? base?.baseUrl ?? "https://integrate.api.nvidia.com/v1";
  return {
    ...(base ?? createSyntheticModel({ provider: "openai", modelId, api, baseUrl, allowImages })),
    api,
    baseUrl,
    input: allowImages ? ["text", "image"] : ["text"],
  };
}

export function resolveMinimaxModel({
  modelId,
  openaiBaseUrlOverride,
}: {
  modelId: string;
  context: Context;
  openaiBaseUrlOverride?: string | null;
}): Model<Api> {
  const base = tryGetModel("minimax", modelId);
  const api = "openai-completions";
  const baseUrl = openaiBaseUrlOverride ?? DEFAULT_MINIMAX_BASE_URL;
  const fallback = createSyntheticModel({
    provider: "minimax",
    modelId,
    api,
    baseUrl,
    allowImages: false,
  });
  return {
    ...(base ?? fallback),
    api,
    baseUrl,
    reasoning: base?.reasoning ?? true,
    input: ["text"],
    // The catalog entry is Anthropic-native; constrain the OpenAI transport to MiniMax-documented fields.
    compat: {
      supportsStore: false,
      supportsDeveloperRole: false,
      supportsReasoningEffort: false,
      maxTokensField: "max_completion_tokens",
      supportsStrictMode: false,
      supportsLongCacheRetention: false,
    },
    ...(modelId.toLowerCase() === "minimax-m3" ? { contextWindow: 1_000_000 } : {}),
  };
}

export function resolveOllamaModel({
  modelId,
  context,
  ollamaBaseUrlOverride,
}: {
  modelId: string;
  context: Context;
  ollamaBaseUrlOverride?: string | null;
}): Model<Api> {
  const allowImages = wantsImages(context);
  // Ollama exposes an OpenAI-compatible API at /v1; treat it like an OpenAI gateway.
  const api = "openai-completions";
  const baseUrl = ollamaBaseUrlOverride ?? DEFAULT_OLLAMA_BASE_URL;
  return createSyntheticModel({
    provider: "openai",
    modelId,
    api,
    baseUrl,
    allowImages,
  });
}

export function resolveOpenAiCompatibleGatewayModel({
  provider,
  modelId,
  context,
  openaiConfig,
}: {
  provider: "zai" | "nvidia" | "minimax" | "ollama";
  modelId: string;
  context: Context;
  openaiConfig: OpenAiClientConfig;
}): Model<Api> {
  switch (provider) {
    case "zai":
      return resolveZaiModel({
        modelId,
        context,
        openaiBaseUrlOverride: openaiConfig.baseURL,
      });
    case "nvidia":
      return resolveNvidiaModel({
        modelId,
        context,
        openaiBaseUrlOverride: openaiConfig.baseURL,
      });
    case "minimax":
      return resolveMinimaxModel({
        modelId,
        context,
        openaiBaseUrlOverride: openaiConfig.baseURL,
      });
    case "ollama":
      return resolveOllamaModel({
        modelId,
        context,
        ollamaBaseUrlOverride: openaiConfig.baseURL,
      });
  }
}

export function resolveXaiModel({
  modelId,
  context,
  xaiBaseUrlOverride,
}: {
  modelId: string;
  context: Context;
  xaiBaseUrlOverride?: string | null;
}): Model<Api> {
  const allowImages = wantsImages(context);
  const base = tryGetModel("xai", modelId);
  const override = resolveBaseUrlOverride(xaiBaseUrlOverride);
  if (override) {
    return {
      ...(base ??
        createSyntheticModel({
          provider: "xai",
          modelId,
          api: "openai-completions",
          baseUrl: override,
          allowImages,
        })),
      baseUrl: override,
    };
  }
  return (
    base ??
    createSyntheticModel({
      provider: "xai",
      modelId,
      api: "openai-completions",
      baseUrl: "https://api.x.ai/v1",
      allowImages,
    })
  );
}

export function resolveGoogleModel({
  modelId,
  context,
  googleBaseUrlOverride,
}: {
  modelId: string;
  context: Context;
  googleBaseUrlOverride?: string | null;
}): Model<Api> {
  const allowImages = wantsImages(context);
  const base = tryGetModel("google", modelId);
  const override = resolveBaseUrlOverride(googleBaseUrlOverride);
  if (override) {
    return {
      ...(base ??
        createSyntheticModel({
          provider: "google",
          modelId,
          api: "google-generative-ai",
          baseUrl: override,
          allowImages,
        })),
      baseUrl: override,
    };
  }
  return (
    base ??
    createSyntheticModel({
      provider: "google",
      modelId,
      api: "google-generative-ai",
      baseUrl: "https://generativelanguage.googleapis.com/v1beta",
      allowImages,
    })
  );
}

export function resolveAnthropicModel({
  modelId,
  context,
  anthropicBaseUrlOverride,
}: {
  modelId: string;
  context: Context;
  anthropicBaseUrlOverride?: string | null;
}): { model: Model<Api>; isSyntheticCustomGateway: boolean } {
  const allowImages = wantsImages(context);
  const base = tryGetModel("anthropic", modelId);
  const override = resolveBaseUrlOverride(anthropicBaseUrlOverride);
  if (override) {
    return {
      model: {
        ...(base ??
          createSyntheticModel({
            provider: "anthropic",
            modelId,
            api: "anthropic-messages",
            baseUrl: override,
            allowImages,
          })),
        baseUrl: override,
      },
      isSyntheticCustomGateway: !base,
    };
  }
  return {
    model:
      base ??
      createSyntheticModel({
        provider: "anthropic",
        modelId,
        api: "anthropic-messages",
        baseUrl: "https://api.anthropic.com",
        allowImages,
      }),
    isSyntheticCustomGateway: false,
  };
}
