import type { CliProvider } from "../config.js";
import { normalizeGatewayStyleModelId, parseGatewayStyleModelId } from "./model-id.js";
import { resolveOpenAiClientConfig } from "./providers/openai.js";
import type { OpenAiClientConfig } from "./providers/types.js";

export type GatewayProvider = "xai" | "openai" | "google" | "anthropic" | "zai" | "nvidia";

export type RequiredModelEnv =
  | "XAI_API_KEY"
  | "OPENAI_API_KEY"
  | "NVIDIA_API_KEY"
  | "GEMINI_API_KEY"
  | "ANTHROPIC_API_KEY"
  | "OPENROUTER_API_KEY"
  | "Z_AI_API_KEY"
  | "CLI_CLAUDE"
  | "CLI_CODEX"
  | "CLI_GEMINI"
  | "CLI_AGENT"
  | "CLI_OPENCLAW";

type GatewayProviderProfile = {
  requiredEnv: RequiredModelEnv;
  supportsDocuments: boolean;
  supportsStreaming: boolean;
  supportsVideoUnderstanding: boolean;
};

const GATEWAY_PROVIDER_PROFILES: Record<GatewayProvider, GatewayProviderProfile> = {
  xai: {
    requiredEnv: "XAI_API_KEY",
    supportsDocuments: false,
    supportsStreaming: true,
    supportsVideoUnderstanding: false,
  },
  openai: {
    requiredEnv: "OPENAI_API_KEY",
    supportsDocuments: true,
    supportsStreaming: true,
    supportsVideoUnderstanding: false,
  },
  google: {
    requiredEnv: "GEMINI_API_KEY",
    supportsDocuments: true,
    supportsStreaming: true,
    supportsVideoUnderstanding: true,
  },
  anthropic: {
    requiredEnv: "ANTHROPIC_API_KEY",
    supportsDocuments: true,
    supportsStreaming: true,
    supportsVideoUnderstanding: false,
  },
  zai: {
    requiredEnv: "Z_AI_API_KEY",
    supportsDocuments: false,
    supportsStreaming: true,
    supportsVideoUnderstanding: false,
  },
  nvidia: {
    requiredEnv: "NVIDIA_API_KEY",
    supportsDocuments: false,
    supportsStreaming: true,
    supportsVideoUnderstanding: false,
  },
};

export const DEFAULT_CLI_MODELS: Record<CliProvider, string> = {
  claude: "sonnet",
  codex: "gpt-5.2",
  gemini: "gemini-3-flash",
  agent: "gpt-5.2",
  openclaw: "main",
};

export const DEFAULT_AUTO_CLI_ORDER: CliProvider[] = ["claude", "gemini", "codex", "agent", "openclaw"];

export function parseCliProviderName(raw: string): CliProvider | null {
  const normalized = raw.trim().toLowerCase();
  if (normalized === "claude") return "claude";
  if (normalized === "codex") return "codex";
  if (normalized === "gemini") return "gemini";
  if (normalized === "agent") return "agent";
  if (normalized === "openclaw") return "openclaw";
  return null;
}

export function requiredEnvForCliProvider(provider: CliProvider): RequiredModelEnv {
  return provider === "codex"
    ? "CLI_CODEX"
    : provider === "gemini"
      ? "CLI_GEMINI"
      : provider === "agent"
        ? "CLI_AGENT"
        : provider === "openclaw"
          ? "CLI_OPENCLAW"
          : "CLI_CLAUDE";
}

export function getGatewayProviderProfile(provider: GatewayProvider): GatewayProviderProfile {
  return GATEWAY_PROVIDER_PROFILES[provider];
}

export function requiredEnvForGatewayProvider(provider: GatewayProvider): RequiredModelEnv {
  return getGatewayProviderProfile(provider).requiredEnv;
}

export function supportsDocumentAttachments(provider: GatewayProvider): boolean {
  return getGatewayProviderProfile(provider).supportsDocuments;
}

export function supportsStreaming(provider: GatewayProvider): boolean {
  return getGatewayProviderProfile(provider).supportsStreaming;
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
  return Boolean(env[requiredEnv]?.trim());
}

export function resolveRequiredEnvForModelId(modelId: string): RequiredModelEnv {
  const trimmed = modelId.trim();
  if (trimmed.toLowerCase().startsWith("cli/")) {
    const parts = trimmed.split("/").map((entry) => entry.trim());
    const provider = parseCliProviderName(parts[1] ?? "");
    return provider ? requiredEnvForCliProvider(provider) : "CLI_CLAUDE";
  }
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
}: {
  provider: "openai" | "zai" | "nvidia";
  openaiApiKey: string | null;
  openrouterApiKey: string | null;
  forceOpenRouter?: boolean;
  openaiBaseUrlOverride?: string | null;
  forceChatCompletions?: boolean;
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
    });
  }

  const apiKey = openaiApiKey;
  if (!apiKey) {
    throw new Error(
      provider === "zai"
        ? "Missing Z_AI_API_KEY for zai/... model"
        : "Missing NVIDIA_API_KEY for nvidia/... model",
    );
  }

  return {
    apiKey,
    baseURL:
      openaiBaseUrlOverride ??
      (provider === "zai" ? "https://api.z.ai/api/paas/v4" : "https://integrate.api.nvidia.com/v1"),
    useChatCompletions: true,
    isOpenRouter: false,
  };
}
