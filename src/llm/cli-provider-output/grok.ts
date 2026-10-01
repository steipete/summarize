import type { LlmTokenUsage } from "../generate-text.js";
import { toNumber } from "./shared.js";

function extractJsonObject(output: string): Record<string, unknown> | null {
  const start = output.indexOf("{");
  const end = output.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  const tryParse = (slice: string): Record<string, unknown> | null => {
    try {
      const parsed: unknown = JSON.parse(slice);
      return parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : null;
    } catch {
      return null;
    }
  };
  const whole = tryParse(output.slice(start, end + 1));
  if (whole) return whole;
  // Grok can print diagnostics containing braces before the result object, which
  // always arrives last; retry from the final line that opens one.
  const lastStart = output.lastIndexOf("\n{");
  if (lastStart < 0) return null;
  return tryParse(output.slice(lastStart + 1, end + 1));
}

function parseGrokUsage(usage: unknown): LlmTokenUsage | null {
  if (!usage || typeof usage !== "object") return null;
  const record = usage as Record<string, unknown>;
  const inputTokens = toNumber(record.input_tokens);
  const cacheCreationTokens = toNumber(record.cache_creation_input_tokens) ?? 0;
  const cacheReadTokens = toNumber(record.cache_read_input_tokens) ?? 0;
  const completionTokens = toNumber(record.output_tokens);
  const reportedTotal = toNumber(record.total_tokens);
  if (inputTokens === null && completionTokens === null && reportedTotal === null) return null;
  const promptTokens =
    inputTokens !== null ? inputTokens + cacheCreationTokens + cacheReadTokens : null;
  const totalTokens =
    reportedTotal !== null && reportedTotal > 0
      ? reportedTotal
      : typeof promptTokens === "number" && typeof completionTokens === "number"
        ? promptTokens + completionTokens
        : null;
  return { promptTokens, completionTokens, totalTokens };
}

function extractGrokErrorMessage(payload: Record<string, unknown>): string | null {
  const keys =
    payload.type === "error" ? ["error", "errorMessage", "message"] : ["error", "errorMessage"];
  for (const key of keys) {
    const value = payload[key];
    if (typeof value === "string" && value.trim().length > 0) return value.trim();
    if (value && typeof value === "object") {
      const nested = (value as Record<string, unknown>).message;
      if (typeof nested === "string" && nested.trim().length > 0) return nested.trim();
    }
  }
  return null;
}

export function extractGrokError(output: string): string | null {
  const payload = extractJsonObject(output.trim());
  if (!payload) return null;
  if (
    payload.type === "error" ||
    payload.error !== undefined ||
    payload.errorMessage !== undefined
  ) {
    return extractGrokErrorMessage(payload) ?? "Grok CLI returned an error";
  }
  return null;
}

export function parseGrokOutput(stdout: string): {
  text: string;
  usage: LlmTokenUsage | null;
  costUsd: number | null;
} {
  const trimmed = stdout.trim();
  if (!trimmed) throw new Error("CLI returned empty output");
  const payload = extractJsonObject(trimmed);
  if (payload) {
    const text = typeof payload.text === "string" ? payload.text.trim() : "";
    if (text) {
      return {
        text,
        usage: parseGrokUsage(payload.usage),
        costUsd: toNumber(payload.total_cost_usd),
      };
    }
    const errorMessage = extractGrokErrorMessage(payload);
    if (payload.type === "error" || errorMessage) {
      throw new Error(errorMessage ?? "Grok CLI returned an error");
    }
    throw new Error("CLI returned empty output");
  }
  return { text: trimmed, usage: null, costUsd: null };
}
