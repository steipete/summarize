export { sumNumbersOrNull } from "../shared/numbers.js";
export { resolveTargetCharacters } from "../shared/summary-length.js";

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
