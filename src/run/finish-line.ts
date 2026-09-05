import { formatCompactCount, formatElapsedMs } from "../tty/format.js";
import {
  createThemeRenderer,
  resolveThemeNameFromSources,
  resolveTrueColor,
} from "../tty/theme.js";
export {
  buildExtractFinishLabel,
  buildSummaryFinishLabel,
  type ExtractDiagnosticsForFinishLine,
} from "./finish-line-labels.js";
export { buildLengthPartsForFinishLine, type ExtractedForLengths } from "./finish-line-lengths.js";
import { resolveCliLocaleFromEnv, translateCliText } from "../locale.js";
import { formatUSD, sumNumbersOrNull } from "./format.js";

export type FinishLineText = {
  line: string;
  details: string | null;
};

export type FinishLineModel = {
  lineParts: string[];
  detailParts: string[];
};

export function formatModelLabelForDisplay(model: string): string {
  const trimmed = model.trim();
  if (!trimmed) return trimmed;

  // Tricky UX: OpenRouter models routed via the OpenAI-compatible API often appear as
  // `openai/<publisher>/<model>` in the "model" field, which reads like we're using OpenAI.
  // Collapse that to `<publisher>/<model>` for display.
  const parts = trimmed.split("/").filter(Boolean);
  if (parts.length >= 3 && parts[0] === "openai") {
    return `${parts[1]}/${parts.slice(2).join("/")}`;
  }

  return trimmed;
}

export function writeFinishLine({
  stderr,
  elapsedMs,
  elapsedLabel,
  label,
  model,
  report,
  costUsd,
  detailed,
  extraParts,
  color,
  env,
}: {
  stderr: NodeJS.WritableStream;
  elapsedMs: number;
  elapsedLabel?: string | null;
  label?: string | null;
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
  detailed: boolean;
  extraParts?: string[] | null;
  color: boolean;
  env?: Record<string, string | undefined>;
}): void {
  const theme =
    env && color
      ? createThemeRenderer({
          themeName: resolveThemeNameFromSources({ env: env.SUMMARIZE_THEME }),
          enabled: color,
          trueColor: resolveTrueColor(env),
        })
      : null;
  const { compact, detailed: detailedText } = buildFinishLineVariants({
    elapsedMs,
    elapsedLabel,
    label,
    model,
    report,
    costUsd,
    compactExtraParts: extraParts,
    detailedExtraParts: extraParts,
  });
  const text = detailed ? detailedText : compact;
  const locale = resolveCliLocaleFromEnv(env ?? {});

  stderr.write("\n");
  const protectedValues = model ? [formatModelLabelForDisplay(model)] : [];
  const line = translateCliText(text.line, locale, protectedValues);
  const details = text.details ? translateCliText(text.details, locale, protectedValues) : null;
  stderr.write(`${theme ? theme.success(line) : line}\n`);
  if (detailed && details) {
    stderr.write(`${theme ? theme.dim(details) : details}\n`);
  }
}

export function buildFinishLineText({
  elapsedMs,
  elapsedLabel,
  label,
  model,
  report,
  costUsd,
  detailed,
  extraParts,
}: {
  elapsedMs: number;
  elapsedLabel?: string | null;
  label?: string | null;
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
  detailed: boolean;
  extraParts?: string[] | null;
}): FinishLineText {
  const modelData = buildFinishLineModel({
    elapsedMs,
    elapsedLabel,
    label,
    model,
    report,
    costUsd,
    extraParts,
  });
  return formatFinishLineText(modelData, detailed);
}

export function buildFinishLineVariants({
  elapsedMs,
  elapsedLabel,
  label,
  model,
  report,
  costUsd,
  compactExtraParts,
  detailedExtraParts,
}: {
  elapsedMs: number;
  elapsedLabel?: string | null;
  label?: string | null;
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
  compactExtraParts?: string[] | null;
  detailedExtraParts?: string[] | null;
}): { compact: FinishLineText; detailed: FinishLineText } {
  const compact = buildFinishLineText({
    elapsedMs,
    elapsedLabel,
    label,
    model,
    report,
    costUsd,
    detailed: false,
    extraParts: compactExtraParts ?? detailedExtraParts ?? null,
  });
  const detailed = buildFinishLineText({
    elapsedMs,
    elapsedLabel,
    label,
    model,
    report,
    costUsd,
    detailed: true,
    extraParts: detailedExtraParts ?? compactExtraParts ?? null,
  });
  return { compact, detailed };
}

export function formatFinishLineText(model: FinishLineModel, detailed: boolean): FinishLineText {
  const line = model.lineParts.join(" · ");
  if (!detailed || model.detailParts.length === 0) return { line, details: null };
  return { line, details: model.detailParts.join(" | ") };
}

export function buildFinishLineModel({
  elapsedMs,
  elapsedLabel,
  label,
  model,
  report,
  costUsd,
  extraParts,
}: {
  elapsedMs: number;
  elapsedLabel?: string | null;
  label?: string | null;
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
  extraParts?: string[] | null;
}): FinishLineModel {
  const resolvedElapsedLabel =
    typeof elapsedLabel === "string" && elapsedLabel.trim().length > 0
      ? elapsedLabel
      : formatElapsedMs(elapsedMs);
  const promptTokens = sumNumbersOrNull(report.llm.map((row) => row.promptTokens));
  const completionTokens = sumNumbersOrNull(report.llm.map((row) => row.completionTokens));
  const totalTokens = sumNumbersOrNull(report.llm.map((row) => row.totalTokens));

  const hasAnyTokens = promptTokens !== null || completionTokens !== null || totalTokens !== null;
  const tokensPart = hasAnyTokens
    ? `↑${promptTokens != null ? formatCompactCount(promptTokens) : "unknown"} ↓${
        completionTokens != null ? formatCompactCount(completionTokens) : "unknown"
      } Δ${totalTokens != null ? formatCompactCount(totalTokens) : "unknown"}`
    : null;

  const compactTranscript = extraParts
    ? (extraParts.find((part) => part.startsWith("txc=")) ?? null)
    : null;
  const compactTranscriptLabel = compactTranscript?.startsWith("txc=")
    ? compactTranscript.slice("txc=".length)
    : null;

  const stripWordPrefix = (input: string): string | null => {
    // Examples:
    // - "2.9k words" => null
    // - "2.9k words via firecrawl" => "via firecrawl"
    const match = input.trim().match(/^~?\d[\d.]*[kmb]?\s+words(?:\s+via\s+(.+))?$/i);
    if (!match) return input;
    const via = match[1]?.trim();
    return via ? `via ${via}` : null;
  };

  const effectiveLabel = (() => {
    if (!label) return null;
    if (!compactTranscriptLabel?.toLowerCase().includes("words")) return label;

    const txLower = compactTranscriptLabel.toLowerCase();
    if (txLower.includes("podcast")) return null;
    if (txLower.includes("youtube") && /youtube|youtu\.be/i.test(label)) return null;

    const stripped = stripWordPrefix(label);
    if (stripped === null) return null;
    if (stripped !== label) return stripped;
    // If we still have a "… words" label here, drop it to avoid duplicated word counts.
    if (/\bwords\b/i.test(label)) return null;
    return label;
  })();
  const filteredExtraParts =
    compactTranscriptLabel && extraParts
      ? extraParts.filter((part) => part !== compactTranscript)
      : extraParts;
  const summaryParts: Array<string | null> = [
    resolvedElapsedLabel,
    compactTranscriptLabel,
    costUsd != null ? formatUSD(costUsd) : null,
    effectiveLabel,
    model ? formatModelLabelForDisplay(model) : null,
    tokensPart,
  ];
  const lineParts = summaryParts.filter((part): part is string => typeof part === "string");

  const totalCalls = report.llm.reduce((sum, row) => sum + row.calls, 0);
  const lenParts =
    filteredExtraParts?.filter(
      (part) => part.startsWith("input=") || part.startsWith("transcript="),
    ) ?? [];
  const miscParts =
    filteredExtraParts?.filter(
      (part) => !part.startsWith("input=") && !part.startsWith("transcript="),
    ) ?? [];

  const line2Segments: string[] = [];
  if (lenParts.length > 0) {
    line2Segments.push(`len ${lenParts.join(" ")}`);
  }
  if (totalCalls > 1) line2Segments.push(`calls=${formatCompactCount(totalCalls)}`);
  if (report.services.firecrawl.requests > 0 || report.services.apify.requests > 0) {
    const svcParts: string[] = [];
    if (report.services.firecrawl.requests > 0) {
      svcParts.push(`firecrawl=${formatCompactCount(report.services.firecrawl.requests)}`);
    }
    if (report.services.apify.requests > 0) {
      svcParts.push(`apify=${formatCompactCount(report.services.apify.requests)}`);
    }
    line2Segments.push(`svc ${svcParts.join(" ")}`);
  }
  if (miscParts.length > 0) {
    line2Segments.push(...miscParts);
  }

  return { lineParts, detailParts: line2Segments };
}
