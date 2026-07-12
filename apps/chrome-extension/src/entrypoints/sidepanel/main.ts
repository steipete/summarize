import type { BgToPanel } from "../../lib/panel-contracts";
import { defaultSettings, loadSettings, patchSettings } from "../../lib/settings";
import { generateToken } from "../../lib/token";
import { createAppearanceControls } from "./appearance-controls";
import { bindSidepanelUiEvents } from "./bindings";
import { bootstrapSidepanel } from "./bootstrap-runtime";
import { createDaemonHintRuntime } from "./daemon-hint-runtime";
import { createSidepanelDom } from "./dom";
import { createSidepanelInteractionRuntime } from "./interaction-runtime";
import { createMetricsController } from "./metrics-controller";
import { isPanelChatAvailable } from "./panel-capabilities";
import { createPanelMessagingRuntime } from "./panel-messaging";
import { createPanelStateStore } from "./panel-state-store";
import { createSidepanelPresentationRuntime } from "./presentation-runtime";
import { createSidepanelRunRuntime } from "./run-runtime";
import { createSidepanelSessionRuntime } from "./session-runtime";
import { createSetupControlsRuntime } from "./setup-controls-runtime";
import { friendlyFetchError } from "./setup-runtime";
import { createSidepanelStateEffectsRuntime } from "./state-effects-runtime";
import { registerSidepanelRuntimeTestHooks } from "./test-hooks-runtime";
import { createTypographyController } from "./typography-controller";

const dom = createSidepanelDom();
const {
  advancedBtn,
  advancedSettingsBodyEl,
  advancedSettingsEl,
  advancedSettingsSummaryEl,
  autoToggleRoot,
  chatInputEl,
  chatMetricsSlotEl,
  chatSendBtn,
  clearBtn,
  drawerEl,
  drawerToggleBtn,
  lengthRoot,
  lineLooseBtn,
  lineTightBtn,
  metricsEl,
  metricsHomeEl,
  modelCustomEl,
  modelPresetEl,
  modelRefreshBtn,
  modelRowEl,
  modelStatusEl,
  pickersRoot,
  refreshBtn,
  renderMarkdownHostEl,
  setupEl,
  sizeLgBtn,
  sizeSmBtn,
  slidesLayoutEl,
} = dom;

const metricsController = createMetricsController({
  metricsEl,
  metricsHomeEl,
  chatMetricsSlotEl,
});

const typographyController = createTypographyController({
  sizeSmBtn,
  sizeLgBtn,
  lineTightBtn,
  lineLooseBtn,
  defaultFontSize: defaultSettings.fontSize,
  defaultLineHeight: defaultSettings.lineHeight,
});

const panelStateStore = createPanelStateStore();
const panelState = panelStateStore.state;
const getActiveTabId = () => panelState.navigation.activeTabId;
const getActiveTabUrl = () => panelState.navigation.activeTabUrl;
const getPanelSession = () => panelState.panelSession;
const updatePanelSession = (value: Partial<typeof panelState.panelSession>) => {
  panelStateStore.dispatch({ type: "panel-session-update", value });
};

const panelMessagingRuntime = createPanelMessagingRuntime({
  panelState,
  dispatchPanelState: panelStateStore.dispatch,
  onMessage: (msg) => {
    handleBgMessage(msg);
  },
});
const { resolveLocalSlides, send } = panelMessagingRuntime;

const LINE_HEIGHT_STEP = 0.1;

const daemonHintRuntime = createDaemonHintRuntime({
  hintEl: dom.daemonHintEl,
  actionBtn: dom.daemonHintActionBtn,
  closeBtn: dom.daemonHintCloseBtn,
  patchSettings,
  openOptions: () => {
    void send({ type: "panel:openOptions", tab: "runtime" });
  },
});

const appearanceControls = createAppearanceControls({
  autoToggleRoot,
  pickersRoot,
  lengthRoot,
  patchSettings,
  sendSetAuto: (checked) => {
    updatePanelSession({ autoSummarize: checked });
    void send({ type: "panel:setAuto", value: checked });
  },
  sendSetLength: (value) => {
    void send({ type: "panel:setLength", value });
  },
  applyTypography: (fontFamily, fontSize, lineHeight) => {
    typographyController.apply(fontFamily, fontSize, lineHeight);
    typographyController.setCurrentFontSize(fontSize);
    typographyController.setCurrentLineHeight(lineHeight);
  },
});

const presentationRuntime = createSidepanelPresentationRuntime({
  dom,
  panelState,
  dispatchPanelState: panelStateStore.dispatch,
  appearanceControls,
  metricsController,
  resolveLocalSlides,
  send,
});
const {
  panelCacheController,
  feedback: { bindActions: bindFeedbackActions, errorController, headerController },
  summary: { sendSummarize },
  slides: { controlRuntime: summarizeControlRuntime, viewRuntime: slidesViewRuntime },
} = presentationRuntime;
const { renderMarkdownDisplay } = slidesViewRuntime;
const { applySlidesLayout, setSlidesLayout } = summarizeControlRuntime;

const sessionRuntime = createSidepanelSessionRuntime({
  dom,
  panelState,
  dispatchPanelState: panelStateStore.dispatch,
  metricsController,
  presentationRuntime,
  send,
});
const { bindRunActions, chatRuntime, clearCurrentView, navigationRuntime, syncWithActiveTab } =
  sessionRuntime;

const runRuntime = createSidepanelRunRuntime({
  panelState,
  dispatchPanelState: panelStateStore.dispatch,
  getActiveTabId,
  getActiveTabUrl,
  appearanceControls,
  chatRuntime,
  navigationRuntime,
  metricsController,
  headerController,
  panelCacheController,
  presentationRuntime,
  send,
  syncWithActiveTab,
});
const { autoSummarizeRuntime, streamController } = runRuntime;

bindRunActions({ abortSummaryStream: streamController.abort });

const setupControlsRuntime = createSetupControlsRuntime({
  advancedSettingsBodyEl,
  advancedSettingsEl,
  defaultModel: defaultSettings.model,
  drawerEl,
  drawerToggleBtn,
  friendlyFetchError,
  generateToken,
  getStatusResetText: () => panelState.ui?.status ?? "",
  headerSetStatus: (text) => {
    headerController.setStatus(text);
  },
  loadSettings,
  modelCustomEl,
  modelPresetEl,
  modelRefreshBtn,
  modelRowEl,
  modelStatusEl,
  patchSettings,
  setupEl,
});
const {
  drawerControls,
  readCurrentModelValue,
  refreshModelsIfStale,
  runRefreshFree,
  setDefaultModelPresets,
  setModelPlaceholderFromDiscovery,
  setModelValue,
  updateModelRowUI,
} = setupControlsRuntime;

const stateEffectsRuntime = createSidepanelStateEffectsRuntime({
  dom,
  panelState,
  dispatchPanelState: panelStateStore.dispatch,
  appearanceControls,
  typographyController,
  panelMessagingRuntime,
  presentationRuntime,
  runRuntime,
  sessionRuntime,
  setupControlsRuntime,
  daemonHintRuntime,
});

function handleBgMessage(msg: BgToPanel) {
  stateEffectsRuntime.handleBgMessage(msg);
}

registerSidepanelRuntimeTestHooks({
  dom,
  panelState,
  dispatchPanelState: panelStateStore.dispatch,
  presentationRuntime,
  runRuntime,
  stateEffectsRuntime,
});

const interactionRuntime = createSidepanelInteractionRuntime({
  chatEnabled: () => isPanelChatAvailable(panelState),
  getRawChatInput: () => chatInputEl.value,
  clearChatInput: () => {
    chatInputEl.value = "";
    chatInputEl.style.height = "auto";
  },
  restoreChatInput: (value) => {
    chatInputEl.value = value;
  },
  getChatInputScrollHeight: () => chatInputEl.scrollHeight,
  setChatInputHeight: (value) => {
    chatInputEl.style.height = value;
  },
  isChatStreaming: () => panelState.chat.streaming,
  getQueuedChatCount: chatRuntime.getQueueLength,
  enqueueChatMessage: chatRuntime.enqueueMessage,
  maybeSendQueuedChat: chatRuntime.maybeSendQueuedMessage,
  startChatMessage: chatRuntime.startMessage,
  typographyController,
  patchSettings,
  updateModelRowUI,
  isCustomModelHidden: () => modelCustomEl.hidden,
  focusCustomModel: () => {
    modelCustomEl.focus();
  },
  blurCustomModel: () => {
    modelCustomEl.blur();
  },
  readCurrentModelValue,
});
const { sendChatMessage, bumpFontSize, bumpLineHeight, persistCurrentModel } = interactionRuntime;

function retryLastAction() {
  if (getPanelSession().lastAction === "chat") {
    chatRuntime.retry();
    return;
  }
  sendSummarize({ refresh: true });
}

bindFeedbackActions(retryLastAction);

bindSidepanelUiEvents({
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
  lineHeightStep: LINE_HEIGHT_STEP,
  sendSummarize,
  clearCurrentView,
  toggleDrawer: () => drawerControls.toggleDrawer(),
  openOptions: () => send({ type: "panel:openOptions" }),
  toggleAdvancedSettings: drawerControls.toggleAdvancedSettings,
  sendChatMessage,
  bumpFontSize,
  bumpLineHeight,
  persistCurrentModel,
  setSlidesLayout: (next) => {
    setSlidesLayout(next);
    void (async () => {
      await patchSettings({ slidesLayout: next });
    })();
  },
  refreshModelsIfStale: () => {
    if (drawerControls.hasAdvancedSettingsAnimation() && advancedSettingsEl.open) return;
    refreshModelsIfStale();
  },
  runRefreshFree,
});

bootstrapSidepanel({
  ensurePanelPort: () => panelMessagingRuntime.ensure(),
  loadSettings,
  panelState,
  dispatchPanelState: panelStateStore.dispatch,
  typographyController,
  setSlidesLayoutInputValue: (value) => {
    slidesLayoutEl.value = value;
  },
  hideAutomationNotice: chatRuntime.hideAutomationNotice,
  appearanceControls,
  applyChatEnabled: chatRuntime.applyEnabled,
  applySlidesLayout,
  setDefaultModelPresets,
  setModelValue,
  setModelPlaceholderFromDiscovery,
  updateModelRowUI,
  setModelRefreshDisabled: (value) => {
    modelRefreshBtn.disabled = value;
  },
  toggleDrawerClosed: () => {
    drawerControls.toggleDrawer(false, { animate: false });
  },
  renderMarkdownDisplay,
  sendReady: () => {
    void send({ type: "panel:ready" });
  },
  scheduleAutoSummarize: autoSummarizeRuntime.schedule,
  sendPing: () => {
    void send({ type: "panel:ping" });
  },
  bindSidepanelLifecycle: {
    sendReady: () => {
      void send({ type: "panel:ready" });
    },
    sendClosed: () => {
      autoSummarizeRuntime.cancel();
      void send({ type: "panel:closed" });
    },
    scheduleAutoSummarize: autoSummarizeRuntime.schedule,
    syncWithActiveTab,
    clearInlineError: () => {
      errorController.clearInlineError();
    },
    sendSummarize,
  },
});
