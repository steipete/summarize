import type { LinkPreviewProgressEvent } from "@steipete/summarize-core/content";
import type { CliLocale } from "../../locale.js";
import type { OscProgressController } from "../osc-progress.js";
import type { ThemeRenderer } from "../theme.js";
import {
  applyTranscriptProgressEvent,
  createTranscriptProgressState,
  renderTranscriptLine,
  renderTranscriptSimple,
  resolveTranscriptOscPayload,
} from "./transcript-state.js";

export function createTranscriptProgressRenderer({
  spinner,
  oscProgress,
  theme,
  locale = /* i18n-ignore: Default locale code for message/number formatting. */ "en",
}: {
  locale?: CliLocale;
  spinner: { setText: (text: string) => void; refresh?: () => void };
  oscProgress?: OscProgressController | null;
  theme?: ThemeRenderer | null;
}): {
  stop: () => void;
  onProgress: (event: LinkPreviewProgressEvent) => void;
} {
  const state = createTranscriptProgressState();
  let ticker: ReturnType<typeof setInterval> | null = null;
  let lastSpinnerUpdateAtMs = 0;

  const updateSpinner = (text: string, options?: { force?: boolean }) => {
    const now = Date.now();
    if (!options?.force && now - lastSpinnerUpdateAtMs < 100) return;
    lastSpinnerUpdateAtMs = now;
    spinner.setText(text);
  };
  const refreshSpinner = () => {
    spinner.refresh?.();
  };

  const stopTicker = () => {
    if (!ticker) return;
    clearInterval(ticker);
    ticker = null;
  };

  const renderActiveLine = () =>
    renderTranscriptLine(state, {
      nowMs: Date.now(),
      theme,
      locale,
    }) ?? "";

  const updateOsc = () => {
    if (!oscProgress) return;
    const payload = resolveTranscriptOscPayload(state, locale);
    if (!payload) return;
    if (typeof payload.percent === "number") {
      oscProgress.setPercent(payload.label, payload.percent);
    } else {
      oscProgress.setIndeterminate(payload.label);
    }
    refreshSpinner();
  };

  const startTicker = () => {
    ticker = setInterval(() => {
      updateSpinner(renderActiveLine());
      updateOsc();
    }, 1000);
  };

  const updatePhase = (
    event: LinkPreviewProgressEvent,
    options?: { force?: boolean; stopTicker?: boolean },
  ) => {
    applyTranscriptProgressEvent(state, event, Date.now());
    if (options?.stopTicker) stopTicker();
    updateSpinner(renderActiveLine(), { force: options?.force });
    updateOsc();
  };

  return {
    stop: stopTicker,
    onProgress: (event) => {
      if (event.kind === "transcript-media-download-start") {
        applyTranscriptProgressEvent(state, event, Date.now());
        stopTicker();
        startTicker();
        updateSpinner(renderTranscriptSimple(state, theme, locale) ?? "", { force: true });
        updateOsc();
        return;
      }

      if (event.kind === "transcript-media-download-progress") {
        updatePhase(event);
        return;
      }

      if (event.kind === "transcript-media-download-done") {
        updatePhase(event, { force: true, stopTicker: true });
        return;
      }

      if (event.kind === "transcript-whisper-start") {
        applyTranscriptProgressEvent(state, event, Date.now());
        stopTicker();
        startTicker();
        updateSpinner(renderActiveLine(), { force: true });
        updateOsc();
        return;
      }

      if (event.kind === "transcript-whisper-progress") {
        updatePhase(event);
      }
    },
  };
}
