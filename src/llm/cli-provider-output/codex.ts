import type { LlmTokenUsage } from "../generate-text.js";
import { toNumber } from "./shared.js";

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
      // Ignore malformed JSON lines.
    }
  }
  return { usage, costUsd };
};

function extractCodexTextFromContentBlocks(blocks: unknown): string | null {
  if (!Array.isArray(blocks)) return null;
  const text = blocks
    .flatMap((block) => {
      if (!block || typeof block !== "object") return [];
      const record = block as Record<string, unknown>;
      if (typeof record.text === "string" && record.text.trim().length > 0) return [record.text];
      if (!Array.isArray(record.content)) return [];
      return record.content
        .map((part) => {
          if (!part || typeof part !== "object") return "";
          const partRecord = part as Record<string, unknown>;
          return typeof partRecord.text === "string" ? partRecord.text : "";
        })
        .filter((part) => part.trim().length > 0);
    })
    .join("");
  return text.trim().length > 0 ? text.trim() : null;
}

function extractCodexTextEvent(parsed: Record<string, unknown>): {
  deltaText: string | null;
  fullText: string | null;
} {
  const type = typeof parsed.type === "string" ? parsed.type : "";
  if (type === "response.output_text.delta" && typeof parsed.delta === "string") {
    return { deltaText: parsed.delta, fullText: null };
  }
  if (type === "response.output_text.done") {
    const text =
      typeof parsed.text === "string"
        ? parsed.text
        : typeof parsed.delta === "string"
          ? parsed.delta
          : null;
    return { deltaText: null, fullText: text };
  }
  if (typeof parsed.output_text === "string" && parsed.output_text.trim().length > 0) {
    return { deltaText: null, fullText: parsed.output_text.trim() };
  }
  const response = parsed.response;
  if (response && typeof response === "object") {
    const record = response as Record<string, unknown>;
    if (typeof record.output_text === "string" && record.output_text.trim().length > 0) {
      return { deltaText: null, fullText: record.output_text.trim() };
    }
    const output = extractCodexTextFromContentBlocks(record.output);
    if (output) return { deltaText: null, fullText: output };
  }
  for (const key of ["message", "item"] as const) {
    const value = parsed[key];
    if (!value || typeof value !== "object") continue;
    const output = extractCodexTextFromContentBlocks([value as Record<string, unknown>]);
    if (output) return { deltaText: null, fullText: output };
  }
  return { deltaText: null, fullText: null };
}

export function parseCodexOutputFromJsonl(output: string): {
  text: string | null;
  sawStructuredEvent: boolean;
} {
  const trimmed = output.trim();
  if (!trimmed) return { text: null, sawStructuredEvent: false };
  const lines = trimmed
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const deltaParts: string[] = [];
  let fullText: string | null = null;
  let sawStructuredEvent = false;
  for (const line of lines) {
    if (!line.startsWith("{")) continue;
    try {
      const parsed = JSON.parse(line) as Record<string, unknown>;
      sawStructuredEvent = true;
      const event = extractCodexTextEvent(parsed);
      if (typeof event.deltaText === "string" && event.deltaText.length > 0) {
        deltaParts.push(event.deltaText);
      } else if (!fullText && typeof event.fullText === "string" && event.fullText.length > 0) {
        fullText = event.fullText;
      }
    } catch {
      // Ignore malformed JSON lines.
    }
  }
  const deltaText = deltaParts.join("").trim();
  return { text: deltaText || fullText, sawStructuredEvent };
}

// `turn.failed` carries Codex's terminal reason for a failed turn: the turn error,
// else the last critical stream error. Top-level `error` events can be transient
// retry notices and item-level errors are non-fatal, so neither is reported here.
export function extractCodexTurnFailureFromJsonl(output: string): string | null {
  let reason: string | null = null;
  for (const rawLine of output.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line.startsWith("{")) continue;
    try {
      const parsed = JSON.parse(line) as Record<string, unknown>;
      if (parsed.type !== "turn.failed") continue;
      const error = parsed.error as Record<string, unknown> | null | undefined;
      const message = typeof error?.message === "string" ? error.message.trim() : "";
      if (message) reason = message;
    } catch {
      // Ignore malformed JSON lines.
    }
  }
  return reason;
}
