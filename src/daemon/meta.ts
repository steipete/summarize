import type { InputSummaryArgs } from "@steipete/summarize-core/localization/presentation";
import {
  formatCompactCount,
  formatDurationSecondsSmart,
  formatMinutesSmart,
} from "../tty/format.js";
export type { InputSummaryArgs } from "@steipete/summarize-core/localization/presentation";
export { buildInputSummaryMessage } from "@steipete/summarize-core/localization/presentation";

export function estimateDurationSecondsFromWords(words: number, { minSeconds = 60 } = {}): number {
  const safe = typeof words === "number" && Number.isFinite(words) ? words : 0;
  if (safe <= 0) return minSeconds;
  return Math.max(minSeconds, (safe / 160) * 60);
}

export function countWords(text: string): number {
  const trimmed = text.trim();
  if (!trimmed) return 0;
  return trimmed.split(/\s+/).length;
}

/** Legacy daemon wire text stays stable; current UIs render inputSummaryMessage instead. */
export function formatInputSummary({
  kindLabel,
  durationSeconds,
  words,
  characters,
  isDurationApproximate,
}: InputSummaryArgs): string | null {
  const parts: string[] = [];

  if (kindLabel) {
    if (durationSeconds != null && durationSeconds > 0) {
      const duration = isDurationApproximate
        ? formatMinutesSmart(durationSeconds / 60)
        : formatDurationSecondsSmart(durationSeconds);
      parts.push(`${duration} ${kindLabel}`);
    } else {
      parts.push(kindLabel);
    }
  }

  if (typeof words === "number" && Number.isFinite(words) && words > 0) {
    parts.push(`${formatCompactCount(words)} words`);
  }
  if (typeof characters === "number" && Number.isFinite(characters) && characters > 0) {
    parts.push(`${formatCompactCount(characters)} chars`);
  }

  return parts.length > 0 ? parts.join(" · ") : null;
}
