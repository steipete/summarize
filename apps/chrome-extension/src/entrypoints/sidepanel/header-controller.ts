import {
  setText as setUiText,
  message as uiMessage,
  resolveText,
  subscribeLocale,
  type LocalizedText,
} from "../../lib/i18n";
import { splitStatusPercent } from "../../lib/status";
import type { PanelPhase } from "./types";

type HeaderState = {
  phase: PanelPhase;
  summaryFromCache: boolean | null;
};

export type HeaderController = {
  setBaseTitle: (text: LocalizedText) => void;
  setBaseSubtitle: (text: LocalizedText) => void;
  setStatus: (text: LocalizedText) => void;
  armProgress: () => void;
  stopProgress: () => void;
  setProgressOverride: (next: boolean) => void;
  updateHeaderOffset: () => void;
};

export function createHeaderController({
  headerEl,
  titleEl,
  subtitleEl,
  progressFillEl,
  getState,
}: {
  headerEl: HTMLElement;
  titleEl: HTMLElement;
  subtitleEl: HTMLElement;
  progressFillEl: HTMLElement;
  getState: () => HeaderState;
}): HeaderController {
  let baseTitle: LocalizedText = uiMessage("brand.name");
  let baseSubtitle: LocalizedText = "";
  let statusText: LocalizedText = "";
  let showProgress = false;
  let progressOverride = false;
  let rafId: number | null = null;
  let lastTitle = "";
  let lastSubtitle = "";
  let lastIsError = false;
  let lastIsRunning = false;
  let lastIsIndeterminate = false;
  let lastProgress = "";
  let lastProgressDisplay = "";

  const shouldAllowProgress = (force = false) =>
    force || progressOverride || getState().summaryFromCache !== true;

  const isActiveStatus = (text: string) => {
    const trimmed = text.trim().toLowerCase();
    if (!trimmed) return false;
    if (trimmed.startsWith("error:")) return false;
    if (trimmed === "copied") return false;
    return (
      trimmed.startsWith("extracting") ||
      trimmed.startsWith("connecting") ||
      trimmed.startsWith("summarizing") ||
      trimmed.startsWith("sending") ||
      trimmed.startsWith("slides:") ||
      trimmed.startsWith("downloading") ||
      trimmed.startsWith("transcribing") ||
      trimmed.startsWith("processing") ||
      trimmed.startsWith("refreshing") ||
      trimmed.startsWith("starting") ||
      trimmed.startsWith("scanning") ||
      trimmed.includes("whisper") ||
      trimmed.includes("transcript") ||
      trimmed.includes("caption")
    );
  };

  const statusPresentation = () => {
    if (typeof statusText === "string") {
      const raw = statusText.trim();
      const split = splitStatusPercent(raw);
      return {
        label: split.text || raw,
        percent: split.percent ? Number.parseInt(split.percent, 10) : null,
        active: isActiveStatus(raw),
        error: raw.toLowerCase().startsWith("error:") || raw.toLowerCase().includes(" error"),
      };
    }
    const values =
      typeof statusText.values === "function" ? statusText.values() : statusText.values;
    const hasPercent =
      !Object.hasOwn(values, "hasPercent") ||
      values.hasPercent === true ||
      values.hasPercent === "true";
    const fraction = hasPercent && typeof values.percent === "number" ? values.percent : null;
    return {
      label: resolveText(statusText),
      percent: fraction !== null && Number.isFinite(fraction) ? fraction * 100 : null,
      active:
        statusText.key.startsWith("progress.") ||
        ["connecting", "summarizing", "starting.scan", "loading"].includes(statusText.key),
      error: statusText.key.startsWith("error."),
    };
  };

  const renderHeader = () => {
    const { phase } = getState();
    const isStreaming = phase === "connecting" || phase === "streaming";
    const presentation = statusPresentation();
    const statusLabel = presentation.label;
    const showStatus = statusLabel.length > 0;
    const percentNum = presentation.percent;
    const isError = showStatus && (presentation.error || phase === "error");
    const subtitle = resolveText(baseSubtitle);
    const title = resolveText(baseTitle);
    const isRunning = showProgress && !isError;
    const allowStatusWithSubtitle = showStatus && (isRunning || presentation.active);
    const shouldShowStatus = showStatus && (!isStreaming || !subtitle || allowStatusWithSubtitle);

    if (title !== lastTitle) {
      setUiText(titleEl, baseTitle);
      lastTitle = title;
    }

    if (
      !isError &&
      percentNum != null &&
      Number.isFinite(percentNum) &&
      percentNum >= 0 &&
      percentNum <= 100
    ) {
      const next = `${percentNum}%`;
      if (next !== lastProgress) {
        headerEl.style.setProperty("--progress", next);
        lastProgress = next;
      }
    } else {
      if (lastProgress !== "0%") {
        headerEl.style.setProperty("--progress", "0%");
        lastProgress = "0%";
      }
    }

    if (isError !== lastIsError) {
      headerEl.classList.toggle("isError", isError);
      lastIsError = isError;
    }
    if (isRunning !== lastIsRunning) {
      headerEl.classList.toggle("isRunning", isRunning);
      lastIsRunning = isRunning;
    }
    const isIndeterminate = isRunning && percentNum == null;
    if (isIndeterminate !== lastIsIndeterminate) {
      headerEl.classList.toggle("isIndeterminate", isIndeterminate);
      lastIsIndeterminate = isIndeterminate;
    }

    const progressDisplay = isRunning || isError ? "" : "none";
    if (progressDisplay !== lastProgressDisplay) {
      progressFillEl.style.display = progressDisplay;
      lastProgressDisplay = progressDisplay;
    }
    const nextSubtitle = isError
      ? statusLabel
      : shouldShowStatus && allowStatusWithSubtitle && subtitle
        ? resolveText(uiMessage("header.combinedStatus", { status: statusLabel, subtitle }))
        : shouldShowStatus
          ? statusLabel
          : subtitle;
    if (nextSubtitle !== lastSubtitle) {
      setUiText(subtitleEl, nextSubtitle);
      lastSubtitle = nextSubtitle;
    }
  };

  const updateHeader = () => {
    if (rafId != null) return;
    rafId = window.requestAnimationFrame(() => {
      rafId = null;
      renderHeader();
    });
  };

  const updateHeaderOffset = () => {
    const height = headerEl.getBoundingClientRect().height;
    document.documentElement.style.setProperty("--header-height", `${height}px`);
  };

  const setBaseSubtitle = (text: LocalizedText) => {
    baseSubtitle = text;
    updateHeader();
  };

  const setBaseTitle = (text: LocalizedText) => {
    const next = typeof text === "string" ? text.trim() || uiMessage("brand.name") : text;
    baseTitle = next;
    updateHeader();
  };

  const setStatus = (text: LocalizedText) => {
    statusText = text;
    const presentation = statusPresentation();
    const { phase } = getState();
    if (presentation.percent !== null && shouldAllowProgress(presentation.active)) armProgress();
    else if (presentation.label && shouldAllowProgress(presentation.active) && !presentation.error)
      armProgress();
    else if (!presentation.label && !(phase === "connecting" || phase === "streaming"))
      stopProgress();
    updateHeader();
  };

  const armProgress = () => {
    if (!shouldAllowProgress()) return;
    if (showProgress) return;
    showProgress = true;
    updateHeader();
  };

  const stopProgress = () => {
    if (!showProgress) return;
    showProgress = false;
    updateHeader();
  };

  const setProgressOverride = (next: boolean) => {
    progressOverride = next;
    if (next) {
      if (!showProgress) showProgress = true;
    } else if (
      !resolveText(statusText).trim() &&
      !(getState().phase === "connecting" || getState().phase === "streaming")
    ) {
      showProgress = false;
    }
    updateHeader();
  };

  subscribeLocale(updateHeader);

  return {
    setBaseTitle,
    setBaseSubtitle,
    setStatus,
    armProgress,
    stopProgress,
    setProgressOverride,
    updateHeaderOffset,
  };
}
