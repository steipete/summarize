import type { LlmTokenUsage } from "../generate-text.js";
import { toNumber } from "./shared.js";

type AtifStep = {
  source?: unknown;
  message?: unknown;
};

function parseDevinUsage(metrics: unknown): LlmTokenUsage | null {
  if (!metrics || typeof metrics !== "object") return null;
  const record = metrics as Record<string, unknown>;
  // total_prompt_tokens is inclusive of the cached-prefix tokens reported
  // separately in total_cached_tokens (verified against ATIF-v1.7 exports).
  const promptTokens = toNumber(record.total_prompt_tokens);
  const completionTokens = toNumber(record.total_completion_tokens);
  if (promptTokens === null && completionTokens === null) return null;
  const totalTokens =
    typeof promptTokens === "number" && typeof completionTokens === "number"
      ? promptTokens + completionTokens
      : null;
  return { promptTokens, completionTokens, totalTokens };
}

/**
 * Parse a Devin CLI `--export` ATIF transcript.
 *
 * Devin print mode writes plain text to stdout, but a fresh-state run can
 * prefix onboarding noise, so the transcript is the reliable output channel:
 * the final agent step carries the response text and `final_metrics` carries
 * cumulative token usage. Devin does not report a USD cost.
 */
export function parseDevinOutputFromAtif(raw: string): {
  text: string;
  usage: LlmTokenUsage | null;
  costUsd: number | null;
} {
  const parsed = JSON.parse(raw) as unknown;
  if (!parsed || typeof parsed !== "object") {
    return { text: "", usage: null, costUsd: null };
  }
  const steps = (parsed as { steps?: unknown }).steps;
  let text = "";
  if (Array.isArray(steps)) {
    for (const step of steps as AtifStep[]) {
      if (step?.source !== "agent") continue;
      // ATIF v1.6+ also permits message: ContentPart[] — join text parts.
      if (typeof step.message === "string" && step.message.trim().length > 0) {
        text = step.message.trim();
      } else if (Array.isArray(step.message)) {
        const joined = step.message
          .map((part) => {
            if (!part || typeof part !== "object") return "";
            const candidate = (part as { text?: unknown }).text;
            return typeof candidate === "string" ? candidate : "";
          })
          .join("")
          .trim();
        if (joined) text = joined;
      }
    }
  }
  return {
    text,
    usage: parseDevinUsage((parsed as { final_metrics?: unknown }).final_metrics),
    costUsd: null,
  };
}
