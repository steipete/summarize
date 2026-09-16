import type { LinkPreviewProgressEvent } from "@steipete/summarize-core/content";
import { type CliLocale, createCliTranslator } from "../../locale.js";
import { formatBytes, formatBytesPerSecond, formatElapsedMs } from "../format.js";
import type { OscProgressController } from "../osc-progress.js";
import type { ThemeRenderer } from "../theme.js";

export function createFetchHtmlProgressRenderer({
  spinner,
  oscProgress,
  theme,
  locale = "en",
}: {
  locale?: CliLocale;
  spinner: { setText: (text: string) => void; refresh?: () => void };
  oscProgress?: OscProgressController | null;
  theme?: ThemeRenderer | null;
}): {
  stop: () => void;
  onProgress: (event: LinkPreviewProgressEvent) => void;
} {
  const state: {
    downloadedBytes: number;
    totalBytes: number | null;
    startedAtMs: number | null;
    lastSpinnerUpdateAtMs: number;
  } = {
    downloadedBytes: 0,
    totalBytes: null,
    startedAtMs: null,
    lastSpinnerUpdateAtMs: 0,
  };

  let ticker: ReturnType<typeof setInterval> | null = null;
  const t = createCliTranslator(
    locale,
    theme
      ? { uiLabel: theme.label, uiDetail: theme.dim, uiValue: theme.value, default: theme.label }
      : undefined,
  );
  const renderMessage = (key: Parameters<typeof t>[0], values: Parameters<typeof t>[1] = {}) => {
    const text = t(key, values);
    return text;
  };

  const updateSpinner = (text: string, options?: { force?: boolean }) => {
    const now = Date.now();
    if (!options?.force && now - state.lastSpinnerUpdateAtMs < 100) return;
    state.lastSpinnerUpdateAtMs = now;
    spinner.setText(text);
  };
  const refreshSpinner = () => {
    spinner.refresh?.();
  };

  const render = () => {
    const downloaded = formatBytes(state.downloadedBytes, locale);
    const total =
      typeof state.totalBytes === "number" &&
      state.totalBytes > 0 &&
      state.downloadedBytes <= state.totalBytes
        ? `/${formatBytes(state.totalBytes, locale)}`
        : "";
    const elapsedMs = typeof state.startedAtMs === "number" ? Date.now() - state.startedAtMs : 0;
    const elapsed = formatElapsedMs(elapsedMs, locale);
    if (state.downloadedBytes === 0 && !state.totalBytes) {
      return renderMessage("progress.fetchConnecting", { elapsed });
    }
    const rate =
      elapsedMs > 0 && state.downloadedBytes > 0
        ? `, ${formatBytesPerSecond(state.downloadedBytes / (elapsedMs / 1000), locale)}`
        : "";
    return renderMessage("progress.fetchTransfer", { downloaded, total, elapsed, rate });
  };

  const startTicker = () => {
    if (ticker) return;
    ticker = setInterval(() => updateSpinner(render()), 1000);
  };

  const stopTicker = () => {
    if (!ticker) return;
    clearInterval(ticker);
    ticker = null;
  };

  const freeze = () => {
    stopTicker();
    oscProgress?.clear();
    updateSpinner(render(), { force: true });
    refreshSpinner();
  };

  return {
    stop: stopTicker,
    onProgress: (event) => {
      if (event.kind === "fetch-html-start") {
        state.downloadedBytes = 0;
        state.totalBytes = null;
        state.startedAtMs = Date.now();
        startTicker();
        updateSpinner(renderMessage("progress.fetchStart"));
        oscProgress?.setIndeterminate(t("fetching.website"));
        refreshSpinner();
        return;
      }

      if (event.kind === "fetch-html-progress") {
        state.downloadedBytes = event.downloadedBytes;
        state.totalBytes = event.totalBytes;
        updateSpinner(render());
        if (typeof state.totalBytes === "number" && state.totalBytes > 0) {
          oscProgress?.setPercent(
            t("fetching.website"),
            (state.downloadedBytes / state.totalBytes) * 100,
          );
        } else {
          oscProgress?.setIndeterminate(t("fetching.website"));
        }
        refreshSpinner();
        return;
      }

      if (event.kind === "fetch-html-done") {
        state.downloadedBytes = event.downloadedBytes;
        state.totalBytes = event.totalBytes;
        freeze();
      }
    },
  };
}
