import type { SourceMetrics } from "@steipete/summarize-core/content";
import { type CliLocale, createCliTranslator } from "../../../locale.js";

export function formatSourceMetricsHeader(
  metrics: SourceMetrics | null | undefined,
  locale: CliLocale = "en",
): string | null {
  if (!metrics || metrics.platform !== "youtube") return null;
  return createCliTranslator(locale)("source.youtubeViews", {
    count: metrics.viewCount ?? 0,
    available: metrics.viewCount !== null,
  });
}
