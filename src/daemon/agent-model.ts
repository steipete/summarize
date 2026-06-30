import type { Api, Model } from "@earendil-works/pi-ai";
import { getModel } from "@earendil-works/pi-ai/compat";
import { isOpenRouterBaseUrl } from "@steipete/summarize-core";
import { createRunConfigInput } from "../application/config-state.js";
import { resolveRunContextState } from "../application/context.js";
import {
  resolveModelAttempts,
  selectPreferredInteractiveModelAttempt,
} from "../application/model-attempts.js";
import { resolveModelSelection } from "../application/model-selection.js";
import { resolveProviderRuntimeBindings } from "../application/provider-runtime.js";
import type { CliProvider } from "../config.js";
import type { ModelAttempt } from "../engine/types.js";
import { buildGitHubModelsHeaders, resolveGitHubModelsApiKey } from "../llm/github-models.js";
import { parseGatewayStyleModelId } from "../llm/model-id.js";
import {
  cliProviderForRequiredEnv,
  envHasRequiredKey,
  getGatewayProviderProfile,
  isGatewayProvider,
  requiredEnvForGatewayProvider,
  type GatewayProvider,
} from "../llm/provider-capabilities.js";
import { resolveMinimaxModel } from "../llm/providers/models.js";
import { createSyntheticModel } from "../llm/providers/shared.js";
import type { AutoModelAttempt } from "../model-auto.js";
import { resolveRunOverrides } from "../run/run-settings.js";

type AgentApiKeys = {
  openaiApiKey: string | null;
  openrouterApiKey: string | null;
  anthropicApiKey: string | null;
  googleApiKey: string | null;
  xaiApiKey: string | null;
  zaiApiKey: string | null;
  nvidiaApiKey: string | null;
  minimaxApiKey: string | null;
  githubApiKey: string | null;
};

function isCustomOpenAiBaseUrl(baseUrl: string | null): boolean {
  if (!baseUrl) return false;
  try {
    return new URL(baseUrl).host !== "api.openai.com";
  } catch {
    return false;
  }
}

function overrideModelGatewaySettings({
  provider,
  model,
  baseUrl,
  forceOpenAiChatCompletions,
}: {
  provider: string;
  model: Model<Api>;
  baseUrl: string | null;
  forceOpenAiChatCompletions: boolean | undefined;
}) {
  const nextModel = baseUrl ? ({ ...model, baseUrl } as Model<Api>) : model;
  if (provider !== "openai") return nextModel;
  const effectiveBaseUrl =
    typeof nextModel.baseUrl === "string" && nextModel.baseUrl.trim().length > 0
      ? nextModel.baseUrl.trim()
      : null;
  const isOpenRouterBase = effectiveBaseUrl !== null && isOpenRouterBaseUrl(effectiveBaseUrl);
  const shouldUseChatCompletions = isOpenRouterBase
    ? true
    : typeof forceOpenAiChatCompletions === "boolean"
      ? forceOpenAiChatCompletions
      : isCustomOpenAiBaseUrl(effectiveBaseUrl);
  if (!shouldUseChatCompletions) return nextModel;
  const headers = isOpenRouterBase
    ? {
        ...((nextModel as Model<Api> & { headers?: Record<string, string> }).headers ?? {}),
        "HTTP-Referer": "https://github.com/steipete/summarize",
        "X-Title": "summarize",
      }
    : (nextModel as Model<Api> & { headers?: Record<string, string> }).headers;
  return {
    ...nextModel,
    api: "openai-completions",
    ...(headers ? { headers } : {}),
  } as Model<Api>;
}

function resolveModelWithFallback({
  provider,
  modelId,
  baseUrl,
  forceOpenAiChatCompletions,
}: {
  provider: string;
  modelId: string;
  baseUrl: string | null;
  forceOpenAiChatCompletions: boolean | undefined;
}): Model<Api> {
  try {
    const model = getModel(provider as never, modelId as never);
    if (!model) throw new Error(`Model not found: ${provider}/${modelId}`);
    return overrideModelGatewaySettings({
      provider,
      model: model as Model<Api>,
      baseUrl,
      forceOpenAiChatCompletions,
    });
  } catch (error) {
    if (baseUrl) {
      const isOpenRouterBase = isOpenRouterBaseUrl(baseUrl);
      const api =
        provider === "openai" && forceOpenAiChatCompletions === false && !isOpenRouterBase
          ? "openai-responses"
          : "openai-completions";
      return createSyntheticModel({
        provider: provider as never,
        modelId,
        api,
        baseUrl,
        allowImages: false,
      });
    }
    if (provider === "openrouter") {
      return createSyntheticModel({
        provider: "openrouter",
        modelId,
        api: "openai-completions",
        baseUrl: "https://openrouter.ai/api/v1",
        allowImages: false,
      });
    }
    throw error;
  }
}

export function resolveApiKeyForModel({
  provider,
  apiKeys,
}: {
  provider: string;
  apiKeys: AgentApiKeys;
}): string {
  if (provider === "openrouter") {
    if (apiKeys.openrouterApiKey) return apiKeys.openrouterApiKey;
    throw new Error("Missing OPENROUTER_API_KEY for openrouter model");
  }
  if (!isGatewayProvider(provider)) {
    throw new Error(`Missing API key for provider: ${provider}`);
  }

  const gatewayApiKeys: Partial<Record<GatewayProvider, string | null>> = {
    openai: apiKeys.openaiApiKey,
    anthropic: apiKeys.anthropicApiKey,
    google: apiKeys.googleApiKey,
    xai: apiKeys.xaiApiKey,
    zai: apiKeys.zaiApiKey,
    nvidia: apiKeys.nvidiaApiKey,
    minimax: apiKeys.minimaxApiKey,
    "github-copilot": apiKeys.githubApiKey,
    ollama: apiKeys.openaiApiKey ?? "ollama",
  };
  const resolved = gatewayApiKeys[provider];
  if (resolved) return resolved;
  throw new Error(`Missing ${requiredEnvForGatewayProvider(provider)} for ${provider} model`);
}

function buildNoAgentModelAvailableError({
  attempts,
  envForAuto,
  cliAvailability,
}: {
  attempts: Pick<AutoModelAttempt, "transport" | "userModelId" | "requiredEnv">[];
  envForAuto: Record<string, string | undefined>;
  cliAvailability: Partial<Record<CliProvider, boolean>>;
}): Error {
  const checked = attempts.map((attempt) => attempt.userModelId);
  const missingEnv = Array.from(
    new Set(
      attempts
        .filter((attempt) => attempt.transport !== "cli")
        .map((attempt) => attempt.requiredEnv)
        .filter((requiredEnv) => !envHasRequiredKey(envForAuto, requiredEnv)),
    ),
  );
  const unavailableCli = Array.from(
    new Set(
      attempts
        .filter((attempt) => attempt.transport === "cli")
        .map((attempt) => cliProviderForRequiredEnv(attempt.requiredEnv))
        .filter((provider): provider is CliProvider => provider !== null)
        .filter((provider) => !cliAvailability[provider]),
    ),
  );

  const details = [
    "No model available for agent.",
    checked.length > 0 ? `Checked: ${checked.join(", ")}.` : null,
    missingEnv.length > 0 ? `Missing env: ${missingEnv.join(", ")}.` : null,
    unavailableCli.length > 0 ? `CLI unavailable: ${unavailableCli.join(", ")}.` : null,
    "Restart or reinstall the daemon after changing API keys or CLI installs so its saved environment updates.",
  ]
    .filter((part): part is string => Boolean(part))
    .join(" ");

  return new Error(details);
}

export async function resolveAgentModel({
  env,
  pageContent,
  modelOverride,
}: {
  env: Record<string, string | undefined>;
  pageContent: string;
  modelOverride: string | null;
}) {
  const context = resolveRunContextState({
    env,
    envForRun: env,
    configInput: createRunConfigInput(),
  });
  const {
    config,
    configPath,
    configForCli,
    apiKey,
    openrouterApiKey,
    anthropicApiKey,
    googleApiKey,
    xaiApiKey,
    zaiApiKey,
    nvidiaApiKey,
    minimaxApiKey,
    envForAuto,
    cliAvailability,
  } = context;

  const apiKeys: AgentApiKeys = {
    openaiApiKey: apiKey,
    openrouterApiKey,
    anthropicApiKey,
    googleApiKey,
    xaiApiKey,
    zaiApiKey,
    nvidiaApiKey,
    minimaxApiKey,
    githubApiKey: resolveGitHubModelsApiKey(env),
  };

  const overrides = resolveRunOverrides({});
  const maxOutputTokens = overrides.maxOutputTokensArg ?? 2048;

  const { requestedModel, configForModelSelection, isFallbackModel } = resolveModelSelection({
    config,
    configForCli,
    configPath,
    envForRun: env,
    explicitModelArg: modelOverride,
  });

  const providerRuntime = resolveProviderRuntimeBindings({ env, envState: context, configForCli });

  const resolveAttemptModel = (attempt: ModelAttempt) => {
    const { provider, modelId } =
      attempt.transport === "openrouter"
        ? {
            provider: "openrouter" as const,
            modelId: attempt.userModelId.replace(/^openrouter\//i, ""),
          }
        : (() => {
            if (!attempt.llmModelId) {
              throw new Error(`Missing model id for ${attempt.userModelId}`);
            }
            const parsed = parseGatewayStyleModelId(attempt.llmModelId);
            return { provider: parsed.provider, modelId: parsed.model };
          })();
    const baseUrl = provider === "openrouter" ? null : (attempt.openaiBaseUrlOverride ?? null);
    if (provider === "minimax") {
      return {
        provider,
        model: resolveMinimaxModel({
          modelId: modelId,
          context: {
            messages: [{ role: "user", content: pageContent, timestamp: Date.now() }],
          },
          openaiBaseUrlOverride: baseUrl,
        }),
      };
    }
    const providerForPiAi =
      provider === "nvidia" || provider === "github-copilot" || provider === "ollama"
        ? "openai"
        : provider;
    const model = resolveModelWithFallback({
      provider: providerForPiAi,
      modelId,
      baseUrl,
      forceOpenAiChatCompletions: attempt.forceChatCompletions,
    });
    return {
      provider,
      model:
        provider === "github-copilot"
          ? { ...model, headers: buildGitHubModelsHeaders(model.headers) }
          : model,
    };
  };

  const attempts = resolveModelAttempts({
    requestedModel,
    kind: "website",
    promptTokens: Math.ceil(pageContent.length / 4),
    desiredOutputTokens: maxOutputTokens,
    requiresVideoUnderstanding: false,
    envForAuto,
    configForModelSelection,
    catalog: null,
    openrouterProvidersFromEnv: null,
    cliAvailability,
    providerRuntime,
  });

  if (requestedModel.kind === "fixed") {
    const attempt = attempts[0];
    if (!attempt) {
      throw buildNoAgentModelAvailableError({ attempts, envForAuto, cliAvailability });
    }
    if (attempt.transport === "cli") {
      return {
        provider: "cli",
        model: null,
        maxOutputTokens,
        apiKeys,
        transport: "cli" as const,
        cliProvider: attempt.cliProvider!,
        cliModel: attempt.cliModel ?? null,
        userModelId: attempt.userModelId,
        cliConfig: configForCli?.cli ?? null,
      };
    }
    const resolved = resolveAttemptModel(attempt);
    return { ...resolved, maxOutputTokens, apiKeys };
  }

  if (!isFallbackModel) {
    throw buildNoAgentModelAvailableError({ attempts: [], envForAuto, cliAvailability });
  }

  const attempt = selectPreferredInteractiveModelAttempt({
    attempts,
    envForAuto,
    cliAvailability,
  });
  if (!attempt) {
    throw buildNoAgentModelAvailableError({ attempts, envForAuto, cliAvailability });
  }
  if (attempt.transport === "cli") {
    return {
      provider: "cli",
      model: null,
      maxOutputTokens,
      apiKeys,
      transport: "cli" as const,
      cliProvider: attempt.cliProvider!,
      cliModel: attempt.cliModel ?? null,
      userModelId: attempt.userModelId,
      cliConfig: configForCli?.cli ?? null,
    };
  }

  const resolved = resolveAttemptModel(attempt);
  return { ...resolved, maxOutputTokens, apiKeys };
}
