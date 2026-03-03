export type LlmProvider = "xai" | "openai" | "google" | "anthropic" | "zai" | "nvidia";

export type ParsedModelId = {
  provider: LlmProvider;
  /**
   * Provider-native model id (no prefix), e.g. `grok-4-fast-non-reasoning`.
   */
  model: string;
  /**
   * Canonical gateway-style id, e.g. `xai/grok-4-fast-non-reasoning`.
   */
  canonical: string;
};

const PROVIDERS: LlmProvider[] = ["xai", "openai", "google", "anthropic", "zai", "nvidia"];

/**
 * Anthropic short model aliases that are NOT valid API model identifiers.
 *
 * The Anthropic Messages API accepts dated ids (e.g. `claude-sonnet-4-20250514`)
 * and versioned aliases (e.g. `claude-sonnet-4-0`) but does NOT accept bare
 * generation names like `claude-sonnet-4`.  Users naturally try the shortest
 * form, so we map them to the `-0` versioned alias which always points to the
 * latest point-release for that generation.
 */
const ANTHROPIC_MODEL_ALIASES: Record<string, string> = {
  "claude-sonnet-4": "claude-sonnet-4-0",
  "claude-opus-4": "claude-opus-4-0",
};

export function normalizeGatewayStyleModelId(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    throw new Error("Missing model id");
  }

  const lower = trimmed.toLowerCase();

  // Common historical alias (used in prompts/docs earlier)
  if (lower === "grok-4-1-fast-non-reasoning") return "xai/grok-4-fast-non-reasoning";
  if (lower === "grok-4.1-fast-non-reasoning") return "xai/grok-4-fast-non-reasoning";
  if (lower === "xai/grok-4-1-fast-non-reasoning") return "xai/grok-4-fast-non-reasoning";
  if (lower === "xai/grok-4.1-fast-non-reasoning") return "xai/grok-4-fast-non-reasoning";

  // Anthropic short aliases → versioned alias (e.g. claude-sonnet-4 → claude-sonnet-4-0)
  const anthropicAlias = ANTHROPIC_MODEL_ALIASES[lower];
  if (anthropicAlias) return `anthropic/${anthropicAlias}`;
  const anthropicPrefixed = lower.startsWith("anthropic/")
    ? ANTHROPIC_MODEL_ALIASES[lower.slice("anthropic/".length)]
    : null;
  if (anthropicPrefixed) return `anthropic/${anthropicPrefixed}`;

  const slash = trimmed.indexOf("/");
  if (slash === -1) {
    // Best-effort inference for backwards-compat CLI usage.
    // Use lowercase for provider detection, but preserve original model casing.
    if (lower.startsWith("grok-")) return `xai/${trimmed}`;
    if (lower.startsWith("gemini-")) return `google/${trimmed}`;
    if (lower.startsWith("claude-")) return `anthropic/${trimmed}`;
    return `openai/${trimmed}`;
  }

  const provider = lower.slice(0, slash);
  const model = trimmed.slice(slash + 1);
  if (!PROVIDERS.includes(provider as LlmProvider)) {
    throw new Error(
      `Unsupported model provider "${provider}". Use xai/..., openai/..., google/..., anthropic/..., zai/..., or nvidia/...`,
    );
  }
  if (model.trim().length === 0) {
    throw new Error("Missing model id after provider prefix");
  }
  return `${provider}/${model}`;
}

export function parseGatewayStyleModelId(raw: string): ParsedModelId {
  const canonical = normalizeGatewayStyleModelId(raw);
  const slash = canonical.indexOf("/");
  const provider = canonical.slice(0, slash) as LlmProvider;
  const model = canonical.slice(slash + 1);
  return { provider, model, canonical };
}
