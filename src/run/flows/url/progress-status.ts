import { type CliLocale, createCliTranslator } from "../../../locale.js";
import type { OscProgressController } from "../../../tty/osc-progress.js";
import {
  applySlidesText,
  applySummaryText,
  clearSlidesText,
  createUrlProgressStatusState,
} from "./progress-status-state.js";

export function createUrlProgressStatus({
  enabled,
  spinner,
  oscProgress,
  now = () => Date.now(),
  locale = "en",
}: {
  locale?: CliLocale;
  enabled: boolean;
  spinner: { setText: (text: string) => void; refresh?: () => void };
  oscProgress: OscProgressController;
  now?: () => number;
}) {
  const state = createUrlProgressStatusState();
  const t = createCliTranslator(locale);

  const render = (text: string | null) => {
    if (!enabled || !text) return;
    spinner.setText(text);
  };
  const refresh = () => {
    if (!enabled) return;
    spinner.refresh?.();
  };

  return {
    setSummary(text: string, oscLabel?: string | null) {
      render(applySummaryText(state, text).renderText);
      if (oscLabel) {
        oscProgress.setIndeterminate(oscLabel);
        refresh();
      }
    },
    setSlides(text: string, percent?: number | null) {
      render(applySlidesText(state, text, now()).renderText);
      if (typeof percent === "number" && Number.isFinite(percent)) {
        oscProgress.setPercent(t("slides"), Math.max(0, Math.min(100, percent)));
      } else {
        oscProgress.setIndeterminate(t("slides"));
      }
      refresh();
    },
    clearSlides() {
      const next = clearSlidesText(state);
      if (next.summaryText) {
        render(next.renderText);
        oscProgress.setIndeterminate(t("summarizing"));
        refresh();
      }
    },
    isSlidesActive() {
      return state.slidesActive;
    },
    getSummaryText() {
      return state.summaryText;
    },
    getSlidesText() {
      return state.slidesText;
    },
  };
}
