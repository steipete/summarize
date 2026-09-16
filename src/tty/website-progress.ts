import type { LinkPreviewProgressEvent } from "@steipete/summarize-core/content";
import { type CliLocale, createCliTranslator } from "../locale.js";
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
  locale = "en",
}: {
  locale?: CliLocale;
  enabled: boolean;
  spinner: { setText: (text: string) => void };
  oscProgress?: OscProgressController | null;
  theme?: ThemeRenderer | null;
}): {
  stop: () => void;
  onProgress: (event: LinkPreviewProgressEvent) => void;
} | null {
  if (!enabled) return null;

  const fetchRenderer = createFetchHtmlProgressRenderer({ spinner, oscProgress, theme, locale });
  const transcriptRenderer = createTranscriptProgressRenderer({
    spinner,
    oscProgress,
    theme,
    locale,
  });

  const t = createCliTranslator(locale);
  const renderMessage = (key: Parameters<typeof t>[0], values: Parameters<typeof t>[1] = {}) => {
    const text = t(key, values);
    return theme ? theme.label(text) : text;
  };
  const renderTweetCliLabel = (client?: "xurl" | "bird" | null) =>
    client === "xurl" ? "Xurl" : client === "bird" ? "Bird" : "X";

  const stopAll = () => {
    fetchRenderer.stop();
    transcriptRenderer.stop();
  };

  return {
    stop: stopAll,
    onProgress: (event) => {
      fetchRenderer.onProgress(event);
      transcriptRenderer.onProgress(event);

      if (event.kind === "bird-start") {
        stopAll();
        spinner.setText(
          renderMessage("progress.tweet.reading", { provider: renderTweetCliLabel(event.client) }),
        );
        return;
      }

      if (event.kind === "bird-done") {
        stopAll();
        const label = renderTweetCliLabel(event.client);
        if (event.ok && typeof event.textBytes === "number") {
          spinner.setText(
            renderMessage("progress.received", {
              provider: label,
              size: formatBytes(event.textBytes, locale),
            }),
          );
          return;
        }
        spinner.setText(renderMessage("progress.failedFallback", { provider: label }));
        return;
      }

      if (event.kind === "nitter-start") {
        stopAll();
        spinner.setText(renderMessage("progress.fetching", { provider: "Nitter" }));
        return;
      }

      if (event.kind === "nitter-done") {
        stopAll();
        if (event.ok && typeof event.textBytes === "number") {
          spinner.setText(
            renderMessage("progress.received", {
              provider: "Nitter",
              size: formatBytes(event.textBytes, locale),
            }),
          );
          return;
        }
        spinner.setText(renderMessage("progress.failedFallback", { provider: "Nitter" }));
        return;
      }

      if (event.kind === "twitter-syndication-start") {
        stopAll();
        spinner.setText(renderMessage("x.fetching.via.syndication.api"));
        return;
      }

      if (event.kind === "twitter-syndication-done") {
        stopAll();
        if (event.ok && typeof event.textBytes === "number") {
          spinner.setText(
            renderMessage("progress.received", {
              provider: "X",
              size: formatBytes(event.textBytes, locale),
            }),
          );
          return;
        }
        spinner.setText(renderMessage("x.syndication.failed.fallback"));
        return;
      }

      if (event.kind === "firecrawl-start") {
        stopAll();
        const reason = event.reason ?? "";
        const lower = reason.toLowerCase();
        const reasonKind = lower.includes("forced")
          ? "forced"
          : lower.includes(
                /* i18n-ignore: Legacy core extraction reason, translated through reasonKind. */ "html fetch failed",
              )
            ? "fetchFailed"
            : lower.includes("blocked") || lower.includes("thin")
              ? "blocked"
              : "other";
        spinner.setText(
          renderMessage("progress.scraping", { reason, reasonKind, hasReason: Boolean(reason) }),
        );
        return;
      }

      if (event.kind === "firecrawl-done") {
        stopAll();
        if (event.ok && typeof event.markdownBytes === "number") {
          spinner.setText(
            renderMessage("progress.received", {
              provider: "Firecrawl",
              size: formatBytes(event.markdownBytes, locale),
            }),
          );
          return;
        }
        spinner.setText(renderMessage("progress.noContentFallback", { provider: "Firecrawl" }));
        return;
      }

      if (event.kind === "transcript-start") {
        stopAll();
        // i18n-ignore: Legacy core progress hints; typed stage IDs take precedence.
        const stage =
          event.stage ??
          (event.hint === "YouTube: resolving transcript" ||
          event.hint === "Podcast: resolving transcript"
            ? "resolve"
            : null);
        if (stage)
          spinner.setText(
            renderMessage("progress.transcriptHint", { stage, service: event.service }),
          );
        else if (event.hint)
          spinner.setText(theme ? theme.label(`${event.hint}…`) : `${event.hint}…`);
        else spinner.setText(renderMessage("progress.transcribing"));
        return;
      }

      if (event.kind === "transcript-done") {
        stopAll();
        if (event.ok) {
          spinner.setText(renderMessage("progress.transcribed"));
          return;
        }
        spinner.setText(renderMessage("progress.transcriptUnavailable"));
      }
    },
  };
}
