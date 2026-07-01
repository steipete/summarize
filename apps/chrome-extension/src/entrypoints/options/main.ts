import type { CacheStats } from "@steipete/summarize-core/runtime";
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
import { createModelPresetsController } from "./model-presets";
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
import { createOptionsTabs } from "./tab-controller";

declare const __SUMMARIZE_GIT_HASH__: string;
declare const __SUMMARIZE_VERSION__: string;

const {
  formEl,
  statusEl,
  tokenEl,
  daemonPortEl,
  daemonCapabilityStatusEl,
  daemonPermissionEnableBtn,
  daemonFieldsEl,
  tokenCopyBtn,
  summaryRuntimeModeRoot,
  providerEl,
  providerApiKeyEl,
  providerBaseUrlEl,
  modelPresetEl,
  modelCustomEl,
  languagePresetEl,
  languageCustomEl,
  promptOverrideEl,
  autoToggleRoot,
  maxCharsEl,
  hoverPromptEl,
  hoverPromptResetBtn,
  chatToggleRoot,
  automationToggleRoot,
  automationPermissionsBtn,
  userScriptsNoticeEl,
  skillsExportBtn,
  skillsImportBtn,
  skillsSearchEl,
  skillsListEl,
  skillsEmptyEl,
  skillsConflictsEl,
  hoverSummariesToggleRoot,
  summaryTimestampsToggleRoot,
  slidesParallelToggleRoot,
  slideRuntimeModeRoot,
  slidesOcrToggleRoot,
  extendedLoggingToggleRoot,
  autoCliFallbackToggleRoot,
  autoCliOrderEl,
  requestModeEl,
  firecrawlModeEl,
  markdownModeEl,
  preprocessModeEl,
  youtubeModeEl,
  transcriberEl,
  timeoutEl,
  retriesEl,
  maxOutputTokensEl,
  pickersRoot,
  fontFamilyEl,
  fontSizeEl,
  buildInfoEl,
  daemonStatusEl,
  browserCacheStatusEl,
  browserCacheClearBtn,
  logsSourceEl,
  logsTailEl,
  logsRefreshBtn,
  logsAutoEl,
  logsOutputEl,
  logsRawEl,
  logsTableEl,
  logsParsedEl,
  logsMetaEl,
  processesRefreshBtn,
  processesAutoEl,
  processesShowCompletedEl,
  processesLimitEl,
  processesStreamEl,
  processesTailEl,
  processesMetaEl,
  processesTableEl,
  processesLogsTitleEl,
  processesLogsCopyBtn,
  processesLogsOutputEl,
  tabsRoot,
  tabButtons,
  tabPanels,
  logsLevelInputs,
} = getOptionsElements();

let isInitializing = true;
const { setStatus, flashStatus } = createStatusController(statusEl);
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
            searchEl: skillsSearchEl,
            listEl: skillsListEl,
            emptyEl: skillsEmptyEl,
            conflictsEl: skillsConflictsEl,
            exportBtn: skillsExportBtn,
            importBtn: skillsImportBtn,
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
    sourceEl: logsSourceEl,
    tailEl: logsTailEl,
    refreshBtn: logsRefreshBtn,
    autoEl: logsAutoEl,
    outputEl: logsOutputEl,
    rawEl: logsRawEl,
    tableEl: logsTableEl,
    parsedEl: logsParsedEl,
    metaEl: logsMetaEl,
    levelInputs: logsLevelInputs,
  },
  getToken: () => tokenEl.value.trim(),
  isActive: () => resolveActiveTab() === "logs",
});

const processesViewer = createProcessesViewer({
  elements: {
    refreshBtn: processesRefreshBtn,
    autoEl: processesAutoEl,
    showCompletedEl: processesShowCompletedEl,
    limitEl: processesLimitEl,
    streamEl: processesStreamEl,
    tailEl: processesTailEl,
    metaEl: processesMetaEl,
    tableEl: processesTableEl,
    logsTitleEl: processesLogsTitleEl,
    logsCopyBtn: processesLogsCopyBtn,
    logsOutputEl: processesLogsOutputEl,
  },
  getToken: () => tokenEl.value.trim(),
  isActive: () => resolveActiveTab() === "processes",
});

let refreshBrowserCacheStatus = () => {};

const { resolveActiveTab } = createOptionsTabs({
  root: tabsRoot,
  buttons: tabButtons,
  panels: tabPanels,
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

let booleanSettings: ReturnType<typeof createBooleanSettingsRuntime> | null = null;
let daemonCapability: ReturnType<typeof createDaemonCapabilityController> | null = null;
let refreshRuntimeStatus = (_token = tokenEl.value) => {};
const settingsElements = {
  tokenEl,
  daemonPortEl,
  providerEl,
  providerApiKeyEl,
  providerBaseUrlEl,
  languagePresetEl,
  languageCustomEl,
  promptOverrideEl,
  hoverPromptEl,
  autoCliOrderEl,
  maxCharsEl,
  requestModeEl,
  firecrawlModeEl,
  markdownModeEl,
  preprocessModeEl,
  youtubeModeEl,
  transcriberEl,
  timeoutEl,
  retriesEl,
  maxOutputTokensEl,
  fontFamilyEl,
  fontSizeEl,
};

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
        elements: settingsElements,
        modelPresets,
        booleans: booleanSettings?.getState() ?? {
          autoSummarize: defaultSettings.autoSummarize,
          chatEnabled: defaultSettings.chatEnabled,
          automationEnabled: defaultSettings.automationEnabled,
          hoverSummaries: defaultSettings.hoverSummaries,
          summaryTimestamps: defaultSettings.summaryTimestamps,
          slidesParallel: defaultSettings.slidesParallel,
          slideRuntime: defaultSettings.slideRuntime,
          summaryRuntime: defaultSettings.summaryRuntime,
          slidesOcrEnabled: defaultSettings.slidesOcrEnabled,
          extendedLogging: defaultSettings.extendedLogging,
          autoCliFallback: defaultSettings.autoCliFallback,
        },
        currentScheme,
        currentMode,
      }),
    );
  },
});

booleanSettings = createBooleanSettingsRuntime({
  defaults: defaultSettings,
  roots: {
    autoToggleRoot,
    chatToggleRoot,
    automationToggleRoot,
    hoverSummariesToggleRoot,
    summaryTimestampsToggleRoot,
    slidesParallelToggleRoot,
    slideRuntimeModeRoot,
    summaryRuntimeModeRoot,
    slidesOcrToggleRoot,
    extendedLoggingToggleRoot,
    autoCliFallbackToggleRoot,
  },
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
  statusEl: daemonStatusEl,
  getExtensionVersion: resolveExtensionVersion,
  isDaemonMode: () => {
    const state = booleanSettings?.getState();
    return state?.summaryRuntime === "daemon" || state?.slideRuntime === "daemon";
  },
});

daemonCapability = createDaemonCapabilityController({
  statusEl: daemonCapabilityStatusEl,
  enableBtn: daemonPermissionEnableBtn,
  daemonFieldsEl,
  summaryRuntimeRoot: summaryRuntimeModeRoot,
  slideRuntimeRoot: slideRuntimeModeRoot,
  onStateChanged: () => refreshRuntimeStatus(),
});

refreshRuntimeStatus = (token = tokenEl.value) => {
  const capability = daemonCapability?.getState();
  if (capability && !capability.policy.daemonAllowed) {
    setDaemonStatus("Disabled by administrator", "warn");
    return;
  }
  if (capability && !capability.permissionGranted) {
    setDaemonStatus("Local companion not enabled", "warn");
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
    browserCacheStatusEl.textContent = "Unavailable";
    return;
  }
  const entryLabel = stats.totalEntries === 1 ? "entry" : "entries";
  browserCacheStatusEl.textContent = `${stats.totalEntries} ${entryLabel} · ${formatBytes(
    stats.sizeBytes,
  )} · expires after 30 days`;
}

refreshBrowserCacheStatus = () => {
  browserCacheStatusEl.textContent = "Loading...";
  void sendBrowserCacheMessage("browser-cache:stats")
    .then((response) => {
      renderBrowserCacheStatus(response.ok ? response.stats : null);
    })
    .catch(() => {
      browserCacheStatusEl.textContent = "Unavailable";
    });
};

browserCacheClearBtn.addEventListener("click", () => {
  browserCacheClearBtn.disabled = true;
  browserCacheStatusEl.textContent = "Clearing...";
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
      browserCacheStatusEl.textContent = "Clear failed";
      setStatus("Failed to clear browser cache");
    })
    .finally(() => {
      browserCacheClearBtn.disabled = false;
    });
});

const modelPresets = createModelPresetsController({
  presetEl: modelPresetEl,
  customEl: modelCustomEl,
  defaultValue: defaultSettings.model,
});

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

const pickers = mountOptionsPickers(pickersRoot, {
  scheme: currentScheme,
  mode: currentMode,
  ...pickerHandlers,
});

const automationPermissions = createAutomationPermissionsController({
  automationPermissionsBtn,
  userScriptsNoticeEl,
  getAutomationEnabled: () => booleanSettings.getState().automationEnabled,
  flashStatus,
});

automationPermissionsBtn.addEventListener("click", () => {
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
    elements: settingsElements,
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

providerEl.addEventListener("change", () => {
  void (async () => {
    const stored = await loadSettings();
    await saveSettings({
      ...stored,
      providerApiKeys: {
        ...stored.providerApiKeys,
        [activeProvider]: providerApiKeyEl.value.trim(),
      },
      providerBaseUrls: {
        ...stored.providerBaseUrls,
        [activeProvider]: providerBaseUrlEl.value.trim(),
      },
    });
    const nextProvider = providerEl.value as typeof activeProvider;
    activeProvider = nextProvider;
    const refreshed = await loadSettings();
    providerApiKeyEl.value = refreshed.providerApiKeys[nextProvider] ?? "";
    providerBaseUrlEl.value = refreshed.providerBaseUrls[nextProvider] ?? "";
    scheduleAutoSave(0);
  })();
});

providerApiKeyEl.addEventListener("input", () => scheduleAutoSave(400));
providerBaseUrlEl.addEventListener("input", () => scheduleAutoSave(400));

const copyToken = () => copyTokenToClipboard({ tokenEl, flashStatus });

const refreshModelsIfStale = () => {
  modelPresets.refreshIfStale(tokenEl.value);
};

bindOptionsInputs({
  elements: {
    formEl,
    tokenEl,
    daemonPortEl,
    tokenCopyBtn,
    modelPresetEl,
    modelCustomEl,
    languagePresetEl,
    languageCustomEl,
    promptOverrideEl,
    hoverPromptEl,
    hoverPromptResetBtn,
    maxCharsEl,
    requestModeEl,
    firecrawlModeEl,
    markdownModeEl,
    preprocessModeEl,
    youtubeModeEl,
    transcriberEl,
    timeoutEl,
    retriesEl,
    maxOutputTokensEl,
    autoCliOrderEl,
    fontFamilyEl,
    fontSizeEl,
    logsSourceEl,
    logsTailEl,
    logsParsedEl,
    logsAutoEl,
    logsLevelInputs,
  },
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

applyBuildInfo(buildInfoEl, {
  injectedVersion:
    typeof __SUMMARIZE_VERSION__ === "string" && __SUMMARIZE_VERSION__ ? __SUMMARIZE_VERSION__ : "",
  manifestVersion: chrome?.runtime?.getManifest?.().version ?? "",
  gitHash: typeof __SUMMARIZE_GIT_HASH__ === "string" ? __SUMMARIZE_GIT_HASH__ : "",
});
void load();
