import type { CacheStats } from "@steipete/summarize-core/runtime";
import { createModelPresetsController } from "../../lib/model-presets";
import { defaultSettings, loadSettings, saveSettings } from "../../lib/settings";
import { applyTheme, type ColorMode, type ColorScheme } from "../../lib/theme";
import { bindOptionsInputs } from "./bindings";
import { createBooleanSettingsRuntime } from "./boolean-settings";
import { languagePresets, optionsTabStorageKey } from "./constants";
import { createDaemonCapabilityController } from "./daemon-capability";
import { createDaemonStatusChecker } from "./daemon-status";
import { getOptionsElements } from "./elements";
import { applyLoadedOptionsSettings, buildSavedOptionsSettings } from "./form-state";
import { createLogsViewer } from "./logs-viewer";
import { createOptionsSaveRuntime } from "./persistence";
import { mountOptionsPickers } from "./pickers";
import { createProcessesViewer } from "./processes-viewer";
import type { createSkillsController } from "./skills-controller";
import {
  applyBuildInfo,
  copyTokenToClipboard,
  createAutomationPermissionsController,
  createStatusController,
} from "./support";
import { createOptionsTabs, resolveActiveOptionsTab } from "./tab-controller";

declare const __SUMMARIZE_GIT_HASH__: string;
declare const __SUMMARIZE_VERSION__: string;

const elements = getOptionsElements();

const resolveActiveTab = () => resolveActiveOptionsTab(elements.tabButtons);

let isInitializing = true;
const { setStatus, flashStatus } = createStatusController(elements.statusEl);
type SkillsController = ReturnType<typeof createSkillsController>;
let skillsController: SkillsController | null = null;
let skillsControllerPromise: Promise<SkillsController> | null = null;
let skillsLoadPromise: Promise<void> | null = null;

const getSkillsController = async () => {
  if (skillsController) return skillsController;
  if (!skillsControllerPromise) {
    skillsControllerPromise = import("./skills-controller")
      .then(({ createSkillsController }) => {
        const controller = createSkillsController({
          elements: {
            searchEl: elements.skillsSearchEl,
            listEl: elements.skillsListEl,
            emptyEl: elements.skillsEmptyEl,
            conflictsEl: elements.skillsConflictsEl,
            exportBtn: elements.skillsExportBtn,
            importBtn: elements.skillsImportBtn,
          },
          setStatus,
          flashStatus,
        });
        controller.bind();
        skillsController = controller;
        return controller;
      })
      .catch((error) => {
        skillsControllerPromise = null;
        throw error;
      });
  }
  return skillsControllerPromise;
};

const ensureSkillsLoaded = async () => {
  const controller = await getSkillsController();
  if (!skillsLoadPromise) {
    skillsLoadPromise = controller.load().catch((error) => {
      skillsLoadPromise = null;
      throw error;
    });
  }
  await skillsLoadPromise;
};

const loadSkillsTab = () => {
  void ensureSkillsLoaded().catch((error) => {
    setStatus(`Failed to load skills: ${error instanceof Error ? error.message : String(error)}`);
  });
};

const logsViewer = createLogsViewer({
  elements: {
    sourceEl: elements.logsSourceEl,
    tailEl: elements.logsTailEl,
    refreshBtn: elements.logsRefreshBtn,
    autoEl: elements.logsAutoEl,
    outputEl: elements.logsOutputEl,
    rawEl: elements.logsRawEl,
    tableEl: elements.logsTableEl,
    parsedEl: elements.logsParsedEl,
    metaEl: elements.logsMetaEl,
    levelInputs: elements.logsLevelInputs,
  },
  getToken: () => elements.tokenEl.value.trim(),
  isActive: () => resolveActiveTab() === "logs",
});

const processesViewer = createProcessesViewer({
  elements: {
    refreshBtn: elements.processesRefreshBtn,
    autoEl: elements.processesAutoEl,
    showCompletedEl: elements.processesShowCompletedEl,
    limitEl: elements.processesLimitEl,
    streamEl: elements.processesStreamEl,
    tailEl: elements.processesTailEl,
    metaEl: elements.processesMetaEl,
    tableEl: elements.processesTableEl,
    logsTitleEl: elements.processesLogsTitleEl,
    logsCopyBtn: elements.processesLogsCopyBtn,
    logsOutputEl: elements.processesLogsOutputEl,
  },
  getToken: () => elements.tokenEl.value.trim(),
  isActive: () => resolveActiveTab() === "processes",
});

let refreshBrowserCacheStatus = () => {};

createOptionsTabs({
  root: elements.tabsRoot,
  buttons: elements.tabButtons,
  panels: elements.tabPanels,
  storageKey: optionsTabStorageKey,
  onTabActivated: (tabId) => {
    if (tabId === "skills") loadSkillsTab();
    if (tabId === "runtime") refreshBrowserCacheStatus();
  },
  onLogsActiveChange: (active) => {
    if (active) {
      logsViewer.handleTabActivated();
    } else {
      logsViewer.handleTabDeactivated();
    }
  },
  onProcessesActiveChange: (active) => {
    if (active) {
      processesViewer.handleTabActivated();
    } else {
      processesViewer.handleTabDeactivated();
    }
  },
});

let daemonCapability: ReturnType<typeof createDaemonCapabilityController> | null = null;
let refreshRuntimeStatus = (_token = elements.tokenEl.value) => {};

const { saveNow, scheduleAutoSave } = createOptionsSaveRuntime({
  isInitializing: () => isInitializing,
  setStatus,
  flashStatus,
  persist: async () => {
    const current = await loadSettings();
    await saveSettings(
      buildSavedOptionsSettings({
        current,
        defaults: defaultSettings,
        elements,
        modelPresets,
        booleans: booleanSettings.getState(),
        currentScheme,
        currentMode,
      }),
    );
  },
});

const booleanSettings = createBooleanSettingsRuntime({
  defaults: defaultSettings,
  roots: elements,
  scheduleAutoSave,
  onAutomationChanged: () => {
    void automationPermissions.updateUi();
  },
  onRuntimeChanged: () => {
    refreshRuntimeStatus();
  },
  ensureDaemonEnabled: () => daemonCapability?.ensureEnabled() ?? false,
});

const resolveExtensionVersion = () => {
  const injected =
    typeof __SUMMARIZE_VERSION__ === "string" && __SUMMARIZE_VERSION__ ? __SUMMARIZE_VERSION__ : "";
  return injected || chrome?.runtime?.getManifest?.().version || "";
};

const { checkDaemonStatus, setDaemonStatus } = createDaemonStatusChecker({
  statusEl: elements.daemonStatusEl,
  getExtensionVersion: resolveExtensionVersion,
  isDaemonMode: () => {
    const state = booleanSettings.getState();
    return state.summaryRuntime === "daemon" || state.slideRuntime === "daemon";
  },
});

daemonCapability = createDaemonCapabilityController({
  statusEl: elements.daemonCapabilityStatusEl,
  enableBtn: elements.daemonPermissionEnableBtn,
  daemonFieldsEl: elements.daemonFieldsEl,
  summaryRuntimeRoot: elements.summaryRuntimeModeRoot,
  slideRuntimeRoot: elements.slideRuntimeModeRoot,
  onStateChanged: () => refreshRuntimeStatus(),
});

refreshRuntimeStatus = (token = elements.tokenEl.value) => {
  const capability = daemonCapability?.getState();
  if (capability && !capability.policy.daemonAllowed) {
    setDaemonStatus("Disabled by administrator", "warn");
    return;
  }
  if (capability && !capability.permissionGranted) {
    setDaemonStatus("Local companion permission missing — enable it in Runtime settings", "warn");
    return;
  }
  void checkDaemonStatus(token);
};

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  let value = bytes;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  const precision = value >= 10 || unitIndex === 0 ? 0 : 1;
  return `${value.toFixed(precision)} ${units[unitIndex]}`;
}

async function sendBrowserCacheMessage(type: "browser-cache:stats" | "browser-cache:clear") {
  return (await chrome.runtime.sendMessage({ type })) as {
    ok?: boolean;
    stats?: CacheStats | null;
  };
}

function renderBrowserCacheStatus(stats: CacheStats | null | undefined) {
  if (!stats) {
    elements.browserCacheStatusEl.textContent = "Unavailable";
    return;
  }
  const entryLabel = stats.totalEntries === 1 ? "entry" : "entries";
  elements.browserCacheStatusEl.textContent = `${stats.totalEntries} ${entryLabel} · ${formatBytes(
    stats.sizeBytes,
  )} · expires after 30 days`;
}

refreshBrowserCacheStatus = () => {
  elements.browserCacheStatusEl.textContent = "Loading...";
  void sendBrowserCacheMessage("browser-cache:stats")
    .then((response) => {
      renderBrowserCacheStatus(response.ok ? response.stats : null);
    })
    .catch(() => {
      elements.browserCacheStatusEl.textContent = "Unavailable";
    });
};

elements.browserCacheClearBtn.addEventListener("click", () => {
  elements.browserCacheClearBtn.disabled = true;
  elements.browserCacheStatusEl.textContent = "Clearing...";
  void sendBrowserCacheMessage("browser-cache:clear")
    .then((response) => {
      if (!response.ok) {
        renderBrowserCacheStatus(null);
        setStatus("Failed to clear browser cache");
        return;
      }
      renderBrowserCacheStatus(response.stats);
      flashStatus("Browser cache cleared");
    })
    .catch(() => {
      elements.browserCacheStatusEl.textContent = "Clear failed";
      setStatus("Failed to clear browser cache");
    })
    .finally(() => {
      elements.browserCacheClearBtn.disabled = false;
    });
});

const modelPresets = createModelPresetsController({
  presetEl: elements.modelPresetEl,
  customEl: elements.modelCustomEl,
  defaultValue: defaultSettings.model,
  includeCliHints: true,
});
modelPresets.setDefaultPresets();

let currentScheme: ColorScheme = defaultSettings.colorScheme;
let currentMode: ColorMode = defaultSettings.colorMode;
let activeProvider = defaultSettings.provider;

const pickerHandlers = {
  onSchemeChange: (value: ColorScheme) => {
    currentScheme = value;
    applyTheme({ scheme: currentScheme, mode: currentMode });
    scheduleAutoSave(200);
  },
  onModeChange: (value: ColorMode) => {
    currentMode = value;
    applyTheme({ scheme: currentScheme, mode: currentMode });
    scheduleAutoSave(200);
  },
};

const pickers = mountOptionsPickers(elements.pickersRoot, {
  scheme: currentScheme,
  mode: currentMode,
  ...pickerHandlers,
});

const automationPermissions = createAutomationPermissionsController({
  automationPermissionsBtn: elements.automationPermissionsBtn,
  userScriptsNoticeEl: elements.userScriptsNoticeEl,
  getAutomationEnabled: () => booleanSettings.getState().automationEnabled,
  flashStatus,
});

elements.automationPermissionsBtn.addEventListener("click", () => {
  void automationPermissions.requestPermissions();
});

async function load() {
  const [s] = await Promise.all([loadSettings(), daemonCapability?.initialize()]);
  activeProvider = s.provider;
  await modelPresets.refreshPresets(s.token);
  modelPresets.setValue(s.model);
  const loadedState = applyLoadedOptionsSettings({
    settings: s,
    defaults: defaultSettings,
    languagePresets,
    elements,
  });
  booleanSettings.setState(loadedState.booleans);
  booleanSettings.render();
  refreshRuntimeStatus(s.token);
  refreshBrowserCacheStatus();
  currentScheme = loadedState.colorScheme;
  currentMode = loadedState.colorMode;
  pickers.update({ scheme: currentScheme, mode: currentMode, ...pickerHandlers });
  applyTheme({ scheme: s.colorScheme, mode: s.colorMode });
  isInitializing = false;
  document.documentElement.dataset.settingsReady = "true";
  await automationPermissions.updateUi();
  if (resolveActiveTab() === "logs") {
    logsViewer.handleTokenChanged();
  }
  if (resolveActiveTab() === "processes") {
    processesViewer.handleTokenChanged();
  }
}

chrome.storage.onChanged.addListener((_changes, areaName) => {
  if (areaName === "managed") void load();
});

elements.providerEl.addEventListener("change", () => {
  void (async () => {
    const stored = await loadSettings();
    await saveSettings({
      ...stored,
      providerApiKeys: {
        ...stored.providerApiKeys,
        [activeProvider]: elements.providerApiKeyEl.value.trim(),
      },
      providerBaseUrls: {
        ...stored.providerBaseUrls,
        [activeProvider]: elements.providerBaseUrlEl.value.trim(),
      },
    });
    const nextProvider = elements.providerEl.value as typeof activeProvider;
    activeProvider = nextProvider;
    const refreshed = await loadSettings();
    elements.providerApiKeyEl.value = refreshed.providerApiKeys[nextProvider] ?? "";
    elements.providerBaseUrlEl.value = refreshed.providerBaseUrls[nextProvider] ?? "";
    scheduleAutoSave(0);
  })();
});

elements.providerApiKeyEl.addEventListener("input", () => scheduleAutoSave(400));
elements.providerBaseUrlEl.addEventListener("input", () => scheduleAutoSave(400));

const copyToken = () => copyTokenToClipboard({ tokenEl: elements.tokenEl, flashStatus });

const refreshModelsIfStale = () => {
  modelPresets.refreshIfStale(elements.tokenEl.value);
};

bindOptionsInputs({
  elements,
  scheduleAutoSave,
  saveNow,
  checkDaemonStatus: refreshRuntimeStatus,
  modelPresets,
  logsViewer,
  processesViewer,
  copyToken,
  refreshModelsIfStale,
  defaultHoverPrompt: defaultSettings.hoverPrompt,
});

applyBuildInfo(elements.buildInfoEl, {
  injectedVersion:
    typeof __SUMMARIZE_VERSION__ === "string" && __SUMMARIZE_VERSION__ ? __SUMMARIZE_VERSION__ : "",
  manifestVersion: chrome?.runtime?.getManifest?.().version ?? "",
  gitHash: typeof __SUMMARIZE_GIT_HASH__ === "string" ? __SUMMARIZE_GIT_HASH__ : "",
});
void load();
