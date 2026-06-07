function byId<T extends HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) throw new Error(`Missing #${id}`);
  return el as T;
}

export function createSidepanelDom() {
  const subtitleEl = byId<HTMLDivElement>("subtitle");
  const titleEl = byId<HTMLDivElement>("title");
  const headerEl = document.querySelector("header") as HTMLElement | null;
  if (!headerEl) throw new Error("Missing <header>");
  const progressFillEl = byId<HTMLDivElement>("progressFill");
  const drawerEl = byId<HTMLElement>("drawer");
  const setupEl = byId<HTMLDivElement>("setup");
  const errorEl = byId<HTMLDivElement>("error");
  const errorMessageEl = byId<HTMLParagraphElement>("errorMessage");
  const errorRetryBtn = byId<HTMLButtonElement>("errorRetry");
  const errorLogsBtn = byId<HTMLButtonElement>("errorLogs");
  const slideNoticeEl = byId<HTMLDivElement>("slideNotice");
  const slideNoticeMessageEl = byId<HTMLSpanElement>("slideNoticeMessage");
  const slideNoticeRetryBtn = byId<HTMLButtonElement>("slideNoticeRetry");
  const renderEl = byId<HTMLElement>("render");
  const renderSlidesHostEl = document.createElement("div");
  renderSlidesHostEl.className = "render__slidesHost";
  const renderMarkdownHostEl = document.createElement("div");
  renderMarkdownHostEl.className = "render__markdownHost";
  renderEl.append(renderSlidesHostEl, renderMarkdownHostEl);
  const mainEl = document.querySelector("main") as HTMLElement | null;
  if (!mainEl) throw new Error("Missing <main>");
  const metricsEl = byId<HTMLDivElement>("metrics");
  const metricsHomeEl = byId<HTMLDivElement>("metricsHome");
  const chatMetricsSlotEl = byId<HTMLDivElement>("chatMetricsSlot");
  const chatDockEl = byId<HTMLDivElement>("chatDock");
  const summarizeControlRoot = byId<HTMLElement>("summarizeControlRoot");
  const summaryCopyBtn = byId<HTMLButtonElement>("summaryCopy");
  const drawerToggleBtn = byId<HTMLButtonElement>("drawerToggle");
  const refreshBtn = byId<HTMLButtonElement>("refresh");
  const clearBtn = byId<HTMLButtonElement>("clear");
  const advancedBtn = byId<HTMLButtonElement>("advanced");
  const autoToggleRoot = byId<HTMLDivElement>("autoToggle");
  const lengthRoot = byId<HTMLDivElement>("lengthRoot");
  const pickersRoot = byId<HTMLDivElement>("pickersRoot");
  const sizeSmBtn = byId<HTMLButtonElement>("sizeSm");
  const sizeLgBtn = byId<HTMLButtonElement>("sizeLg");
  const lineTightBtn = byId<HTMLButtonElement>("lineTight");
  const lineLooseBtn = byId<HTMLButtonElement>("lineLoose");
  const advancedSettingsEl = byId<HTMLDetailsElement>("advancedSettings");
  const advancedSettingsSummaryEl = advancedSettingsEl.querySelector("summary");
  if (!advancedSettingsSummaryEl) throw new Error("Missing advanced settings summary");
  const advancedSettingsBodyEl =
    advancedSettingsEl.querySelector<HTMLElement>(".drawerAdvancedBody");
  if (!advancedSettingsBodyEl) throw new Error("Missing advanced settings body");
  const modelPresetEl = byId<HTMLSelectElement>("modelPreset");
  const modelCustomEl = byId<HTMLInputElement>("modelCustom");
  const modelRefreshBtn = byId<HTMLButtonElement>("modelRefresh");
  const modelStatusEl = byId<HTMLDivElement>("modelStatus");
  const modelRowEl = byId<HTMLDivElement>("modelRow");
  const slidesLayoutEl = byId<HTMLSelectElement>("slidesLayout");
  const chatContainerEl = byId<HTMLElement>("chatContainer");
  const chatMessagesEl = byId<HTMLDivElement>("chatMessages");
  const chatInputEl = byId<HTMLTextAreaElement>("chatInput");
  const chatSendBtn = byId<HTMLButtonElement>("chatSend");
  const chatContextStatusEl = byId<HTMLDivElement>("chatContextStatus");
  const automationNoticeEl = byId<HTMLDivElement>("automationNotice");
  const automationNoticeTitleEl = byId<HTMLDivElement>("automationNoticeTitle");
  const automationNoticeMessageEl = byId<HTMLDivElement>("automationNoticeMessage");
  const automationNoticeActionBtn = byId<HTMLButtonElement>("automationNoticeAction");
  const chatJumpBtn = byId<HTMLButtonElement>("chatJump");
  const chatQueueEl = byId<HTMLDivElement>("chatQueue");
  const inlineErrorEl = byId<HTMLDivElement>("inlineError");
  const inlineErrorMessageEl = byId<HTMLDivElement>("inlineErrorMessage");
  const inlineErrorRetryBtn = byId<HTMLButtonElement>("inlineErrorRetry");
  const inlineErrorLogsBtn = byId<HTMLButtonElement>("inlineErrorLogs");
  const inlineErrorCloseBtn = byId<HTMLButtonElement>("inlineErrorClose");

  return {
    advancedBtn,
    advancedSettingsBodyEl,
    advancedSettingsEl,
    advancedSettingsSummaryEl,
    autoToggleRoot,
    automationNoticeActionBtn,
    automationNoticeEl,
    automationNoticeMessageEl,
    automationNoticeTitleEl,
    chatContainerEl,
    chatContextStatusEl,
    chatDockEl,
    chatInputEl,
    chatJumpBtn,
    chatMessagesEl,
    chatMetricsSlotEl,
    chatQueueEl,
    chatSendBtn,
    clearBtn,
    drawerEl,
    drawerToggleBtn,
    errorEl,
    errorLogsBtn,
    errorMessageEl,
    errorRetryBtn,
    headerEl,
    inlineErrorCloseBtn,
    inlineErrorEl,
    inlineErrorLogsBtn,
    inlineErrorMessageEl,
    inlineErrorRetryBtn,
    lengthRoot,
    lineLooseBtn,
    lineTightBtn,
    mainEl,
    metricsEl,
    metricsHomeEl,
    modelCustomEl,
    modelPresetEl,
    modelRefreshBtn,
    modelRowEl,
    modelStatusEl,
    pickersRoot,
    progressFillEl,
    refreshBtn,
    renderEl,
    renderMarkdownHostEl,
    renderSlidesHostEl,
    setupEl,
    sizeLgBtn,
    sizeSmBtn,
    slideNoticeEl,
    slideNoticeMessageEl,
    slideNoticeRetryBtn,
    slidesLayoutEl,
    subtitleEl,
    summarizeControlRoot,
    summaryCopyBtn,
    titleEl,
  };
}
