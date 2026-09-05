import type { loadSettings } from "../../lib/settings";
import { bindSettingsStorage, bindSidepanelLifecycle } from "./bindings";
import { patchPanelState } from "./panel-state-store";
import type { PanelState } from "./types";

type LoadedSettings = Awaited<ReturnType<typeof loadSettings>>;

export function bootstrapSidepanel(options: {
  ensurePanelPort: () => Promise<unknown>;
  loadSettings: () => Promise<LoadedSettings>;
  panelState: PanelState;

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
    patchPanelState(options.panelState, "panelSession", {
      pendingSettingsSnapshot: null,
      settingsHydrated: true,
    });
    options.typographyController.setCurrentFontSize(settings.fontSize);
    options.typographyController.setCurrentLineHeight(settings.lineHeight);
    patchPanelState(options.panelState, "panelSession", {
      autoSummarize: settings.autoSummarize,
      chatEnabled: settings.chatEnabled,
      automationEnabled: settings.automationEnabled,
    });
    patchPanelState(options.panelState, "slidesSession", { slidesLayout: settings.slidesLayout });
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

    applyChatEnabled: options.applyChatEnabled,
    hideAutomationNotice: options.hideAutomationNotice,
  });
  bindSidepanelLifecycle(options.bindSidepanelLifecycle);
}
