import {
  setText as setUiText,
  message as uiMessage,
  resolveText,
  type LocalizedText,
} from "../../lib/i18n";
type ErrorControllerOptions = {
  panelEl: HTMLElement;
  panelMessageEl: HTMLElement;
  panelRetryBtn?: HTMLButtonElement | null;
  panelLogsBtn?: HTMLButtonElement | null;
  inlineEl: HTMLElement;
  inlineMessageEl: HTMLElement;
  inlineRetryBtn?: HTMLButtonElement | null;
  inlineLogsBtn?: HTMLButtonElement | null;
  inlineCloseBtn?: HTMLButtonElement | null;
  onPanelVisibilityChange?: () => void;
};

export type ErrorController = {
  bindActions: (actions: { onRetry: () => void; onOpenLogs: () => void }) => void;
  showPanelError: (message: LocalizedText) => void;
  showInlineError: (message: LocalizedText) => void;
  clearPanelError: () => void;
  clearInlineError: () => void;
  clearAll: () => void;
};

const stripInvisible = (message: string) => message.replace(/[\u200B-\u200D\uFEFF]/g, "");

const hasMeaningfulMessage = (message: LocalizedText) =>
  stripInvisible(resolveText(message)).replace(/\s/g, "").length > 0;

const normalizeMessage = (message: LocalizedText): LocalizedText => {
  if (typeof message !== "string") return message;
  const trimmed = stripInvisible(message).trim();
  return trimmed.length > 0 ? trimmed : uiMessage("something.went.wrong.alternate");
};

export const createErrorController = (options: ErrorControllerOptions): ErrorController => {
  const {
    panelEl,
    panelMessageEl,
    panelRetryBtn,
    panelLogsBtn,
    inlineEl,
    inlineMessageEl,
    inlineRetryBtn,
    inlineLogsBtn,
    inlineCloseBtn,
    onPanelVisibilityChange,
  } = options;
  let actionsBound = false;

  const hideInline = () => {
    setUiText(inlineMessageEl, "");
    inlineEl.classList.add("hidden");
    inlineEl.style.display = "none";
  };

  const hidePanel = () => {
    setUiText(panelMessageEl, "");
    panelEl.classList.add("hidden");
    onPanelVisibilityChange?.();
  };

  const showPanel = (message: LocalizedText) => {
    if (!hasMeaningfulMessage(message)) {
      hidePanel();
      return;
    }
    hideInline();
    setUiText(panelMessageEl, normalizeMessage(message));
    panelEl.classList.remove("hidden");
    onPanelVisibilityChange?.();
  };

  const showInline = (message: LocalizedText) => {
    if (!hasMeaningfulMessage(message)) {
      hideInline();
      return;
    }
    hidePanel();
    setUiText(inlineMessageEl, normalizeMessage(message));
    inlineEl.classList.remove("hidden");
    inlineEl.style.display = "";
  };

  inlineCloseBtn?.addEventListener("click", () => hideInline());

  return {
    bindActions({ onRetry, onOpenLogs }) {
      if (actionsBound) return;
      actionsBound = true;
      panelRetryBtn?.addEventListener("click", onRetry);
      panelLogsBtn?.addEventListener("click", onOpenLogs);
      inlineRetryBtn?.addEventListener("click", onRetry);
      inlineLogsBtn?.addEventListener("click", onOpenLogs);
    },
    showPanelError: showPanel,
    showInlineError: showInline,
    clearPanelError: hidePanel,
    clearInlineError: hideInline,
    clearAll: () => {
      hidePanel();
      hideInline();
    },
  };
};
