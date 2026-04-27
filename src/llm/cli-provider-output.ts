import type { CliProvider } from "../config.js";
import type { LlmTokenUsage } from "./generate-text.js";

export type JsonCliProvider = Exclude<CliProvider, "codex" | "openclaw" | "opencode" | "copilot">;

const JSON_RESULT_FIELDS = ["result", "response", "output", "message", "text"] as const;

export function isJsonCliProvider(provider: CliProvider): provider is JsonCliProvider {
  return (
    provider !== "codex" &&
    provider !== "openclaw" &&
    provider !== "opencode" &&
    provider !== "copilot"
  );
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

const sumNullable = (current: number | null, next: number | null): number | null => {
  if (typeof next !== "number") return current;
  if (typeof current !== "number") return next;
  return current + next;
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

function extractCodexTextFromContentBlocks(blocks: unknown): string | null {
  if (!Array.isArray(blocks)) return null;
  const text = blocks
    .flatMap((block) => {
      if (!block || typeof block !== "object") return [];
      const record = block as Record<string, unknown>;
      if (typeof record.text === "string" && record.text.trim().length > 0) {
        return [record.text];
      }
      const nested = record.content;
      if (!Array.isArray(nested)) return [];
      return nested
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
    const responseRecord = response as Record<string, unknown>;
    if (
      typeof responseRecord.output_text === "string" &&
      responseRecord.output_text.trim().length > 0
    ) {
      return { deltaText: null, fullText: responseRecord.output_text.trim() };
    }
    const responseOutput = extractCodexTextFromContentBlocks(responseRecord.output);
    if (responseOutput) {
      return { deltaText: null, fullText: responseOutput };
    }
  }

  const message = parsed.message;
  if (message && typeof message === "object") {
    const messageOutput = extractCodexTextFromContentBlocks([message as Record<string, unknown>]);
    if (messageOutput) {
      return { deltaText: null, fullText: messageOutput };
    }
  }

  const item = parsed.item;
  if (item && typeof item === "object") {
    const itemOutput = extractCodexTextFromContentBlocks([item as Record<string, unknown>]);
    if (itemOutput) {
      return { deltaText: null, fullText: itemOutput };
    }
  }

  return { deltaText: null, fullText: null };
}

export function parseCodexOutputFromJsonl(output: string): {
  text: string | null;
  sawStructuredEvent: boolean;
} {
  const trimmed = output.trim();
  if (!trimmed) {
    return { text: null, sawStructuredEvent: false };
  }

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
      const { deltaText, fullText: eventFullText } = extractCodexTextEvent(parsed);
      if (typeof deltaText === "string" && deltaText.length > 0) {
        deltaParts.push(deltaText);
        continue;
      }
      if (!fullText && typeof eventFullText === "string" && eventFullText.length > 0) {
        fullText = eventFullText;
      }
    } catch {
      // ignore malformed JSON lines
    }
  }

  const deltaText = deltaParts.join("").trim();
  if (deltaText) return { text: deltaText, sawStructuredEvent };
  if (fullText) return { text: fullText, sawStructuredEvent };
  return { text: null, sawStructuredEvent };
}

function parseOpenCodeTokens(payload: Record<string, unknown>): LlmTokenUsage | null {
  const tokens = payload.tokens;
  if (!tokens || typeof tokens !== "object") return null;
  const record = tokens as Record<string, unknown>;
  const promptTokens = toNumber(record.input);
  const completionTokens = toNumber(record.output);
  const totalTokens =
    toNumber(record.total) ??
    (typeof promptTokens === "number" && typeof completionTokens === "number"
      ? promptTokens + completionTokens
      : null);
  if (promptTokens === null && completionTokens === null && totalTokens === null) return null;
  return { promptTokens, completionTokens, totalTokens };
}

function extractOpenCodeErrorMessage(payload: Record<string, unknown>): string | null {
  const error = payload.error;
  if (!error) return null;
  if (typeof error === "string" && error.trim().length > 0) return error.trim();
  if (typeof error !== "object") return null;
  const errorRecord = error as Record<string, unknown>;
  const data = errorRecord.data;
  if (data && typeof data === "object") {
    const message = (data as Record<string, unknown>).message;
    if (typeof message === "string" && message.trim().length > 0) return message.trim();
  }
  const message = errorRecord.message;
  if (typeof message === "string" && message.trim().length > 0) return message.trim();
  const name = errorRecord.name;
  return typeof name === "string" && name.trim().length > 0 ? name.trim() : null;
}

export function parseOpenCodeOutputFromJsonl(output: string): {
  text: string;
  usage: LlmTokenUsage | null;
  costUsd: number | null;
} {
  const trimmed = output.trim();
  if (!trimmed) {
    throw new Error("CLI returned empty output");
  }

  const lines = trimmed
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  const textParts: string[] = [];
  const errorMessages: string[] = [];
  let promptTokens: number | null = null;
  let completionTokens: number | null = null;
  let totalTokens: number | null = null;
  let costUsd: number | null = null;
  let sawStructuredEvent = false;

  for (const line of lines) {
    if (!line.startsWith("{")) continue;
    try {
      const parsed = JSON.parse(line) as Record<string, unknown>;
      sawStructuredEvent = true;

      if (parsed.type === "text") {
        const part = parsed.part;
        if (part && typeof part === "object") {
          const text = (part as Record<string, unknown>).text;
          if (typeof text === "string" && text.length > 0) {
            textParts.push(text);
          }
        }
        continue;
      }

      if (parsed.type === "step_finish") {
        const part = parsed.part;
        if (!part || typeof part !== "object") continue;
        const usage = parseOpenCodeTokens(part as Record<string, unknown>);
        if (usage) {
          promptTokens = sumNullable(promptTokens, usage.promptTokens);
          completionTokens = sumNullable(completionTokens, usage.completionTokens);
          totalTokens = sumNullable(totalTokens, usage.totalTokens);
        }
        const cost = toNumber((part as Record<string, unknown>).cost);
        if (typeof cost === "number") {
          costUsd = typeof costUsd === "number" ? costUsd + cost : cost;
        }
        continue;
      }

      if (parsed.type === "error") {
        const message = extractOpenCodeErrorMessage(parsed);
        if (message) errorMessages.push(message);
      }
    } catch {
      // ignore malformed JSON lines
    }
  }

  const text = textParts.join("").trim();
  const usage =
    promptTokens !== null || completionTokens !== null || totalTokens !== null
      ? { promptTokens, completionTokens, totalTokens }
      : null;
  if (text) {
    return { text, usage, costUsd };
  }
  if (errorMessages.length > 0) {
    throw new Error(errorMessages.join("\n"));
  }
  if (sawStructuredEvent) {
    throw new Error("CLI returned empty output");
  }
  return { text: trimmed, usage: null, costUsd: null };
}

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
