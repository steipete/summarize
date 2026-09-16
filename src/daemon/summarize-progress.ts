import { type LinkPreviewProgressEvent, ProgressKind } from "@steipete/summarize-core/content";
import { createCliTranslator, type CliMessage } from "../locale.js";

function ratio(numerator: number | null, denominator: number | null): number | null {
  if (
    typeof numerator !== "number" ||
    typeof denominator !== "number" ||
    !Number.isFinite(numerator) ||
    !Number.isFinite(denominator) ||
    denominator <= 0
  )
    return null;
  return Math.min(100, Math.max(0, Math.round((numerator / denominator) * 100))) / 100;
}

export function describeProgress(event: LinkPreviewProgressEvent): CliMessage | null {
  const message = (key: CliMessage["key"], values: CliMessage["values"] = {}): CliMessage => ({
    key,
    values,
  });
  const media = (service: string, step: string, percent: number | null = null) =>
    message("progress.mediaStage", {
      service,
      step,
      hasPercent: percent !== null,
      percent: percent ?? 0,
    });
  switch (event.kind) {
    case ProgressKind.FetchHtmlStart:
      return message("progress.fetchingPage");
    case ProgressKind.FirecrawlStart:
      return message("progress.firecrawlStart", { reason: event.reason });
    case ProgressKind.FirecrawlDone:
      return message("progress.firecrawlDone", { ok: event.ok });
    case ProgressKind.TranscriptStart:
      if (event.stage)
        return message("progress.transcriptHint", { stage: event.stage, service: event.service });
      return event.hint?.trim() ? null : message("progress.transcript");
    case ProgressKind.TranscriptMediaDownloadStart:
      return media(event.service, "download");
    case ProgressKind.TranscriptMediaDownloadProgress:
      return media(event.service, "download", ratio(event.downloadedBytes, event.totalBytes));
    case ProgressKind.TranscriptWhisperStart:
      return media(event.service, "transcribe");
    case ProgressKind.TranscriptWhisperProgress:
      return media(
        event.service,
        "transcribe",
        ratio(event.processedDurationSeconds, event.totalDurationSeconds) ??
          ratio(event.partIndex, event.parts ? Math.max(1, event.parts) : null),
      );
    case ProgressKind.TranscriptDone:
      return media(event.service, event.ok ? "ready" : "unavailable");
    case ProgressKind.BirdStart:
      return message("progress.tweetExtract", {
        method: event.client ? "client" : "none",
        client: event.client ?? "",
      });
    case ProgressKind.NitterStart:
      return message("progress.tweetExtract", { method: "nitter", client: "" });
    case ProgressKind.TwitterSyndicationStart:
      return message("progress.tweetExtract", { method: "syndication", client: "" });
    case ProgressKind.BirdDone:
    case ProgressKind.NitterDone:
    case ProgressKind.TwitterSyndicationDone:
      return message("progress.tweetResult", { ok: event.ok });
    default:
      return null;
  }
}

export function formatProgress(event: LinkPreviewProgressEvent): string | null {
  const message = describeProgress(event);
  if (message) return createCliTranslator("en")(message.key, message.values);
  return event.kind === ProgressKind.TranscriptStart ? event.hint?.trim() || null : null;
}
