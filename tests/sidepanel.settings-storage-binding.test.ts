import { beforeEach, describe, expect, it, vi } from "vitest";
import { bindSettingsStorage } from "../apps/chrome-extension/src/entrypoints/sidepanel/bindings";
import {
  createInitialPanelState,
  createPanelStateStore,
} from "../apps/chrome-extension/src/entrypoints/sidepanel/panel-state-store";

describe("sidepanel settings storage binding", () => {
  let onChanged: (changes: Record<string, chrome.storage.StorageChange>, areaName: string) => void;

  beforeEach(() => {
    vi.stubGlobal("chrome", {
      storage: {
        onChanged: {
          addListener: vi.fn((listener) => {
            onChanged = listener;
          }),
        },
      },
    });
  });

  it("merges pre-hydration settings while applying live controls", () => {
    const initialState = createInitialPanelState();
    initialState.panelSession.pendingSettingsSnapshot = { autoSummarize: true };
    const panelStateStore = createPanelStateStore(initialState);
    const applyChatEnabled = vi.fn();
    const hideAutomationNotice = vi.fn();

    bindSettingsStorage({
      panelState: panelStateStore.state,
      dispatchPanelState: panelStateStore.dispatch,
      applyChatEnabled,
      applyLocale: vi.fn(),
      hideAutomationNotice,
    });

    onChanged(
      {
        settings: {
          newValue: {
            chatEnabled: false,
            automationEnabled: false,
          },
        },
      },
      "local",
    );

    expect(panelStateStore.state.panelSession).toMatchObject({
      chatEnabled: false,
      automationEnabled: false,
      pendingSettingsSnapshot: {
        autoSummarize: true,
        chatEnabled: false,
        automationEnabled: false,
      },
    });
    expect(applyChatEnabled).toHaveBeenCalledOnce();
    expect(hideAutomationNotice).toHaveBeenCalledOnce();
  });

  it("does not queue settings after hydration", () => {
    const initialState = createInitialPanelState();
    initialState.panelSession.settingsHydrated = true;
    const panelStateStore = createPanelStateStore(initialState);

    bindSettingsStorage({
      panelState: panelStateStore.state,
      dispatchPanelState: panelStateStore.dispatch,
      applyChatEnabled: vi.fn(),
      applyLocale: vi.fn(),
      hideAutomationNotice: vi.fn(),
    });

    onChanged(
      {
        settings: {
          newValue: { chatEnabled: true },
        },
      },
      "local",
    );

    expect(panelStateStore.state.panelSession.pendingSettingsSnapshot).toBeNull();
    expect(panelStateStore.state.panelSession.chatEnabled).toBe(true);
  });

  it("applies locale changes to an already hydrated panel without reapplying unchanged settings", () => {
    const panelState = createInitialPanelState();
    panelState.panelSession.settingsHydrated = true;
    const applyLocale = vi.fn();
    bindSettingsStorage({
      panelState,
      applyChatEnabled: vi.fn(),
      applyLocale,
      hideAutomationNotice: vi.fn(),
    });

    onChanged(
      { settings: { oldValue: { uiLocale: "en" }, newValue: { uiLocale: "tr" } } },
      "local",
    );
    expect(applyLocale).toHaveBeenLastCalledWith("tr");
    onChanged(
      { settings: { oldValue: { uiLocale: "tr" }, newValue: { uiLocale: "en" } } },
      "local",
    );
    expect(applyLocale).toHaveBeenLastCalledWith("en");
    onChanged(
      { settings: { oldValue: { uiLocale: "en" }, newValue: { uiLocale: "en", model: "other" } } },
      "local",
    );
    onChanged({ settings: { newValue: { uiLocale: "fr" } } }, "local");
    onChanged({ settings: { newValue: { uiLocale: "tr" } } }, "session");
    expect(applyLocale).toHaveBeenCalledTimes(2);
  });
});
