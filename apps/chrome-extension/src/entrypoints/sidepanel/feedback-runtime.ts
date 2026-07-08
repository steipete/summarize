import { getLocalStorage, type LocalStorageLike } from "../../lib/local-storage";
import { createErrorController } from "./error-controller";
import { createHeaderController } from "./header-controller";
import type { PanelState } from "./types";

type FeedbackEventTarget = {
  addEventListener: (type: string, listener: EventListener) => void;
};

const OPTIONS_TAB_STORAGE_KEY = "summarize:options-tab";

export function createSidepanelFeedbackRuntime({
  panelState,
  headerEl,
  titleEl,
  subtitleEl,
  progressFillEl,
  panelErrorEl,
  panelErrorMessageEl,
  panelErrorRetryBtn,
  panelErrorLogsBtn,
  inlineErrorEl,
  inlineErrorMessageEl,
  inlineErrorRetryBtn,
  inlineErrorLogsBtn,
  inlineErrorCloseBtn,
  slideNoticeEl,
  slideNoticeMessageEl,
  slideNoticeRetryBtn,
  sendOpenOptions,
  eventTarget = window,
  storage = getLocalStorage(),
}: {
  panelState: PanelState;
  headerEl: HTMLElement;
  titleEl: HTMLElement;
  subtitleEl: HTMLElement;
  progressFillEl: HTMLElement;
  panelErrorEl: HTMLElement;
  panelErrorMessageEl: HTMLElement;
  panelErrorRetryBtn: HTMLButtonElement;
  panelErrorLogsBtn: HTMLButtonElement;
  inlineErrorEl: HTMLElement;
  inlineErrorMessageEl: HTMLElement;
  inlineErrorRetryBtn: HTMLButtonElement;
  inlineErrorLogsBtn: HTMLButtonElement;
  inlineErrorCloseBtn: HTMLButtonElement;
  slideNoticeEl: HTMLElement;
  slideNoticeMessageEl: HTMLElement;
  slideNoticeRetryBtn: HTMLButtonElement;
  sendOpenOptions: () => void;
  eventTarget?: FeedbackEventTarget;
  storage?: Pick<LocalStorageLike, "setItem"> | null;
}) {
  const headerController = createHeaderController({
    headerEl,
    titleEl,
    subtitleEl,
    progressFillEl,
    getState: () => ({
      phase: panelState.phase,
      summaryFromCache: panelState.summaryFromCache,
    }),
  });

  const openOptionsTab = (tabId: string) => {
    try {
      storage?.setItem(OPTIONS_TAB_STORAGE_KEY, tabId);
    } catch {
      // Continue opening options when local storage is unavailable.
    }
    sendOpenOptions();
  };

  const errorController = createErrorController({
    panelEl: panelErrorEl,
    panelMessageEl: panelErrorMessageEl,
    panelRetryBtn: panelErrorRetryBtn,
    panelLogsBtn: panelErrorLogsBtn,
    inlineEl: inlineErrorEl,
    inlineMessageEl: inlineErrorMessageEl,
    inlineRetryBtn: inlineErrorRetryBtn,
    inlineLogsBtn: inlineErrorLogsBtn,
    inlineCloseBtn: inlineErrorCloseBtn,
    onPanelVisibilityChange: headerController.updateHeaderOffset,
  });

  const hideSlideNotice = () => {
    slideNoticeEl.classList.add("hidden");
    slideNoticeMessageEl.textContent = "";
    slideNoticeRetryBtn.hidden = true;
    headerController.updateHeaderOffset();
  };

  const showSlideNotice = (message: string, options?: { allowRetry?: boolean }) => {
    slideNoticeMessageEl.textContent = message;
    slideNoticeRetryBtn.hidden = !options?.allowRetry;
    slideNoticeEl.classList.remove("hidden");
    headerController.updateHeaderOffset();
  };

  headerController.updateHeaderOffset();
  eventTarget.addEventListener("resize", headerController.updateHeaderOffset as EventListener);
  let actionsBound = false;

  return {
    bindActions({
      retryLastAction,
      retrySlidesStream,
    }: {
      retryLastAction: () => void;
      retrySlidesStream: () => void;
    }) {
      if (actionsBound) return;
      actionsBound = true;
      errorController.bindActions({
        onRetry: retryLastAction,
        onOpenLogs: () => openOptionsTab("logs"),
      });
      slideNoticeRetryBtn.addEventListener("click", retrySlidesStream);
    },
    errorController,
    headerController,
    hideSlideNotice,
    showSlideNotice,
  };
}
