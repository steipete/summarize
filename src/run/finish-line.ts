import {
  type CliLocale,
  type CliMessage,
  createCliTranslator,
  resolveCliLocaleFromEnv,
} from "../locale.js";
import {
  formatCompactCount,
  formatElapsedMs,
  formatDurationSecondsSmart,
  formatMinutesSmart,
} from "../tty/format.js";
import {
  createThemeRenderer,
  resolveThemeNameFromSources,
  resolveTrueColor,
} from "../tty/theme.js";
import type { FinishLabel, FinishPart } from "./finish-line-types.js";
import { formatUSD, sumNumbersOrNull } from "./format.js";
export {
  buildExtractFinishLabel,
  buildSummaryFinishLabel,
  type ExtractDiagnosticsForFinishLine,
} from "./finish-line-labels.js";
export { buildLengthPartsForFinishLine, type ExtractedForLengths } from "./finish-line-lengths.js";

export type FinishLineText = { line: string; details: string | null };
export type FinishLineModel = { lineParts: string[]; detailParts: string[] };
type FinishLineOptions = {
  elapsedMs: number;
  elapsedLabel?: string | CliMessage | null;
  label?: FinishLabel | null;
  model: string | null;
  report: {
    llm: Array<{
      promptTokens: number | null;
      completionTokens: number | null;
      totalTokens: number | null;
      calls: number;
    }>;
    services: { firecrawl: { requests: number }; apify: { requests: number } };
  };
  costUsd: number | null;
  extraParts?: FinishPart[] | null;
  locale?: CliLocale;
};

export function formatModelLabelForDisplay(model: string): string {
  const trimmed = model.trim();
  const parts = trimmed.split("/").filter(Boolean);
  return parts.length >= 3 && parts[0] === "openai"
    ? `${parts[1]}/${parts.slice(2).join("/")}`
    : trimmed;
}

export function writeFinishLine(
  options: FinishLineOptions & {
    stderr: NodeJS.WritableStream;
    detailed: boolean;
    color: boolean;
    env?: Record<string, string | undefined>;
  },
): void {
  const { stderr, detailed, env, color } = options;
  const locale = resolveCliLocaleFromEnv(env ?? {});
  const theme =
    env && color
      ? createThemeRenderer({
          themeName: resolveThemeNameFromSources({ env: env.SUMMARIZE_THEME }),
          enabled: color,
          trueColor: resolveTrueColor(env),
        })
      : null;
  const text = buildFinishLineText({ ...options, locale });
  stderr.write(`\n${theme ? theme.success(text.line) : text.line}\n`);
  if (detailed && text.details) stderr.write(`${theme ? theme.dim(text.details) : text.details}\n`);
}

export function buildFinishLineText(
  options: FinishLineOptions & { detailed: boolean },
): FinishLineText {
  return formatFinishLineText(buildFinishLineModel(options), options.detailed);
}

export function buildFinishLineVariants({
  compactExtraParts,
  detailedExtraParts,
  ...options
}: Omit<FinishLineOptions, "extraParts"> & {
  compactExtraParts?: FinishPart[] | null;
  detailedExtraParts?: FinishPart[] | null;
}): { compact: FinishLineText; detailed: FinishLineText } {
  return {
    compact: buildFinishLineText({
      ...options,
      detailed: false,
      extraParts: compactExtraParts ?? detailedExtraParts ?? null,
    }),
    detailed: buildFinishLineText({
      ...options,
      detailed: true,
      extraParts: detailedExtraParts ?? compactExtraParts ?? null,
    }),
  };
}

export function formatFinishLineText(model: FinishLineModel, detailed: boolean): FinishLineText {
  return {
    line: model.lineParts.join(" · "),
    details: detailed && model.detailParts.length ? model.detailParts.join(" | ") : null,
  };
}

export function buildFinishLineModel({
  elapsedMs,
  elapsedLabel,
  label,
  model,
  report,
  costUsd,
  extraParts,
  locale = "en",
}: FinishLineOptions): FinishLineModel {
  const t = createCliTranslator(locale);
  const compact = extraParts?.find(
    (part): part is Extract<FinishPart, { kind: "compactTranscript" }> =>
      typeof part !== "string" && part.kind === "compactTranscript",
  );
  const count = (value: number | null) =>
    value === null ? t("finish.unknown") : formatCompactCount(value, locale);
  const compactText = compact
    ? t("finish.compactTranscript", {
        duration: compact.approximate
          ? formatMinutesSmart(compact.durationSeconds / 60, locale)
          : formatDurationSecondsSmart(compact.durationSeconds, locale),
        media: compact.media,
        words: compact.words,
        count: count(compact.words),
      })
    : null;
  let sourceLabel: string | null = null;
  if (typeof label === "string") {
    sourceLabel =
      compact?.media === "podcast" ||
      (compact?.media === "YouTube" && label.toLowerCase() === "youtube")
        ? null
        : label;
  } else if (label && "key" in label) {
    sourceLabel = t(label.key, label.values);
  } else if (label?.kind === "extract") {
    sourceLabel = t("finish.extracted", {
      format: label.format,
      source: label.via ?? "",
      hasSource: Boolean(label.via),
    });
  } else if (label?.kind === "summary") {
    const hasWords = !compact && label.words > 0;
    if (hasWords || label.sources.length)
      sourceLabel = t("finish.summary", {
        words: label.words,
        count: count(label.words),
        hasWords,
        source: label.sources.join("+"),
        hasSource: label.sources.length > 0,
      });
  }
  const prompt = sumNumbersOrNull(report.llm.map((row) => row.promptTokens));
  const completion = sumNumbersOrNull(report.llm.map((row) => row.completionTokens));
  const total = sumNumbersOrNull(report.llm.map((row) => row.totalTokens));
  const tokens =
    prompt !== null || completion !== null || total !== null
      ? `↑${count(prompt)} ↓${count(completion)} Δ${count(total)}`
      : null;
  const lineParts = [
    typeof elapsedLabel === "object" && elapsedLabel
      ? t(elapsedLabel.key, elapsedLabel.values)
      : elapsedLabel?.trim()
        ? elapsedLabel
        : formatElapsedMs(elapsedMs, locale),
    compactText,
    costUsd !== null ? formatUSD(costUsd, locale) : null,
    sourceLabel,
    model ? formatModelLabelForDisplay(model) : null,
    tokens,
  ].filter((part): part is string => part !== null);
  const lengths: string[] = [];
  const misc: string[] = [];
  for (const part of extraParts ?? []) {
    if (typeof part === "string") misc.push(part);
    else if (part.kind === "length")
      lengths.push(
        t(part.key, {
          ...part.values,
          duration:
            typeof part.values.durationSeconds === "number"
              ? part.values.approximate
                ? formatMinutesSmart(part.values.durationSeconds / 60, locale)
                : formatDurationSecondsSmart(part.values.durationSeconds, locale)
              : "",
        }),
      );
    else if (part.kind === "detail") misc.push(t(part.key, part.values));
  }
  const detailParts: string[] = [];
  if (lengths.length) detailParts.push(t("finish.lengths", { lengths: lengths.join(" ") }));
  const calls = report.llm.reduce((sum, row) => sum + row.calls, 0);
  if (calls > 1) detailParts.push(t("finish.calls", { count: count(calls) }));
  const services: string[] = [];
  if (report.services.firecrawl.requests > 0)
    services.push(`firecrawl=${count(report.services.firecrawl.requests)}`);
  if (report.services.apify.requests > 0)
    services.push(`apify=${count(report.services.apify.requests)}`);
  if (services.length) detailParts.push(t("finish.services", { services: services.join(" ") }));
  return { lineParts, detailParts: [...detailParts, ...misc] };
}
