import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createInitialPanelState } from "../apps/chrome-extension/src/entrypoints/sidepanel/panel-state-store";

const bindingSpies = vi.hoisted(() => ({
  bindSettingsStorage: vi.fn(),
  bindSidepanelLifecycle: vi.fn(),
}));

vi.mock("../apps/chrome-extension/src/entrypoints/sidepanel/bindings", () => ({
  bindSettingsStorage: bindingSpies.bindSettingsStorage,
  bindSidepanelLifecycle: bindingSpies.bindSidepanelLifecycle,
}));

import { bootstrapSidepanel } from "../apps/chrome-extension/src/entrypoints/sidepanel/bootstrap-runtime";

describe("sidepanel bootstrap runtime", () => {
  beforeEach(() => {
    bindingSpies.bindSettingsStorage.mockReset();
    bindingSpies.bindSidepanelLifecycle.mockReset();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("hydrates settings, binds lifecycle, and pings", async () => {
    const calls: string[] = [];
    const initialState = createInitialPanelState();
    initialState.panelSession.pendingSettingsSnapshot = { chatEnabled: true };
    const panelStateStore = initialState;
    const loadedSettings = {
      autoSummarize: true,
      chatEnabled: false,
      automationEnabled: false,
      slidesLayout: "gallery",
      fontSize: 16,
      lineHeight: 1.6,
      fontFamily: "IBM Plex Sans",
      model: "openai/gpt-5.4",
      token: "",
    };

    bootstrapSidepanel({
      ensurePanelPort: async () => {
        calls.push("ensure");
      },
      loadSettings: async () => loadedSettings,
      panelState: panelStateStore,

      typographyController: {
        setCurrentFontSize: (value) => calls.push(`font:${value}`),
        setCurrentLineHeight: (value) => calls.push(`line:${value}`),
      },
      setSlidesLayoutInputValue: (value) => calls.push(`layout-input:${value}`),
      hideAutomationNotice: () => calls.push("hide-automation"),
      appearanceControls: {
        setAutoValue: (value) => calls.push(`appearance-auto:${value}`),
        initializeFromSettings: (settings) => calls.push(`init:${settings.model}`),
      },
      applyChatEnabled: () => calls.push("apply-chat"),
      applySlidesLayout: () => calls.push("apply-layout"),
      setDefaultModelPresets: () => calls.push("defaults"),
      setModelValue: (value) => calls.push(`model:${value}`),
      setModelPlaceholderFromDiscovery: () => calls.push("placeholder"),
      updateModelRowUI: () => calls.push("model-row"),
      setModelRefreshDisabled: (value) => calls.push(`model-disabled:${value}`),
      toggleDrawerClosed: () => calls.push("drawer"),
      renderMarkdownDisplay: () => calls.push("render"),
      sendReady: () => calls.push("ready"),
      scheduleAutoSummarize: () => calls.push("auto-kick"),
      sendPing: () => calls.push("ping"),
      bindSidepanelLifecycle: { sendReady: () => {} } as never,
    });

    await vi.advanceTimersByTimeAsync(25_000);

    expect(bindingSpies.bindSettingsStorage).toHaveBeenCalledTimes(1);
    expect(bindingSpies.bindSidepanelLifecycle).toHaveBeenCalledTimes(1);
    expect(calls).toContain("hide-automation");
    expect(calls).toContain("model-disabled:true");
    expect(calls).toContain("ready");
    expect(calls).toContain("ping");
    expect(panelStateStore.panelSession).toMatchObject({
      autoSummarize: true,
      chatEnabled: true,
      automationEnabled: false,
      settingsHydrated: true,
      pendingSettingsSnapshot: null,
    });
    expect(panelStateStore.slidesSession.slidesLayout).toBe("gallery");
  });

  it("uses loaded settings directly when there is no pending snapshot", async () => {
    const calls: string[] = [];
    const panelStateStore = createInitialPanelState();

    bootstrapSidepanel({
      ensurePanelPort: async () => {
        calls.push("ensure");
      },
      loadSettings: async () => ({
        autoSummarize: false,
        chatEnabled: true,
        automationEnabled: true,
        slidesLayout: "strip",
        fontSize: 14,
        lineHeight: 1.4,
        fontFamily: "Skolar",
        model: "openai/gpt-5.4",
        token: "abc123",
      }),
      panelState: panelStateStore,

      typographyController: {
        setCurrentFontSize: (value) => calls.push(`font:${value}`),
        setCurrentLineHeight: (value) => calls.push(`line:${value}`),
      },
      setSlidesLayoutInputValue: (value) => calls.push(`layout-input:${value}`),
      hideAutomationNotice: () => calls.push("hide-automation"),
      appearanceControls: {
        setAutoValue: (value) => calls.push(`appearance-auto:${value}`),
        initializeFromSettings: (settings) => calls.push(`init:${settings.slidesLayout}`),
      },
      applyChatEnabled: () => calls.push("apply-chat"),
      applySlidesLayout: () => calls.push("apply-layout"),
      setDefaultModelPresets: () => calls.push("defaults"),
      setModelValue: (value) => calls.push(`model:${value}`),
      setModelPlaceholderFromDiscovery: () => calls.push("placeholder"),
      updateModelRowUI: () => calls.push("model-row"),
      setModelRefreshDisabled: (value) => calls.push(`model-disabled:${value}`),
      toggleDrawerClosed: () => calls.push("drawer"),
      renderMarkdownDisplay: () => calls.push("render"),
      sendReady: () => calls.push("ready"),
      scheduleAutoSummarize: () => calls.push("auto-kick"),
      sendPing: () => calls.push("ping"),
      bindSidepanelLifecycle: { sendReady: () => {} } as never,
    });

    await vi.advanceTimersByTimeAsync(25_000);

    expect(calls).not.toContain("hide-automation");
    expect(calls).toContain("model-disabled:false");
    expect(panelStateStore.panelSession).toMatchObject({
      autoSummarize: false,
      chatEnabled: true,
      automationEnabled: true,
      settingsHydrated: true,
      pendingSettingsSnapshot: null,
    });
    expect(panelStateStore.slidesSession.slidesLayout).toBe("strip");
  });
});
