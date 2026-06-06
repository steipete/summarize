export type OpenAiReasoningEffort = "none" | "low" | "medium" | "high" | "xhigh";

export type OpenAiServiceTier = "default" | "fast" | "priority" | "flex";

export type OpenAiTextVerbosity = "low" | "medium" | "high";

export type ModelRequestOptions = {
  serviceTier?: string;
  reasoningEffort?: OpenAiReasoningEffort;
  textVerbosity?: OpenAiTextVerbosity;
};

export type ModelRequestOptionsInput = ModelRequestOptions & {
  thinking?: OpenAiReasoningEffort;
};

const REASONING_EFFORT_ALIASES: Record<string, OpenAiReasoningEffort> = {
  off: "none",
  none: "none",
  min: "low",
  low: "low",
  medium: "medium",
  med: "medium",
  mid: "medium",
  high: "high",
  xhigh: "xhigh",
  "x-high": "xhigh",
  "extra-high": "xhigh",
};

export function parseOpenAiReasoningEffort(
  raw: string,
  label = "reasoning effort",
): OpenAiReasoningEffort {
  const normalized = raw.trim().toLowerCase();
  const parsed = REASONING_EFFORT_ALIASES[normalized];
  if (parsed) return parsed;
  throw new Error(`Unsupported ${label}: ${raw} (expected none, low, medium, high, or xhigh)`);
}

export function parseOpenAiTextVerbosity(
  raw: string,
  label = "text verbosity",
): OpenAiTextVerbosity {
  const normalized = raw.trim().toLowerCase();
  if (normalized === "low" || normalized === "medium" || normalized === "high") {
    return normalized;
  }
  throw new Error(`Unsupported ${label}: ${raw} (expected low, medium, or high)`);
}

export function parseOpenAiServiceTier(raw: string, label = "service tier"): OpenAiServiceTier {
  const normalized = raw.trim().toLowerCase();
  if (
    normalized === "default" ||
    normalized === "fast" ||
    normalized === "priority" ||
    normalized === "flex"
  ) {
    return normalized;
  }
  throw new Error(`Unsupported ${label}: ${raw} (expected default, fast, priority, or flex)`);
}

export function mergeModelRequestOptions(
  ...entries: Array<ModelRequestOptionsInput | null | undefined>
): ModelRequestOptions | undefined {
  const merged: ModelRequestOptions = {};
  for (const entry of entries) {
    if (!entry) continue;
    if (typeof entry.serviceTier === "string" && entry.serviceTier.trim().length > 0) {
      merged.serviceTier = entry.serviceTier.trim();
    }
    if (entry.reasoningEffort ?? entry.thinking) {
      merged.reasoningEffort = entry.reasoningEffort ?? entry.thinking;
    }
    if (entry.textVerbosity) merged.textVerbosity = entry.textVerbosity;
  }
  return Object.keys(merged).length > 0 ? merged : undefined;
}

/**
 * Merge request options for a specific provider. The OpenAI-scoped global
 * default (`openaiRequestOptions`) and CLI override (`openaiRequestOptionsOverride`)
 * are sourced from `openai.*` config and `--thinking`/`--fast`/`--service-tier`
 * flags that documentation/CLI help describe as OpenAI-only. Those entries are
 * only applied for the `openai` provider; for every other provider only the
 * per-attempt options (set via the model config or a provider-prefixed CLI
 * model id) flow through.
 */
export function mergeRequestOptionsForProvider({
  provider,
  openaiGlobalDefault,
  attemptOptions,
  openaiOverride,
}: {
  provider: string;
  openaiGlobalDefault: ModelRequestOptionsInput | null | undefined;
  attemptOptions: ModelRequestOptionsInput | null | undefined;
  openaiOverride: ModelRequestOptionsInput | null | undefined;
}): ModelRequestOptions | undefined {
  if (provider === "openai") {
    return mergeModelRequestOptions(openaiGlobalDefault, attemptOptions, openaiOverride);
  }
  return mergeModelRequestOptions(attemptOptions);
}

export function toOpenAiServiceTierParam(serviceTier: string | undefined): string | undefined {
  const normalized = serviceTier?.trim();
  if (!normalized) return undefined;
  const lower = normalized.toLowerCase();
  if (lower === "default") return undefined;
  return lower === "fast" ? "priority" : normalized;
}
