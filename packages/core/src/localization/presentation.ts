import { sharedMessage, type SharedMessage } from "./messages.js";

export type MetricPart =
  | { kind: "message"; message: SharedMessage }
  | {
      kind: "text";
      text: string;
      href?: string;
      model?: boolean;
    };

/** Semantic items keep localization, source links, and model shortening independent. */
export function buildMetricParts(args: {
  elapsedMs: number;
  cached: boolean;
  costUsd: number | null;
  source: string | null;
  sourceUrl: string;
  model: string | null;
  promptTokens: number | null;
  completionTokens: number | null;
  totalTokens: number | null;
}): MetricPart[] {
  const parts: MetricPart[] = [
    {
      kind: "message",
      message: args.cached
        ? sharedMessage("finish.cached")
        : sharedMessage("metrics.elapsed", { seconds: Math.max(0, args.elapsedMs) / 1000 }),
    },
  ];
  if (args.costUsd !== null)
    parts.push({
      kind: "message",
      message: sharedMessage("metrics.cost", { cost: args.costUsd }),
    });
  if (args.source) parts.push({ kind: "text", text: args.source, href: args.sourceUrl });
  if (args.model) parts.push({ kind: "text", text: args.model, model: true });
  if (args.promptTokens !== null || args.completionTokens !== null || args.totalTokens !== null) {
    parts.push({
      kind: "message",
      message: sharedMessage("metrics.tokens", {
        prompt: args.promptTokens ?? 0,
        hasPrompt: args.promptTokens !== null,
        completion: args.completionTokens ?? 0,
        hasCompletion: args.completionTokens !== null,
        total: args.totalTokens ?? 0,
        hasTotal: args.totalTokens !== null,
      }),
    });
  }
  return parts;
}

export type InputSummaryArgs = {
  kindLabel: string | null;
  durationSeconds: number | null;
  words: number | null;
  characters: number | null;
  isDurationApproximate?: boolean;
};

/** Keep the wire payload numeric so every UI can format it in its own locale. */
export function buildInputSummaryMessage(args: InputSummaryArgs) {
  const hasKind = Boolean(args.kindLabel);
  const hasDuration =
    hasKind &&
    args.durationSeconds !== null &&
    Number.isFinite(args.durationSeconds) &&
    args.durationSeconds > 0;
  const hasWords = args.words !== null && Number.isFinite(args.words) && args.words > 0;
  const hasChars =
    args.characters !== null && Number.isFinite(args.characters) && args.characters > 0;
  if (!hasKind && !hasWords && !hasChars) return null;
  const total = hasDuration ? Math.max(0, Math.round(args.durationSeconds!)) : 0;
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  const estimate = hasDuration ? args.durationSeconds! / 60 : 0;
  const estimatedMinutes = estimate >= 10 ? Math.round(estimate) : Math.round(estimate * 10) / 10;
  const kindLabel = args.kindLabel ?? "";
  const kind = ["youtube", "podcast", "video", "audio"].includes(kindLabel.toLowerCase())
    ? kindLabel.toLowerCase()
    : "other";
  return sharedMessage("input.summary", {
    kind,
    kindLabel,
    hasKind,
    hasDuration,
    approximate: Boolean(args.isDurationApproximate),
    estimatedMinutes,
    hours,
    minutes,
    seconds,
    hasHours: hours > 0,
    hasMinutes: minutes > 0 || hours > 0,
    hasSeconds: seconds > 0 || (hours === 0 && minutes === 0),
    hasWords,
    words: hasWords ? args.words! : 0,
    hasChars,
    chars: hasChars ? args.characters! : 0,
    wordSeparator: hasKind && hasWords,
    charSeparator: hasChars && (hasKind || hasWords),
  });
}
