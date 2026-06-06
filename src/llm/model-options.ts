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
 * Merge request options for a specific provider.
 *
 * - `openaiGlobalDefault` comes from the persisted `openai.*` config block — a
 *   provider-scoped default that must NOT bleed into non-openai requests.
 * - `openaiOverride` comes from `--fast` / `--service-tier`, which are
 *   documented as OpenAI-only knobs. Also only for the openai provider.
 * - `cliReasoningEffortOverride` comes from the explicit `--thinking` CLI flag,
 *   which is cross-provider (the user opted in for this run). It is forwarded
 *   to whichever provider is dispatched.
 * - `attemptOptions` is the per-attempt options bag (from the model config or
 *   provider-prefixed CLI id) and applies to every provider.
 */
export function mergeRequestOptionsForProvider({
  provider,
  openaiGlobalDefault,
  attemptOptions,
  openaiOverride,
  cliReasoningEffortOverride,
}: {
  provider: string;
  openaiGlobalDefault: ModelRequestOptionsInput | null | undefined;
  attemptOptions: ModelRequestOptionsInput | null | undefined;
  openaiOverride: ModelRequestOptionsInput | null | undefined;
  cliReasoningEffortOverride?: OpenAiReasoningEffort | undefined;
}): ModelRequestOptions | undefined {
  const cliReasoningEntry: ModelRequestOptionsInput | undefined = cliReasoningEffortOverride
    ? { reasoningEffort: cliReasoningEffortOverride }
    : undefined;
  if (provider === "openai") {
    return mergeModelRequestOptions(
      openaiGlobalDefault,
      attemptOptions,
      openaiOverride,
      cliReasoningEntry,
    );
  }
  return mergeModelRequestOptions(attemptOptions, cliReasoningEntry);
}

export function toOpenAiServiceTierParam(serviceTier: string | undefined): string | undefined {
  const normalized = serviceTier?.trim();
  if (!normalized) return undefined;
  const lower = normalized.toLowerCase();
  if (lower === "default") return undefined;
  return lower === "fast" ? "priority" : normalized;
}
