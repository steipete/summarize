export { GITHUB_MODELS_BASE_URL } from "./provider-registry.js";
export const GITHUB_MODELS_API_VERSION = "2026-03-10";

const GITHUB_COPILOT_PROVIDER_PATTERNS = {
  openai: [/^gpt-/i, /^chatgpt-/i, /^o\d(?=$|[-.])/i],
  anthropic: [/^claude-/i, /^(opus|sonnet|haiku)-/i],
  google: [/^gemini-/i],
  xai: [/^grok-/i],
} as const;

export function resolveGitHubModelsApiKey(env: Record<string, string | undefined>): string | null {
  const githubToken = env.GITHUB_TOKEN?.trim();
  if (githubToken) return githubToken;
  const ghToken = env.GH_TOKEN?.trim();
  return ghToken || null;
}

function inferGitHubCopilotProvider(
  model: string,
): "openai" | "anthropic" | "google" | "xai" | null {
  for (const [provider, patterns] of Object.entries(GITHUB_COPILOT_PROVIDER_PATTERNS)) {
    if (patterns.some((pattern) => pattern.test(model))) {
      return provider as "openai" | "anthropic" | "google" | "xai";
    }
  }
  return null;
}

export function resolveGitHubCopilotBackendModelId(model: string): string {
  const trimmed = model.trim();
  if (!trimmed) return trimmed;
  if (trimmed.includes("/")) return trimmed;
  const provider = inferGitHubCopilotProvider(trimmed);
  if (provider === "anthropic" && /^(opus|sonnet|haiku)-/i.test(trimmed)) {
    return `anthropic/claude-${trimmed}`;
  }
  if (provider) return `${provider}/${trimmed}`;
  return trimmed;
}

export function buildGitHubModelsHeaders(
  existing?: Record<string, string>,
): Record<string, string> {
  return {
    ...(existing ?? {}),
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": GITHUB_MODELS_API_VERSION,
  };
}

export function resolveGitHubModelsCompatFallbackModelId(modelId: string): string | null {
  const normalized = modelId.trim().toLowerCase();
  if (!normalized.startsWith("openai/gpt-5") || normalized === "openai/gpt-5-chat") {
    return null;
  }
  return "openai/gpt-5-chat";
}

export function shouldRetryGitHubModelsCompat(error: unknown): boolean {
  const statusCode =
    typeof (error as { statusCode?: unknown })?.statusCode === "number"
      ? Number((error as { statusCode?: unknown }).statusCode)
      : null;
  if (statusCode === 400 || statusCode === 404 || statusCode === 500 || statusCode === 502) {
    return true;
  }

  const message =
    error instanceof Error
      ? error.message
      : typeof (error as { errorMessage?: unknown })?.errorMessage === "string"
        ? String((error as { errorMessage: string }).errorMessage)
        : typeof error === "string"
          ? error
          : "";
  return /\b(?:400|404|500|502)\b/u.test(message);
}
