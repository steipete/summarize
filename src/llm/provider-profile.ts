import { buildGitHubModelsHeaders, resolveGitHubModelsApiKey } from "./github-models.js";
import { normalizeGatewayStyleModelId, parseGatewayStyleModelId } from "./model-id.js";
import type { ModelRequestOptions } from "./model-options.js";
import { resolveOpenAiClientConfig } from "./openai-client-config.js";
import {
  CLI_PROVIDER_PROFILES,
  GATEWAY_PROVIDER_PROFILES,
  getCliProviderProfile,
  getGatewayProviderProfile,
  parseCliProviderName,
  type CliProvider,
  type CliRequiredModelEnv,
  type GatewayProvider,
  type GatewayRequiredModelEnv,
  type RequiredModelEnv,
} from "./provider-registry.js";
import type { OpenAiClientConfig } from "./providers/types.js";

export type ProviderRuntimeBindings = {
  apiKeys: Partial<Record<GatewayProvider, string | null>>;
  baseUrls: Partial<Record<GatewayProvider, string | null>>;
  openaiUseChatCompletions?: boolean;
};

export type ProviderOpenAiOverrides = {
  openaiApiKeyOverride?: string | null;
  openaiBaseUrlOverride?: string | null;
  forceChatCompletions?: boolean;
};

export function resolveProviderOpenAiOverrides({
  provider,
  runtime,
  baseUrlOverride,
}: {
  provider: GatewayProvider;
  runtime: ProviderRuntimeBindings;
  baseUrlOverride?: string | null;
}): ProviderOpenAiOverrides {
  const profile = getGatewayProviderProfile(provider);
  if (profile.execution !== "openai-http" && profile.execution !== "openai-compatible") {
    return {};
  }

  const runtimeBaseUrl = runtime.baseUrls[provider];
  const openaiBaseUrlOverride =
    provider === "openai"
      ? (baseUrlOverride ?? runtimeBaseUrl)
      : (runtimeBaseUrl ?? baseUrlOverride ?? profile.defaultBaseUrl);
  const forceChatCompletions =
    provider === "openai" ? runtime.openaiUseChatCompletions : profile.forceChatCompletions;
  const apiKey = runtime.apiKeys[provider];

  return {
    ...(provider !== "openai" ? { openaiApiKeyOverride: apiKey ?? null } : {}),
    ...(openaiBaseUrlOverride != null ? { openaiBaseUrlOverride } : {}),
    ...(typeof forceChatCompletions === "boolean" ? { forceChatCompletions } : {}),
  };
}

export function requiredEnvForCliProvider(provider: CliProvider): CliRequiredModelEnv {
  return getCliProviderProfile(provider).requiredEnv;
}

export function cliProviderForRequiredEnv(requiredEnv: RequiredModelEnv): CliProvider | null {
  for (const [provider, profile] of Object.entries(CLI_PROVIDER_PROFILES)) {
    if (profile.requiredEnv === requiredEnv) return provider as CliProvider;
  }
  return null;
}

export function formatMissingCliModelError({
  requiredEnv,
  userModelId,
}: {
  requiredEnv: RequiredModelEnv;
  userModelId: string;
}): string | null {
  const provider = cliProviderForRequiredEnv(requiredEnv);
  if (!provider) return null;
  const profile = getCliProviderProfile(provider);
  return `${profile.missingBinaryLabel} not found for model ${userModelId}. Install ${profile.installLabel} or set ${profile.pathEnv}.`;
}

export function requiredEnvForGatewayProvider(provider: GatewayProvider): GatewayRequiredModelEnv {
  return getGatewayProviderProfile(provider).requiredEnv;
}

export function gatewayProviderForRequiredEnv(
  requiredEnv: RequiredModelEnv,
): GatewayProvider | null {
  for (const [provider, profile] of Object.entries(GATEWAY_PROVIDER_PROFILES)) {
    if (profile.requiredEnv === requiredEnv) return provider as GatewayProvider;
  }
  return null;
}

export function supportsDocumentAttachments(provider: GatewayProvider): boolean {
  return getGatewayProviderProfile(provider).supportsDocuments;
}

export function supportsStreaming(provider: GatewayProvider): boolean {
  return getGatewayProviderProfile(provider).supportsStreaming;
}

export function isOpenAiCompatibleProvider(
  provider: GatewayProvider,
): provider is "zai" | "nvidia" | "minimax" | "ollama" {
  return getGatewayProviderProfile(provider).execution === "openai-compatible";
}

export function isVideoUnderstandingCapableProvider(provider: GatewayProvider): boolean {
  return getGatewayProviderProfile(provider).supportsVideoUnderstanding;
}

export function envHasRequiredKey(
  env: Record<string, string | undefined>,
  requiredEnv: RequiredModelEnv,
): boolean {
  if (requiredEnv === "GEMINI_API_KEY") {
    return Boolean(
      env.GEMINI_API_KEY?.trim() ||
      env.GOOGLE_GENERATIVE_AI_API_KEY?.trim() ||
      env.GOOGLE_API_KEY?.trim(),
    );
  }
  if (requiredEnv === "Z_AI_API_KEY") {
    return Boolean(env.Z_AI_API_KEY?.trim() || env.ZAI_API_KEY?.trim());
  }
  if (requiredEnv === "GITHUB_TOKEN") {
    return Boolean(resolveGitHubModelsApiKey(env));
  }
  if (requiredEnv === "OLLAMA_BASE_URL") {
    return true;
  }
  return Boolean(env[requiredEnv]?.trim());
}

export function resolveRequiredEnvForModelId(modelId: string): RequiredModelEnv {
  const trimmed = modelId.trim();
  if (trimmed.toLowerCase().startsWith("cli/")) {
    const parts = trimmed.split("/").map((entry) => entry.trim());
    const provider = parseCliProviderName(parts[1] ?? "");
    return provider ? requiredEnvForCliProvider(provider) : "CLI_CLAUDE";
  }
  if (trimmed.toLowerCase().startsWith("openclaw/")) return "CLI_OPENCLAW";
  if (trimmed.toLowerCase().startsWith("openrouter/")) return "OPENROUTER_API_KEY";
  const parsed = parseGatewayStyleModelId(normalizeGatewayStyleModelId(trimmed));
  return requiredEnvForGatewayProvider(parsed.provider);
}

export function isVideoUnderstandingCapableModelId(modelId: string): boolean {
  try {
    const parsed = parseGatewayStyleModelId(normalizeGatewayStyleModelId(modelId));
    return isVideoUnderstandingCapableProvider(parsed.provider);
  } catch {
    return false;
  }
}

export function resolveOpenAiCompatibleClientConfigForProvider({
  provider,
  openaiApiKey,
  openrouterApiKey,
  forceOpenRouter,
  openaiBaseUrlOverride,
  forceChatCompletions,
  requestOptions,
}: {
  provider: "openai" | "zai" | "nvidia" | "minimax" | "github-copilot" | "ollama";
  openaiApiKey: string | null;
  openrouterApiKey: string | null;
  forceOpenRouter?: boolean;
  openaiBaseUrlOverride?: string | null;
  forceChatCompletions?: boolean;
  requestOptions?: ModelRequestOptions;
}): OpenAiClientConfig {
  if (provider === "openai") {
    return resolveOpenAiClientConfig({
      apiKeys: {
        openaiApiKey,
        openrouterApiKey,
      },
      forceOpenRouter,
      openaiBaseUrlOverride,
      forceChatCompletions,
      requestOptions,
    });
  }
  const profile = GATEWAY_PROVIDER_PROFILES[provider];
  const apiKey = provider === "ollama" ? openaiApiKey?.trim() || "ollama" : openaiApiKey;
  if (!apiKey) {
    const requiredEnv =
      provider === "github-copilot" ? "GITHUB_TOKEN (or GH_TOKEN)" : profile.requiredEnv;
    throw new Error(`Missing ${requiredEnv} for ${provider}/... model`);
  }
  return {
    apiKey,
    baseURL: openaiBaseUrlOverride ?? profile.defaultBaseUrl,
    useChatCompletions: profile.forceChatCompletions,
    isOpenRouter: false,
    ...(provider === "github-copilot"
      ? { extraHeaders: buildGitHubModelsHeaders() }
      : requestOptions
        ? { requestOptions }
        : {}),
  };
}
