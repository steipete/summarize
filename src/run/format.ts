import type { SummaryLength } from "@steipete/summarize-core";

export function formatOptionalString(value: string | null | undefined): string {
  if (typeof value === "string" && value.trim().length > 0) {
    return value.trim();
  }
  return "none";
}

export function formatOptionalNumber(value: number | null | undefined): string {
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }
  return "none";
}

export function sumNumbersOrNull(values: Array<number | null>): number | null {
  let sum = 0;
  let any = false;
  for (const value of values) {
    if (typeof value === "number" && Number.isFinite(value)) {
      sum += value;
      any = true;
    }
  }
  return any ? sum : null;
}

export function formatUSD(value: number): string {
  if (!Number.isFinite(value)) return "n/a";
  return `$${value.toFixed(4)}`;
}

export function estimateWhisperTranscriptionCostUsd({
  transcriptionProvider,
  transcriptSource,
  mediaDurationSeconds,
  openaiWhisperUsdPerMinute,
}: {
  transcriptionProvider: string | null;
  transcriptSource: string | null;
  mediaDurationSeconds: number | null;
  openaiWhisperUsdPerMinute: number;
}): number | null {
  if (transcriptSource !== "whisper") return null;
  if (!transcriptionProvider || transcriptionProvider.toLowerCase() !== "openai") return null;
  if (
    typeof mediaDurationSeconds !== "number" ||
    !Number.isFinite(mediaDurationSeconds) ||
    mediaDurationSeconds <= 0
  ) {
    return null;
  }
  const perSecond = openaiWhisperUsdPerMinute / 60;
  const cost = mediaDurationSeconds * perSecond;
  return Number.isFinite(cost) && cost > 0 ? cost : null;
}

export function resolveTargetCharacters(
  lengthArg:
    | {
        kind: "preset";
        preset: SummaryLength;
      }
    | { kind: "chars"; maxCharacters: number },
  maxMap: Record<SummaryLength, number>,
): number {
  return lengthArg.kind === "chars" ? lengthArg.maxCharacters : maxMap[lengthArg.preset];
}
