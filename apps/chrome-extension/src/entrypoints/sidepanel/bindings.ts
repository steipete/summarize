import type { Settings, SlidesLayout } from "../../lib/settings";
import { patchPanelState } from "./panel-state-store";
import type { PanelState } from "./types";

export function bindSidepanelUiEvents({
  refreshBtn,
  clearBtn,
  drawerToggleBtn,
  advancedBtn,
  advancedSettingsSummaryEl,
  chatSendBtn,
  chatInputEl,
  sizeSmBtn,
  sizeLgBtn,
  lineTightBtn,
  lineLooseBtn,
  modelPresetEl,
  modelCustomEl,
  slidesLayoutEl,
  modelRefreshBtn,
  advancedSettingsEl,
  lineHeightStep,
  sendSummarize,
  clearCurrentView,
  toggleDrawer,
  openOptions,
  toggleAdvancedSettings,
  sendChatMessage,
  bumpFontSize,
  bumpLineHeight,
  persistCurrentModel,
  setSlidesLayout,
  refreshModelsIfStale,
  runRefreshFree,
}: {
  refreshBtn: HTMLButtonElement;
  clearBtn: HTMLButtonElement;
  drawerToggleBtn: HTMLButtonElement;
  advancedBtn: HTMLButtonElement;
  advancedSettingsSummaryEl: Element | null;
  chatSendBtn: HTMLButtonElement;
  chatInputEl: HTMLTextAreaElement;
  sizeSmBtn: HTMLButtonElement;
  sizeLgBtn: HTMLButtonElement;
  lineTightBtn: HTMLButtonElement;
  lineLooseBtn: HTMLButtonElement;
  modelPresetEl: HTMLSelectElement;
  modelCustomEl: HTMLInputElement;
  slidesLayoutEl: HTMLSelectElement;
  modelRefreshBtn: HTMLButtonElement;
  advancedSettingsEl: HTMLDetailsElement;
  lineHeightStep: number;
  sendSummarize: (opts?: { refresh?: boolean }) => void;
  clearCurrentView: () => Promise<void>;
  toggleDrawer: () => void;
  openOptions: () => Promise<void>;
  toggleAdvancedSettings: () => void;
  sendChatMessage: () => void;
  bumpFontSize: (delta: number) => void;
  bumpLineHeight: (delta: number) => void;
  persistCurrentModel: (opts?: { focusCustom?: boolean; blurCustom?: boolean }) => void;
  setSlidesLayout: (next: SlidesLayout) => void;
  refreshModelsIfStale: () => void;
  runRefreshFree: () => Promise<void>;
}) {
  refreshBtn.addEventListener("click", () => sendSummarize({ refresh: true }));
  clearBtn.addEventListener("click", () => {
    void clearCurrentView();
  });
  drawerToggleBtn.addEventListener("click", () => toggleDrawer());
  advancedBtn.addEventListener("click", () => {
    void openOptions();
  });
  advancedSettingsSummaryEl?.addEventListener("click", (event) => {
    event.preventDefault();
    toggleAdvancedSettings();
  });

  chatSendBtn.addEventListener("click", sendChatMessage);
  chatInputEl.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      sendChatMessage();
    }
  });
  chatInputEl.addEventListener("input", () => {
    chatInputEl.style.height = "auto";
    chatInputEl.style.height = `${Math.min(chatInputEl.scrollHeight, 120)}px`;
  });

  sizeSmBtn.addEventListener("click", () => bumpFontSize(-1));
  sizeLgBtn.addEventListener("click", () => bumpFontSize(1));
  lineTightBtn.addEventListener("click", () => bumpLineHeight(-lineHeightStep));
  lineLooseBtn.addEventListener("click", () => bumpLineHeight(lineHeightStep));

  modelPresetEl.addEventListener("change", () => persistCurrentModel({ focusCustom: true }));
  modelCustomEl.addEventListener("change", () => persistCurrentModel());
  modelCustomEl.addEventListener("keydown", (event) => {
    if (event.key !== "Enter") return;
    event.preventDefault();
    persistCurrentModel({ blurCustom: true });
  });

  slidesLayoutEl.addEventListener("change", () => {
    const next = slidesLayoutEl.value === "gallery" ? "gallery" : "strip";
    setSlidesLayout(next);
  });

  modelPresetEl.addEventListener("focus", refreshModelsIfStale);
  modelPresetEl.addEventListener("pointerdown", refreshModelsIfStale);
  modelCustomEl.addEventListener("focus", refreshModelsIfStale);
  modelCustomEl.addEventListener("pointerdown", refreshModelsIfStale);
  advancedSettingsEl.addEventListener("toggle", () => {
    if (advancedSettingsEl.open) refreshModelsIfStale();
  });
  modelRefreshBtn.addEventListener("click", () => {
    void runRefreshFree();
  });
}

export function bindSidepanelLifecycle({
  sendReady,
  sendClosed,
  scheduleAutoSummarize,
  syncWithActiveTab,
  clearInlineError,
  sendSummarize,
}: {
  sendReady: () => void;
  sendClosed: () => void;
  scheduleAutoSummarize: () => void;
  syncWithActiveTab: () => Promise<void>;
  clearInlineError: () => void;
  sendSummarize: (opts?: { refresh?: boolean }) => void;
}) {
  let lastVisibility = document.visibilityState;
  let panelMarkedOpen = document.visibilityState === "visible";

  const markPanelOpen = () => {
    if (panelMarkedOpen) return;
    panelMarkedOpen = true;
    clearInlineError();
    sendReady();
    scheduleAutoSummarize();
    void syncWithActiveTab();
  };

  const markPanelClosed = () => {
    if (!panelMarkedOpen) return;
    panelMarkedOpen = false;
    sendClosed();
  };

  document.addEventListener("visibilitychange", () => {
    const visible = document.visibilityState === "visible";
    const wasVisible = lastVisibility === "visible";
    if (visible && !wasVisible) {
      markPanelOpen();
    } else if (!visible && wasVisible) {
      markPanelClosed();
    }
    lastVisibility = document.visibilityState;
  });

  window.addEventListener("focus", () => {
    if (document.visibilityState !== "visible") return;
    markPanelOpen();
  });

  window.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" || !event.shiftKey) return;
    const target = event.target as HTMLElement | null;
    if (
      target &&
      (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)
    ) {
      return;
    }
    event.preventDefault();
    sendSummarize({ refresh: true });
  });

  window.addEventListener("beforeunload", () => {
    sendClosed();
  });
}

export function bindSettingsStorage({
  panelState,

  applyChatEnabled,
  hideAutomationNotice,
}: {
  panelState: PanelState;

  applyChatEnabled: () => void;
  hideAutomationNotice: () => void;
}) {
  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== "local") return;
    const nextSettings = changes.settings?.newValue;
    if (!nextSettings || typeof nextSettings !== "object") return;
    if (!panelState.panelSession.settingsHydrated) {
      patchPanelState(panelState, "panelSession", {
        pendingSettingsSnapshot: {
          ...(panelState.panelSession.pendingSettingsSnapshot ?? {}),
          ...(nextSettings as Partial<Settings>),
        },
      });
    }
    const nextChatEnabled = (nextSettings as { chatEnabled?: unknown }).chatEnabled;
    if (typeof nextChatEnabled === "boolean") {
      patchPanelState(panelState, "panelSession", { chatEnabled: nextChatEnabled });
      applyChatEnabled();
    }
    const nextAutomationEnabled = (nextSettings as { automationEnabled?: unknown })
      .automationEnabled;
    if (typeof nextAutomationEnabled === "boolean") {
      patchPanelState(panelState, "panelSession", { automationEnabled: nextAutomationEnabled });
      if (!nextAutomationEnabled) hideAutomationNotice();
    }
  });
}
