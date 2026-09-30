import type { CliProvider } from "../config.js";
import { toNumber } from "./cli-provider-output/shared.js";
import type { LlmTokenUsage } from "./generate-text.js";

export {
  parseCodexOutputFromJsonl,
  parseCodexUsageFromJsonl,
} from "./cli-provider-output/codex.js";
export { parseOpenCodeOutputFromJsonl } from "./cli-provider-output/opencode.js";
export { parsePiOutputFromJsonl } from "./cli-provider-output/pi.js";
export { parseDevinOutputFromAtif } from "./cli-provider-output/devin.js";

export type JsonCliProvider = Exclude<
  CliProvider,
  "codex" | "openclaw" | "opencode" | "copilot" | "agy" | "pi" | "devin"
>;

const JSON_RESULT_FIELDS = ["result", "response", "output", "message", "text"] as const;

export function isJsonCliProvider(provider: CliProvider): provider is JsonCliProvider {
  return !["codex", "openclaw", "opencode", "copilot", "agy", "pi", "devin"].includes(provider);
}

function parseJsonFromOutput(output: string): unknown | null {
  const trimmed = output.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      return JSON.parse(trimmed) as unknown;
    } catch {
      // Try the final JSON object after CLI diagnostics.
    }
  }
  const lastBraceIndex = trimmed.lastIndexOf("\n{");
  if (lastBraceIndex < 0) return null;
  try {
    return JSON.parse(trimmed.slice(lastBraceIndex + 1).trim()) as unknown;
  } catch {
    return null;
  }
}

function parseClaudeUsage(payload: Record<string, unknown>): LlmTokenUsage | null {
  const usage = payload.usage;
  if (!usage || typeof usage !== "object") return null;
  const record = usage as Record<string, unknown>;
  const inputTokens = toNumber(record.input_tokens);
  const cacheCreationTokens = toNumber(record.cache_creation_input_tokens) ?? 0;
  const cacheReadTokens = toNumber(record.cache_read_input_tokens) ?? 0;
  const completionTokens = toNumber(record.output_tokens);
  if (inputTokens === null && completionTokens === null) return null;
  const promptTokens =
    inputTokens !== null ? inputTokens + cacheCreationTokens + cacheReadTokens : null;
  const totalTokens =
    typeof promptTokens === "number" && typeof completionTokens === "number"
      ? promptTokens + completionTokens
      : null;
  return { promptTokens, completionTokens, totalTokens };
}

function parseGeminiUsage(payload: Record<string, unknown>): LlmTokenUsage | null {
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
    const record = tokens as Record<string, unknown>;
    const prompt = toNumber(record.prompt);
    const candidates = toNumber(record.candidates);
    const total = toNumber(record.total);
    if (prompt !== null) {
      promptSum += prompt;
      hasPrompt = true;
    }
    if (candidates !== null) {
      completionSum += candidates;
      hasCompletion = true;
    }
    if (total !== null) {
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
}

function extractJsonResultText(payload: Record<string, unknown>): string | null {
  for (const key of JSON_RESULT_FIELDS) {
    const value = payload[key];
    if (typeof value === "string" && value.trim().length > 0) return value.trim();
  }
  return null;
}

export function parseJsonProviderOutput(args: { provider: JsonCliProvider; stdout: string }): {
  text: string;
  usage: LlmTokenUsage | null;
  costUsd: number | null;
} {
  const trimmed = args.stdout.trim();
  if (!trimmed) throw new Error("CLI returned empty output");
  const parsed = parseJsonFromOutput(trimmed);
  if (parsed && typeof parsed === "object") {
    const payload = Array.isArray(parsed)
      ? ((parsed.find(
          (item) =>
            item && typeof item === "object" && (item as Record<string, unknown>).type === "result",
        ) as Record<string, unknown> | undefined) ?? null)
      : (parsed as Record<string, unknown>);
    if (payload) {
      const text = extractJsonResultText(payload);
      if (text) {
        return {
          text,
          usage:
            args.provider === "claude"
              ? parseClaudeUsage(payload)
              : args.provider === "gemini"
                ? parseGeminiUsage(payload)
                : null,
          costUsd: args.provider === "claude" ? toNumber(payload.total_cost_usd) : null,
        };
      }
    }
  }
  return { text: trimmed, usage: null, costUsd: null };
}
