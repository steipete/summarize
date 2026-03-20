import type { CliProvider } from "../config.js";
import type { LlmTokenUsage } from "./generate-text.js";

export type JsonCliProvider = Exclude<CliProvider, "codex" | "openclaw" | "opencode">;

const JSON_RESULT_FIELDS = ["result", "response", "output", "message", "text"] as const;

export function isJsonCliProvider(provider: CliProvider): provider is JsonCliProvider {
  return provider !== "codex" && provider !== "openclaw" && provider !== "opencode";
}

const parseJsonFromOutput = (output: string): unknown | null => {
  const trimmed = output.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      return JSON.parse(trimmed) as unknown;
    } catch {
      // fall through
    }
  }
  const lastBraceIndex = trimmed.lastIndexOf("\n{");
  if (lastBraceIndex >= 0) {
    const candidate = trimmed.slice(lastBraceIndex + 1).trim();
    try {
      return JSON.parse(candidate) as unknown;
    } catch {
      return null;
    }
  }
  return null;
};

const toNumber = (value: unknown): number | null => {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return value;
};

const parseClaudeUsage = (payload: Record<string, unknown>): LlmTokenUsage | null => {
  const usage = payload.usage;
  if (!usage || typeof usage !== "object") return null;
  const usageRecord = usage as Record<string, unknown>;
  const inputTokens = toNumber(usageRecord.input_tokens);
  const cacheCreationTokens = toNumber(usageRecord.cache_creation_input_tokens) ?? 0;
  const cacheReadTokens = toNumber(usageRecord.cache_read_input_tokens) ?? 0;
  const outputTokens = toNumber(usageRecord.output_tokens);
  if (inputTokens === null && outputTokens === null) return null;
  const promptTokens =
    inputTokens !== null ? inputTokens + cacheCreationTokens + cacheReadTokens : null;
  const completionTokens = outputTokens;
  const totalTokens =
    typeof promptTokens === "number" && typeof completionTokens === "number"
      ? promptTokens + completionTokens
      : null;
  return { promptTokens, completionTokens, totalTokens };
};

const parseGeminiUsage = (payload: Record<string, unknown>): LlmTokenUsage | null => {
  const stats = payload.stats;
  if (!stats || typeof stats !== "object") return null;
  const models = (stats as Record<string, unknown>).models;
  if (!models || typeof models !== "object") return null;
  let promptSum = 0;
  let completionSum = 0;
  let totalSum = 0;
  let hasPrompt = false;
  let hasCompletion = false;
  let hasTotal = false;
  for (const entry of Object.values(models as Record<string, unknown>)) {
    if (!entry || typeof entry !== "object") continue;
    const tokens = (entry as Record<string, unknown>).tokens;
    if (!tokens || typeof tokens !== "object") continue;
    const prompt = toNumber((tokens as Record<string, unknown>).prompt);
    const candidates = toNumber((tokens as Record<string, unknown>).candidates);
    const total = toNumber((tokens as Record<string, unknown>).total);
    if (typeof prompt === "number") {
      promptSum += prompt;
      hasPrompt = true;
    }
    if (typeof candidates === "number") {
      completionSum += candidates;
      hasCompletion = true;
    }
    if (typeof total === "number") {
      totalSum += total;
      hasTotal = true;
    }
  }
  if (!hasPrompt && !hasCompletion && !hasTotal) return null;
  const promptTokens = hasPrompt ? promptSum : null;
  const completionTokens = hasCompletion ? completionSum : null;
  const totalTokens =
    hasTotal && totalSum > 0
      ? totalSum
      : typeof promptTokens === "number" && typeof completionTokens === "number"
        ? promptTokens + completionTokens
        : null;
  return { promptTokens, completionTokens, totalTokens };
};

export const parseCodexUsageFromJsonl = (
  output: string,
): { usage: LlmTokenUsage | null; costUsd: number | null } => {
  const lines = output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  let usage: LlmTokenUsage | null = null;
  let costUsd: number | null = null;
  for (const line of lines) {
    if (!line.startsWith("{")) continue;
    try {
      const parsed = JSON.parse(line) as Record<string, unknown>;
      const candidates = [
        parsed.usage,
        (parsed.response as Record<string, unknown> | undefined)?.usage,
        (parsed.metrics as Record<string, unknown> | undefined)?.usage,
      ].filter(Boolean) as Record<string, unknown>[];
      for (const candidate of candidates) {
        const input =
          toNumber(candidate.input_tokens) ??
          toNumber(candidate.prompt_tokens) ??
          toNumber(candidate.inputTokens) ??
          null;
        const outputTokens =
          toNumber(candidate.output_tokens) ??
          toNumber(candidate.completion_tokens) ??
          toNumber(candidate.outputTokens) ??
          null;
        const totalTokens =
          toNumber(candidate.total_tokens) ??
          toNumber(candidate.totalTokens) ??
          (typeof input === "number" && typeof outputTokens === "number"
            ? input + outputTokens
            : null);
        if (input !== null || outputTokens !== null || totalTokens !== null) {
          usage = { promptTokens: input, completionTokens: outputTokens, totalTokens };
        }
      }
      if (costUsd === null) {
        const costValue =
          toNumber(parsed.cost_usd) ??
          toNumber((parsed.usage as Record<string, unknown> | undefined)?.cost_usd) ??
          null;
        if (typeof costValue === "number") costUsd = costValue;
      }
    } catch {
      // ignore malformed JSON lines
    }
  }
  return { usage, costUsd };
};

function extractJsonResultText(payload: Record<string, unknown>): string | null {
  for (const key of JSON_RESULT_FIELDS) {
    const value = payload[key];
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }
  }
  return null;
}

function parseJsonProviderUsage(
  provider: JsonCliProvider,
  payload: Record<string, unknown>,
): LlmTokenUsage | null {
  if (provider === "claude") return parseClaudeUsage(payload);
  if (provider === "gemini") return parseGeminiUsage(payload);
  return null;
}

function parseJsonProviderCostUsd(
  provider: JsonCliProvider,
  payload: Record<string, unknown>,
): number | null {
  if (provider !== "claude") return null;
  return toNumber(payload.total_cost_usd) ?? null;
}

export function parseJsonProviderOutput(args: { provider: JsonCliProvider; stdout: string }): {
  text: string;
  usage: LlmTokenUsage | null;
  costUsd: number | null;
} {
  const trimmed = args.stdout.trim();
  if (!trimmed) {
    throw new Error("CLI returned empty output");
  }
  const parsed = parseJsonFromOutput(trimmed);
  if (parsed && typeof parsed === "object") {
    const payload = Array.isArray(parsed)
      ? ((parsed.find(
          (item) =>
            item && typeof item === "object" && (item as Record<string, unknown>).type === "result",
        ) as Record<string, unknown> | undefined) ?? null)
      : (parsed as Record<string, unknown>);
    if (payload) {
      const resultText = extractJsonResultText(payload);
      if (resultText) {
        return {
          text: resultText,
          usage: parseJsonProviderUsage(args.provider, payload),
          costUsd: parseJsonProviderCostUsd(args.provider, payload),
        };
      }
    }
  }
  return { text: trimmed, usage: null, costUsd: null };
}
