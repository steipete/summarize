import { createDrawerControls } from "./drawer-controls";
import { createModelPresetsController } from "./model-presets";
import { createSetupRuntime } from "./setup-runtime";

export function createSetupControlsRuntime({
  advancedSettingsBodyEl,
  advancedSettingsEl,
  defaultModel,
  drawerEl,
  drawerToggleBtn,
  friendlyFetchError,
  generateToken,
  getStatusResetText,
  headerSetStatus,
  loadSettings,
  modelCustomEl,
  modelPresetEl,
  modelRefreshBtn,
  modelRowEl,
  modelStatusEl,
  patchSettings,
  setupEl,
}: {
  advancedSettingsBodyEl: HTMLElement;
  advancedSettingsEl: HTMLDetailsElement;
  defaultModel: string;
  drawerEl: HTMLElement;
  drawerToggleBtn: HTMLButtonElement;
  friendlyFetchError: (error: unknown, fallback: string) => string;
  generateToken: () => string;
  getStatusResetText: () => string;
  headerSetStatus: (text: string) => void;
  loadSettings: typeof import("../../lib/settings").loadSettings;
  modelCustomEl: HTMLInputElement;
  modelPresetEl: HTMLSelectElement;
  modelRefreshBtn: HTMLButtonElement;
  modelRowEl: HTMLDivElement;
  modelStatusEl: HTMLSpanElement;
  patchSettings: typeof import("../../lib/settings").patchSettings;
  setupEl: HTMLDivElement;
}) {
  const modelPresetsController = createModelPresetsController({
    modelPresetEl,
    modelCustomEl,
    modelRefreshBtn,
    modelStatusEl,
    modelRowEl,
    defaultModel,
    loadSettings,
    friendlyFetchError,
  });

  const drawerControls = createDrawerControls({
    drawerEl,
    drawerToggleBtn,
    advancedSettingsEl,
    advancedSettingsBodyEl,
    refreshModelsIfStale: modelPresetsController.refreshIfStale,
  });

  const ensureToken = async (): Promise<string> => {
    const settings = await loadSettings();
    if (settings.token.trim()) return settings.token.trim();
    const token = generateToken();
    await patchSettings({ token });
    return token;
  };

  const setupRuntime = createSetupRuntime({
    setupEl,
    loadToken: async () => (await loadSettings()).token.trim(),
    loadDaemonPort: async () => (await loadSettings()).daemonPort,
    ensureToken,
    patchSettings,
    generateToken,
    headerSetStatus,
    getStatusResetText,
  });

  return {
    drawerControls,
    isRefreshFreeRunning: modelPresetsController.isRefreshFreeRunning,
    maybeShowSetup: setupRuntime.maybeShowSetup,
    readCurrentModelValue: modelPresetsController.readCurrentValue,
    refreshModelPresets: modelPresetsController.refreshPresets,
    refreshModelsIfStale: modelPresetsController.refreshIfStale,
    runRefreshFree: modelPresetsController.runRefreshFree,
    setDefaultModelPresets: modelPresetsController.setDefaultPresets,
    setModelPlaceholderFromDiscovery: modelPresetsController.setPlaceholderFromDiscovery,
    setModelStatus: modelPresetsController.setStatus,
    setModelValue: modelPresetsController.setValue,
    updateModelRowUI: modelPresetsController.updateRowUI,
  };
}
