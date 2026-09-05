import type { CliProvider } from "./config.js";
import { normalizeGatewayStyleModelId, parseGatewayStyleModelId } from "./llm/model-id.js";
import type { LlmProvider } from "./llm/model-id.js";
import type { ModelRequestOptions } from "./llm/model-options.js";
import {
  DEFAULT_CLI_MODELS,
  requiredEnvForCliProvider,
  requiredEnvForGatewayProvider,
} from "./llm/provider-capabilities.js";
import {
  getGatewayProviderProfile,
  isGatewayProvider,
  parseCliProviderName,
  type CliRequiredModelEnv,
  type GatewayRequiredModelEnv,
} from "./llm/provider-registry.js";

export type FixedModelSpec =
  | {
      transport: "native";
      userModelId: string;
      llmModelId: string;
      provider: LlmProvider;
      openrouterProviders: string[] | null;
      forceOpenRouter: false;
      requiredEnv: GatewayRequiredModelEnv;
      openaiBaseUrlOverride?: string | null;
      forceChatCompletions?: boolean;
      requestOptions?: ModelRequestOptions;
    }
  | {
      transport: "openrouter";
      userModelId: string;
      openrouterModelId: string;
      llmModelId: string;
      openrouterProviders: string[] | null;
      forceOpenRouter: true;
      requiredEnv: "OPENROUTER_API_KEY";
      requestOptions?: ModelRequestOptions;
    }
  | {
      transport: "cli";
      userModelId: string;
      llmModelId: null;
      openrouterProviders: null;
      forceOpenRouter: false;
      requiredEnv: CliRequiredModelEnv;
      cliProvider: CliProvider;
      cliModel: string | null;
    };

export type RequestedModel = { kind: "auto" } | ({ kind: "fixed" } & FixedModelSpec);

export function resolveOpenAiFastModelId(
  modelId: string,
): { modelId: string; options: ModelRequestOptions } | null {
  const normalized = modelId.trim();
  const match = /^(gpt-5\.[45](?:[-.][a-z0-9]+)*)-fast$/i.exec(normalized);
  if (!match) return null;
  return { modelId: match[1] ?? normalized, options: { serviceTier: "fast" } };
}

export function parseRequestedModelId(raw: string): RequestedModel {
  const trimmed = raw.trim();
  if (trimmed.length === 0) throw new Error("Missing model id");

  const lower = trimmed.toLowerCase();
  if (lower === "auto") return { kind: "auto" };

  if (lower.startsWith("openrouter/")) {
    const openrouterModelId = trimmed.slice("openrouter/".length).trim();
    if (openrouterModelId.length === 0) {
      throw new Error("Invalid model id: openrouter/… is missing the OpenRouter model id");
    }
    if (!openrouterModelId.includes("/")) {
      throw new Error(
        `Invalid OpenRouter model id "${openrouterModelId}". Expected "author/slug" (e.g. "openai/gpt-5-mini").`,
      );
    }
    return {
      kind: "fixed",
      transport: "openrouter",
      userModelId: `openrouter/${openrouterModelId}`,
      openrouterModelId,
      llmModelId: `openai/${openrouterModelId}`,
      openrouterProviders: null,
      forceOpenRouter: true,
      requiredEnv: "OPENROUTER_API_KEY",
    };
  }

  if (lower.startsWith("cli/")) {
    const parts = trimmed
      .split("/")
      .map((part) => part.trim())
      .filter((part) => part.length > 0);
    const cliProvider = parseCliProviderName(parts[1] ?? "");
    if (!cliProvider) {
      throw new Error(`Invalid CLI model id "${trimmed}". Expected cli/<provider>/<model>.`);
    }
    const requestedModel = parts.slice(2).join("/").trim();
    if (cliProvider === "agy" && requestedModel.length > 0) {
      throw new Error(
        `Invalid CLI model id "${trimmed}". Antigravity CLI uses cli/agy without a model suffix.`,
      );
    }
    const cliModel = requestedModel.length > 0 ? requestedModel : DEFAULT_CLI_MODELS[cliProvider];
    const requiredEnv = requiredEnvForCliProvider(cliProvider);
    const userModelId = cliModel ? `cli/${cliProvider}/${cliModel}` : `cli/${cliProvider}`;
    return {
      kind: "fixed",
      transport: "cli",
      userModelId,
      llmModelId: null,
      openrouterProviders: null,
      forceOpenRouter: false,
      requiredEnv,
      cliProvider,
      cliModel,
    };
  }

  if (lower.startsWith("openclaw/")) {
    const model = trimmed.slice("openclaw/".length).trim() || "main";
    return {
      kind: "fixed",
      transport: "cli",
      userModelId: `openclaw/${model}`,
      llmModelId: null,
      openrouterProviders: null,
      forceOpenRouter: false,
      requiredEnv: "CLI_OPENCLAW",
      cliProvider: "openclaw",
      cliModel: model,
    };
  }

  if (!trimmed.includes("/")) {
    const fastOpenAi = resolveOpenAiFastModelId(trimmed);
    if (fastOpenAi) {
      return {
        kind: "fixed",
        transport: "native",
        userModelId: trimmed,
        llmModelId: `openai/${fastOpenAi.modelId}`,
        provider: "openai",
        openrouterProviders: null,
        forceOpenRouter: false,
        requiredEnv: "OPENAI_API_KEY",
        requestOptions: fastOpenAi.options,
      };
    }
    throw new Error(
      `Unknown model "${trimmed}". Expected "auto" or a provider-prefixed id like openai/..., google/..., anthropic/..., xai/..., zai/..., nvidia/..., minimax/..., openrouter/... or cli/....`,
    );
  }

  const provider = lower.slice(0, lower.indexOf("/"));
  if (isGatewayProvider(provider)) {
    const profile = getGatewayProviderProfile(provider);
    if (profile.defaultBaseUrl) {
      const model = trimmed.slice(provider.length + 1).trim();
      if (model.length === 0) {
        throw new Error(`Invalid model id: ${provider}/… is missing the model id`);
      }
      const userModelId = normalizeGatewayStyleModelId(`${provider}/${model}`);
      return {
        kind: "fixed",
        transport: "native",
        userModelId,
        llmModelId: userModelId,
        provider,
        openrouterProviders: null,
        forceOpenRouter: false,
        requiredEnv: profile.requiredEnv,
        openaiBaseUrlOverride: profile.defaultBaseUrl,
        forceChatCompletions: profile.forceChatCompletions,
      };
    }
  }

  const userModelId = normalizeGatewayStyleModelId(trimmed);
  const parsed = parseGatewayStyleModelId(userModelId);
  const fastOpenAi = parsed.provider === "openai" ? resolveOpenAiFastModelId(parsed.model) : null;
  const llmModelId = fastOpenAi ? `openai/${fastOpenAi.modelId}` : userModelId;
  const requiredEnv = requiredEnvForGatewayProvider(parsed.provider);
  return {
    kind: "fixed",
    transport: "native",
    userModelId,
    llmModelId,
    provider: parsed.provider,
    openrouterProviders: null,
    forceOpenRouter: false,
    requiredEnv,
    ...(fastOpenAi ? { requestOptions: fastOpenAi.options } : {}),
  };
}
