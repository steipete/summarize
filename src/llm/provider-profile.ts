import type { CliProvider } from "../config.js";
import {
  buildGitHubModelsHeaders,
  GITHUB_MODELS_BASE_URL,
  resolveGitHubModelsApiKey,
} from "./github-models.js";
import { normalizeGatewayStyleModelId, parseGatewayStyleModelId } from "./model-id.js";
import type { ModelRequestOptions } from "./model-options.js";
import { resolveOpenAiClientConfig } from "./openai-client-config.js";
import type { OpenAiClientConfig } from "./providers/types.js";

export type GatewayProvider =
  | "xai"
  | "openai"
  | "google"
  | "anthropic"
  | "evolink"
  | "zai"
  | "nvidia"
  | "minimax"
  | "github-copilot"
  | "ollama";

export type RequiredModelEnv =
  | "XAI_API_KEY"
  | "OPENAI_API_KEY"
  | "NVIDIA_API_KEY"
  | "GEMINI_API_KEY"
  | "ANTHROPIC_API_KEY"
  | "EVOLINK_API_KEY"
  | "OPENROUTER_API_KEY"
  | "Z_AI_API_KEY"
  | "MINIMAX_API_KEY"
  | "GITHUB_TOKEN"
  | "OLLAMA_BASE_URL"
  | "CLI_CLAUDE"
  | "CLI_CODEX"
  | "CLI_GEMINI"
  | "CLI_AGENT"
  | "CLI_OPENCLAW"
  | "CLI_OPENCODE"
  | "CLI_COPILOT"
  | "CLI_AGY"
  | "CLI_PI";

export type ProviderExecution =
  | "simple"
  | "google"
  | "anthropic"
  | "openai-http"
  | "openai-compatible";

export type GatewayProviderProfile = {
  requiredEnv: RequiredModelEnv;
  execution: ProviderExecution;
  supportsDocuments: boolean;
  supportsStreaming: boolean;
  supportsVideoUnderstanding: boolean;
  defaultBaseUrl?: string;
  forceChatCompletions?: boolean;
};

export const DEFAULT_OLLAMA_BASE_URL = "http://localhost:11434/v1";

export const DEFAULT_MINIMAX_BASE_URL = "https://api.minimax.io/v1";

export const DEFAULT_EVOLINK_BASE_URL = "https://direct.evolink.ai/v1";

const GATEWAY_PROVIDER_PROFILES: Record<GatewayProvider, GatewayProviderProfile> = {
  xai: {
    requiredEnv: "XAI_API_KEY",
    execution: "simple",
    supportsDocuments: false,
    supportsStreaming: true,
    supportsVideoUnderstanding: false,
  },
  openai: {
    requiredEnv: "OPENAI_API_KEY",
    execution: "openai-http",
    supportsDocuments: true,
    supportsStreaming: true,
    supportsVideoUnderstanding: false,
  },
  google: {
    requiredEnv: "GEMINI_API_KEY",
    execution: "google",
    supportsDocuments: true,
    supportsStreaming: true,
    supportsVideoUnderstanding: true,
  },
  anthropic: {
    requiredEnv: "ANTHROPIC_API_KEY",
    execution: "anthropic",
    supportsDocuments: true,
    supportsStreaming: true,
    supportsVideoUnderstanding: false,
  },
  evolink: {
    requiredEnv: "EVOLINK_API_KEY",
    execution: "openai-compatible",
    supportsDocuments: false,
    supportsStreaming: true,
    supportsVideoUnderstanding: false,
    defaultBaseUrl: DEFAULT_EVOLINK_BASE_URL,
    forceChatCompletions: true,
  },
  zai: {
    requiredEnv: "Z_AI_API_KEY",
    execution: "openai-compatible",
    supportsDocuments: false,
    supportsStreaming: true,
    supportsVideoUnderstanding: false,
    defaultBaseUrl: "https://api.z.ai/api/paas/v4",
    forceChatCompletions: true,
  },
  nvidia: {
    requiredEnv: "NVIDIA_API_KEY",
    execution: "openai-compatible",
    supportsDocuments: false,
    supportsStreaming: true,
    supportsVideoUnderstanding: false,
    defaultBaseUrl: "https://integrate.api.nvidia.com/v1",
    forceChatCompletions: true,
  },
  minimax: {
    requiredEnv: "MINIMAX_API_KEY",
    execution: "openai-compatible",
    supportsDocuments: false,
    supportsStreaming: true,
    supportsVideoUnderstanding: false,
    defaultBaseUrl: DEFAULT_MINIMAX_BASE_URL,
    forceChatCompletions: true,
  },
  "github-copilot": {
    requiredEnv: "GITHUB_TOKEN",
    execution: "openai-http",
    supportsDocuments: false,
    supportsStreaming: true,
    supportsVideoUnderstanding: false,
    defaultBaseUrl: GITHUB_MODELS_BASE_URL,
    forceChatCompletions: true,
  },
  ollama: {
    requiredEnv: "OLLAMA_BASE_URL",
    execution: "openai-compatible",
    supportsDocuments: false,
    supportsStreaming: true,
    supportsVideoUnderstanding: false,
    defaultBaseUrl: DEFAULT_OLLAMA_BASE_URL,
    forceChatCompletions: true,
  },
};

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

type CliRequiredModelEnv = Extract<RequiredModelEnv, `CLI_${string}`>;

export type CliProviderProfile = {
  requiredEnv: CliRequiredModelEnv;
  defaultModel: string | null;
  missingBinaryLabel: string;
  installLabel: string;
  pathEnv: string;
};

const CLI_PROVIDER_PROFILES: Record<CliProvider, CliProviderProfile> = {
  claude: {
    requiredEnv: "CLI_CLAUDE",
    defaultModel: "sonnet",
    missingBinaryLabel: "Claude CLI",
    installLabel: "Claude CLI",
    pathEnv: "CLAUDE_PATH",
  },
  codex: {
    requiredEnv: "CLI_CODEX",
    defaultModel: null,
    missingBinaryLabel: "Codex CLI",
    installLabel: "Codex CLI",
    pathEnv: "CODEX_PATH",
  },
  gemini: {
    requiredEnv: "CLI_GEMINI",
    defaultModel: "flash",
    missingBinaryLabel: "Gemini CLI",
    installLabel: "Gemini CLI",
    pathEnv: "GEMINI_PATH",
  },
  agent: {
    requiredEnv: "CLI_AGENT",
    defaultModel: "auto",
    missingBinaryLabel: "Cursor Agent CLI",
    installLabel: "Cursor CLI",
    pathEnv: "AGENT_PATH",
  },
  openclaw: {
    requiredEnv: "CLI_OPENCLAW",
    defaultModel: "main",
    missingBinaryLabel: "OpenClaw CLI",
    installLabel: "OpenClaw CLI",
    pathEnv: "OPENCLAW_PATH",
  },
  opencode: {
    requiredEnv: "CLI_OPENCODE",
    defaultModel: null,
    missingBinaryLabel: "OpenCode CLI",
    installLabel: "OpenCode CLI",
    pathEnv: "OPENCODE_PATH",
  },
  copilot: {
    requiredEnv: "CLI_COPILOT",
    defaultModel: null,
    missingBinaryLabel: "GitHub Copilot CLI",
    installLabel: "Copilot CLI",
    pathEnv: "COPILOT_PATH",
  },
  agy: {
    requiredEnv: "CLI_AGY",
    defaultModel: null,
    missingBinaryLabel: "Antigravity CLI",
    installLabel: "agy",
    pathEnv: "AGY_PATH",
  },
  pi: {
    requiredEnv: "CLI_PI",
    defaultModel: null,
    missingBinaryLabel: "pi CLI",
    installLabel: "pi",
    pathEnv: "PI_PATH",
  },
};

export const DEFAULT_CLI_MODELS = Object.fromEntries(
  Object.entries(CLI_PROVIDER_PROFILES).map(([provider, profile]) => [
    provider,
    profile.defaultModel,
  ]),
) as Record<CliProvider, string | null>;

export const DEFAULT_AUTO_CLI_ORDER: CliProvider[] = [
  "claude",
  "gemini",
  "codex",
  "agent",
  "openclaw",
  "opencode",
  "copilot",
  // agy is intentionally excluded from the default auto-fallback order.
  // Use --cli agy or --model cli/agy to opt in explicitly.
  // pi is also excluded; use --cli pi or --model cli/pi explicitly.
];

export function parseCliProviderName(raw: string): CliProvider | null {
  const normalized = raw.trim().toLowerCase();
  return Object.hasOwn(CLI_PROVIDER_PROFILES, normalized) ? (normalized as CliProvider) : null;
}

export function getCliProviderProfile(provider: CliProvider): CliProviderProfile {
  return CLI_PROVIDER_PROFILES[provider];
}

export function requiredEnvForCliProvider(provider: CliProvider): RequiredModelEnv {
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

export function isGatewayProvider(provider: string): provider is GatewayProvider {
  return Object.hasOwn(GATEWAY_PROVIDER_PROFILES, provider);
}

export function getGatewayProviderProfile(provider: GatewayProvider): GatewayProviderProfile {
  return GATEWAY_PROVIDER_PROFILES[provider];
}

export function requiredEnvForGatewayProvider(provider: GatewayProvider): RequiredModelEnv {
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
): provider is "evolink" | "zai" | "nvidia" | "minimax" | "ollama" {
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
  provider: "openai" | "evolink" | "zai" | "nvidia" | "minimax" | "github-copilot" | "ollama";
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
  if (provider === "github-copilot") {
    const apiKey = openaiApiKey;
    if (!apiKey) {
      throw new Error("Missing GITHUB_TOKEN (or GH_TOKEN) for github-copilot/... model");
    }
    return {
      apiKey,
      baseURL: openaiBaseUrlOverride ?? GITHUB_MODELS_BASE_URL,
      useChatCompletions: true,
      isOpenRouter: false,
      extraHeaders: buildGitHubModelsHeaders(),
    };
  }
  if (provider === "ollama") {
    return {
      apiKey: openaiApiKey?.trim() || "ollama",
      baseURL: openaiBaseUrlOverride ?? DEFAULT_OLLAMA_BASE_URL,
      useChatCompletions: true,
      isOpenRouter: false,
      ...(requestOptions ? { requestOptions } : {}),
    };
  }

  const apiKey = openaiApiKey;
  if (!apiKey) {
    throw new Error(
      provider === "evolink"
        ? "Missing EVOLINK_API_KEY for evolink/... model"
        : provider === "zai"
          ? "Missing Z_AI_API_KEY for zai/... model"
          : provider === "minimax"
            ? "Missing MINIMAX_API_KEY for minimax/... model"
            : "Missing NVIDIA_API_KEY for nvidia/... model",
    );
  }

  const defaultBaseUrl =
    provider === "evolink"
      ? DEFAULT_EVOLINK_BASE_URL
      : provider === "zai"
        ? "https://api.z.ai/api/paas/v4"
        : provider === "minimax"
          ? DEFAULT_MINIMAX_BASE_URL
          : "https://integrate.api.nvidia.com/v1";

  return {
    apiKey,
    baseURL: openaiBaseUrlOverride ?? defaultBaseUrl,
    useChatCompletions: true,
    isOpenRouter: false,
    ...(requestOptions ? { requestOptions } : {}),
  };
}
