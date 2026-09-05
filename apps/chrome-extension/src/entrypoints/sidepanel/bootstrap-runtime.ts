import type { ExtensionLocaleSetting } from "../../lib/i18n";
import type { Settings } from "../../lib/settings";
import { bindSettingsStorage, bindSidepanelLifecycle } from "./bindings";
import { applyPanelStateAction, type PanelStateAction } from "./panel-state-store";
import type { PanelState } from "./types";

type LoadedSettings = Pick<
  Settings,
  | "autoSummarize"
  | "chatEnabled"
  | "automationEnabled"
  | "slidesLayout"
  | "fontSize"
  | "lineHeight"
  | "fontFamily"
  | "model"
  | "token"
  | "uiLocale"
>;

function dispatchPanelState(
  options: {
    panelState: PanelState;
    dispatchPanelState?: (action: PanelStateAction) => void;
  },
  action: PanelStateAction,
) {
  if (options.dispatchPanelState) {
    options.dispatchPanelState(action);
  } else {
    applyPanelStateAction(options.panelState, action);
  }
}

export function bootstrapSidepanel(options: {
  ensurePanelPort: () => Promise<void>;
  loadSettings: () => Promise<LoadedSettings>;
  applyLocale: (locale: ExtensionLocaleSetting) => void;
  panelState: PanelState;
  dispatchPanelState?: (action: PanelStateAction) => void;
  typographyController: {
    setCurrentFontSize: (value: number) => void;
    setCurrentLineHeight: (value: number) => void;
  };
  setSlidesLayoutInputValue: (value: string) => void;
  hideAutomationNotice: () => void;
  appearanceControls: {
    setAutoValue: (value: boolean) => void;
    initializeFromSettings: (settings: LoadedSettings) => void;
  };
  applyChatEnabled: () => void;
  applySlidesLayout: () => void;
  setDefaultModelPresets: () => void;
  setModelValue: (value: string) => void;
  setModelPlaceholderFromDiscovery: (value: Record<string, never>) => void;
  updateModelRowUI: () => void;
  setModelRefreshDisabled: (value: boolean) => void;
  toggleDrawerClosed: () => void;
  renderMarkdownDisplay: () => void;
  sendReady: () => void;
  scheduleAutoSummarize: () => void;
  sendPing: () => void;
  bindSidepanelLifecycle: Parameters<typeof bindSidepanelLifecycle>[0];
}) {
  void (async () => {
    await options.ensurePanelPort();
    const loadedSettings = await options.loadSettings();
    const pendingSettingsSnapshot = options.panelState.panelSession.pendingSettingsSnapshot;
    const settings = pendingSettingsSnapshot
      ? { ...loadedSettings, ...pendingSettingsSnapshot }
      : loadedSettings;
    options.applyLocale(settings.uiLocale);
    dispatchPanelState(options, {
      type: "panel-session-update",
      value: {
        pendingSettingsSnapshot: null,
        settingsHydrated: true,
      },
    });
    options.typographyController.setCurrentFontSize(settings.fontSize);
    options.typographyController.setCurrentLineHeight(settings.lineHeight);
    dispatchPanelState(options, {
      type: "panel-session-update",
      value: {
        autoSummarize: settings.autoSummarize,
        chatEnabled: settings.chatEnabled,
        automationEnabled: settings.automationEnabled,
      },
    });
    dispatchPanelState(options, {
      type: "slides-session-update",
      value: { slidesLayout: settings.slidesLayout },
    });
    options.setSlidesLayoutInputValue(settings.slidesLayout);
    if (!settings.automationEnabled) options.hideAutomationNotice();
    options.appearanceControls.setAutoValue(settings.autoSummarize);
    options.applyChatEnabled();
    options.applySlidesLayout();
    options.appearanceControls.initializeFromSettings(settings);
    options.setDefaultModelPresets();
    options.setModelValue(settings.model);
    options.setModelPlaceholderFromDiscovery({});
    options.updateModelRowUI();
    options.setModelRefreshDisabled(!settings.token.trim());
    options.toggleDrawerClosed();
    options.renderMarkdownDisplay();
    options.sendReady();
    options.scheduleAutoSummarize();
  })();

  setInterval(() => {
    options.sendPing();
  }, 25_000);

  bindSettingsStorage({
    panelState: options.panelState,
    dispatchPanelState: options.dispatchPanelState,
    applyChatEnabled: options.applyChatEnabled,
    applyLocale: options.applyLocale,
    hideAutomationNotice: options.hideAutomationNotice,
  });
  bindSidepanelLifecycle(options.bindSidepanelLifecycle);
}
