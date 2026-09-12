import { type LinkPreviewProgressEvent, ProgressKind } from "@steipete/summarize-core/content";

function clampPercent(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(100, Math.max(0, Math.round(value)));
}

function formatPercentFromRatio(
  numerator: number | null,
  denominator: number | null,
): string | null {
  if (typeof numerator !== "number" || typeof denominator !== "number") return null;
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator <= 0) return null;
  return `${clampPercent((numerator / denominator) * 100)}%`;
}

export function formatProgress(event: LinkPreviewProgressEvent): string | null {
  switch (event.kind) {
    case ProgressKind.FetchHtmlStart:
      return "Fetching…";
    case ProgressKind.FirecrawlStart:
      return `Firecrawl… (${event.reason})`;
    case ProgressKind.FirecrawlDone:
      return event.ok ? "Firecrawl: done" : "Firecrawl: failed";
    case ProgressKind.TranscriptStart:
      return event.hint?.trim() ? event.hint.trim() : "Transcript…";
    case ProgressKind.TranscriptMediaDownloadStart:
      return `${event.service}: downloading audio…`;
    case ProgressKind.TranscriptMediaDownloadProgress:
      return `${event.service}: downloading audio…${(() => {
        const percent = formatPercentFromRatio(event.downloadedBytes, event.totalBytes);
        return percent ? ` ${percent}` : "";
      })()}`;
    case ProgressKind.TranscriptWhisperStart:
      return `${event.service}: transcribing…`;
    case ProgressKind.TranscriptWhisperProgress:
      return `${event.service}: transcribing…${(() => {
        const percentFromDuration = formatPercentFromRatio(
          event.processedDurationSeconds,
          event.totalDurationSeconds,
        );
        if (percentFromDuration) return ` ${percentFromDuration}`;
        const percentFromParts = formatPercentFromRatio(
          event.partIndex,
          event.parts ? Math.max(1, event.parts) : null,
        );
        return percentFromParts ? ` ${percentFromParts}` : "";
      })()}`;
    case ProgressKind.TranscriptDone:
      return event.ok
        ? `${event.service}: transcript ready`
        : `${event.service}: transcript unavailable`;
    case ProgressKind.BirdStart:
      return event.client ? `X: extracting tweet (${event.client})…` : "X: extracting tweet…";
    case ProgressKind.BirdDone:
      return event.ok ? "X: extracted tweet" : "X: extract failed";
    case ProgressKind.NitterStart:
      return "X: extracting tweet (nitter)…";
    case ProgressKind.NitterDone:
      return event.ok ? "X: extracted tweet" : "X: extract failed";
    case ProgressKind.TwitterSyndicationStart:
      return "X: extracting tweet (syndication API)…";
    case ProgressKind.TwitterSyndicationDone:
      return event.ok ? "X: extracted tweet" : "X: extract failed";
    default:
      return null;
  }
}
