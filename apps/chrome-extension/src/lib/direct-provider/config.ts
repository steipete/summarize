import type { DirectProvider, ProviderSettings } from "../settings";

export type DirectModelConfig = {
  provider: Exclude<DirectProvider, "github">;
  model: string;
  baseUrl: string;
  apiKey: string;
};

const DEFAULT_MODELS: Record<DirectModelConfig["provider"], string> = {
  openai: "gpt-5-mini",
  openrouter: "openai/gpt-5-mini",
  anthropic: "claude-sonnet-4-5",
  google: "gemini-3-flash",
  xai: "grok-4-fast-non-reasoning",
  zai: "glm-4.5-flash",
  nvidia: "meta/llama-3.3-70b-instruct",
  minimax: "MiniMax-M2.1",
  ollama: "llama3.2",
};

const DEFAULT_BASE_URLS: Record<DirectModelConfig["provider"], string> = {
  openai: "https://api.openai.com/v1",
  openrouter: "https://openrouter.ai/api/v1",
  anthropic: "https://api.anthropic.com",
  google: "https://generativelanguage.googleapis.com/v1beta",
  xai: "https://api.x.ai/v1",
  zai: "https://api.z.ai/api/paas/v4",
  nvidia: "https://integrate.api.nvidia.com/v1",
  minimax: "https://api.minimax.io/v1",
  ollama: "http://localhost:11434/v1",
};

const PROVIDER_LABELS: Record<DirectModelConfig["provider"], string> = {
  openai: "OpenAI",
  openrouter: "OpenRouter",
  anthropic: "Anthropic",
  google: "Google Gemini",
  xai: "xAI",
  zai: "Z.AI",
  nvidia: "NVIDIA",
  minimax: "MiniMax",
  ollama: "Ollama",
};

const PROVIDER_PREFIXES = new Set<DirectProvider>(Object.keys(PROVIDER_LABELS) as DirectProvider[]);

function assertActiveProvider(
  provider: DirectProvider | "github-copilot",
): asserts provider is DirectModelConfig["provider"] {
  if (provider === "github" || provider === "github-copilot") {
    throw new Error(
      "The GitHub Models provider is retired (July 30, 2026). Choose another provider in Settings > Runtime.",
    );
  }
}

function trimTrailingSlash(value: string): string {
  return value.trim().replace(/\/+$/, "");
}

function providerKey(settings: ProviderSettings, provider: DirectProvider): string {
  return settings.apiKeys[provider]?.trim() ?? "";
}

function splitModelId(rawModel: string): {
  provider: DirectProvider | null;
  model: string;
} {
  const trimmed = rawModel.trim();
  const slash = trimmed.indexOf("/");
  if (slash <= 0) return { provider: null, model: trimmed };
  const rawPrefix = trimmed.slice(0, slash).toLowerCase();
  assertActiveProvider(rawPrefix as DirectProvider | "github-copilot");
  const prefix = rawPrefix as DirectProvider;
  if (!PROVIDER_PREFIXES.has(prefix)) return { provider: null, model: trimmed };
  return { provider: prefix, model: trimmed.slice(slash + 1) };
}

export function providerLabel(provider: DirectProvider): string {
  if (provider === "github") return "GitHub Models (retired)";
  return PROVIDER_LABELS[provider];
}

export function resolveDirectProviderForModel(
  rawModel: string,
  fallbackProvider: DirectProvider,
): DirectProvider {
  const parsed = splitModelId(rawModel);
  if (!parsed.provider && parsed.model.toLowerCase() !== "free")
    assertActiveProvider(fallbackProvider);
  return parsed.model.toLowerCase() === "free"
    ? "openrouter"
    : (parsed.provider ?? fallbackProvider);
}

function resolveAutoProvider(settings: ProviderSettings): DirectProvider {
  const configured = settings.provider;
  assertActiveProvider(configured);
  if (configured === "ollama" || providerKey(settings, configured)) return configured;
  throw new Error(
    `Add an API key for ${providerLabel(configured)} in Settings > Runtime before using Auto.`,
  );
}

export function resolveDirectModel(
  rawModel: string,
  settings: ProviderSettings,
): DirectModelConfig {
  const parsed = splitModelId(rawModel);
  const requestedModel = parsed.model.toLowerCase();
  const provider = parsed.provider
    ? resolveDirectProviderForModel(rawModel, settings.provider)
    : requestedModel === "free"
      ? "openrouter"
      : resolveAutoProvider(settings);
  assertActiveProvider(provider);
  const model =
    !parsed.model || requestedModel === "auto" || requestedModel === "gpt-fast"
      ? DEFAULT_MODELS[provider]
      : requestedModel === "free" && provider === "openrouter"
        ? "openrouter/free"
        : parsed.model;
  const apiKey =
    provider === "ollama"
      ? providerKey(settings, provider) || "ollama"
      : providerKey(settings, provider);
  if (!apiKey) {
    throw new Error(`Add an API key for ${providerLabel(provider)} in Settings > Runtime.`);
  }
  const configuredBaseUrl = settings.baseUrls[provider]?.trim();
  return {
    provider,
    model,
    apiKey,
    baseUrl: trimTrailingSlash(configuredBaseUrl || DEFAULT_BASE_URLS[provider]),
  };
}
