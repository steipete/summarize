import type { LinkPreviewProgressEvent } from "@steipete/summarize-core/content";
import { formatBytes } from "./format.js";
import type { OscProgressController } from "./osc-progress.js";
import { createFetchHtmlProgressRenderer } from "./progress/fetch-html.js";
import { createTranscriptProgressRenderer } from "./progress/transcript.js";
import type { ThemeRenderer } from "./theme.js";

export function createWebsiteProgress({
  enabled,
  spinner,
  oscProgress,
  theme,
}: {
  enabled: boolean;
  spinner: { setText: (text: string) => void };
  oscProgress?: OscProgressController | null;
  theme?: ThemeRenderer | null;
}): {
  stop: () => void;
  onProgress: (event: LinkPreviewProgressEvent) => void;
} | null {
  if (!enabled) return null;

  const fetchRenderer = createFetchHtmlProgressRenderer({ spinner, oscProgress, theme });
  const transcriptRenderer = createTranscriptProgressRenderer({ spinner, oscProgress, theme });

  const styleLabel = (text: string) => (theme ? theme.label(text) : text);
  const styleDim = (text: string) => (theme ? theme.dim(text) : text);
  const renderStatus = (label: string, detail: string) =>
    theme ? `${styleLabel(label)}${styleDim(detail)}` : `${label}${detail}`;
  const renderTweetCliLabel = (client?: "xurl" | "bird" | null) =>
    client === "xurl" ? "Xurl" : client === "bird" ? "Bird" : "X";

  const stopAll = () => {
    fetchRenderer.stop();
    transcriptRenderer.stop();
  };

  const formatFirecrawlReason = (reason: string) => {
    const lower = reason.toLowerCase();
    if (lower.includes("forced")) return "forced";
    if (lower.includes("html fetch failed")) return "fallback: HTML fetch failed";
    if (lower.includes("blocked") || lower.includes("thin")) return "fallback: blocked/thin HTML";
    return reason;
  };

  return {
    stop: stopAll,
    onProgress: (event) => {
      fetchRenderer.onProgress(event);
      transcriptRenderer.onProgress(event);

      if (event.kind === "bird-start") {
        stopAll();
        spinner.setText(renderStatus(renderTweetCliLabel(event.client), ": reading tweet…"));
        return;
      }

      if (event.kind === "bird-done") {
        stopAll();
        const label = renderTweetCliLabel(event.client);
        if (event.ok && typeof event.textBytes === "number") {
          spinner.setText(renderStatus(label, `: got ${formatBytes(event.textBytes)}…`));
          return;
        }
        spinner.setText(renderStatus(label, ": failed; fallback…"));
        return;
      }

      if (event.kind === "nitter-start") {
        stopAll();
        spinner.setText(renderStatus("Nitter", ": fetching…"));
        return;
      }

      if (event.kind === "nitter-done") {
        stopAll();
        if (event.ok && typeof event.textBytes === "number") {
          spinner.setText(renderStatus("Nitter", `: got ${formatBytes(event.textBytes)}…`));
          return;
        }
        spinner.setText(renderStatus("Nitter", ": failed; fallback…"));
        return;
      }

      if (event.kind === "twitter-syndication-start") {
        stopAll();
        spinner.setText(renderStatus("X", ": fetching via syndication API…"));
        return;
      }

      if (event.kind === "twitter-syndication-done") {
        stopAll();
        if (event.ok && typeof event.textBytes === "number") {
          spinner.setText(renderStatus("X", `: got ${formatBytes(event.textBytes)}…`));
          return;
        }
        spinner.setText(renderStatus("X", ": syndication failed; fallback…"));
        return;
      }

      if (event.kind === "firecrawl-start") {
        stopAll();
        const reason = event.reason ? formatFirecrawlReason(event.reason) : "";
        const suffix = reason ? ` (${reason})` : "";
        spinner.setText(renderStatus("Firecrawl", `: scraping${suffix}…`));
        return;
      }

      if (event.kind === "firecrawl-done") {
        stopAll();
        if (event.ok && typeof event.markdownBytes === "number") {
          spinner.setText(renderStatus("Firecrawl", `: got ${formatBytes(event.markdownBytes)}…`));
          return;
        }
        spinner.setText(renderStatus("Firecrawl", ": no content; fallback…"));
        return;
      }

      if (event.kind === "transcript-start") {
        stopAll();
        const label = event.hint?.trim();
        const text = label && label.length > 0 ? label : "Transcribing";
        spinner.setText(theme ? `${styleLabel(text)}${styleDim("…")}` : `${text}…`);
        return;
      }

      if (event.kind === "transcript-done") {
        stopAll();
        if (event.ok) {
          spinner.setText(theme ? `${styleLabel("Transcribed")}${styleDim("…")}` : "Transcribed…");
          return;
        }
        spinner.setText(
          theme
            ? `${styleLabel("Transcript unavailable")}${styleDim("…")}`
            : "Transcript unavailable…",
        );
      }
    },
  };
}
