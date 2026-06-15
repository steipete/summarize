import { beforeEach, describe, expect, it, vi } from "vitest";
import { createSetupControlsRuntime } from "../apps/chrome-extension/src/entrypoints/sidepanel/setup-controls-runtime";

const modelPresetsController = {
  isRefreshFreeRunning: vi.fn(() => false),
  readCurrentValue: vi.fn(() => "auto"),
  refreshIfStale: vi.fn(),
  refreshPresets: vi.fn(),
  runRefreshFree: vi.fn(),
  setDefaultPresets: vi.fn(),
  setPlaceholderFromDiscovery: vi.fn(),
  setStatus: vi.fn(),
  setValue: vi.fn(),
  updateRowUI: vi.fn(),
};
const drawerControls = { toggleDrawer: vi.fn(), toggleAdvancedSettings: vi.fn() };
let capturedSetupOptions: {
  ensureToken: () => Promise<string>;
  loadToken: () => Promise<string>;
} | null = null;

vi.mock("../apps/chrome-extension/src/entrypoints/sidepanel/model-presets", () => ({
  createModelPresetsController: vi.fn(() => modelPresetsController),
}));

vi.mock("../apps/chrome-extension/src/entrypoints/sidepanel/drawer-controls", () => ({
  createDrawerControls: vi.fn(() => drawerControls),
}));

vi.mock("../apps/chrome-extension/src/entrypoints/sidepanel/setup-runtime", () => ({
  createSetupRuntime: vi.fn((options) => {
    capturedSetupOptions = options;
    return { maybeShowSetup: vi.fn(() => "hidden") };
  }),
}));

function buildRuntime(loadToken = "token") {
  const loadSettings = vi.fn(async () => ({ token: loadToken }));
  const patchSettings = vi.fn(async () => ({}));
  const generateToken = vi.fn(() => "generated-token");

  const runtime = createSetupControlsRuntime({
    advancedSettingsBodyEl: {} as HTMLDivElement,
    advancedSettingsEl: {} as HTMLDetailsElement,
    defaultModel: "auto",
    drawerEl: {} as HTMLDivElement,
    drawerToggleBtn: {} as HTMLButtonElement,
    friendlyFetchError: vi.fn((_error, fallback) => fallback),
    generateToken,
    getStatusResetText: vi.fn(() => ""),
    headerSetStatus: vi.fn(),
    loadSettings,
    modelCustomEl: {} as HTMLInputElement,
    modelPresetEl: {} as HTMLSelectElement,
    modelRefreshBtn: {} as HTMLButtonElement,
    modelRowEl: {} as HTMLDivElement,
    modelStatusEl: {} as HTMLSpanElement,
    patchSettings,
    setupEl: {} as HTMLDivElement,
  });

  return { runtime, loadSettings, patchSettings, generateToken };
}

describe("sidepanel setup controls runtime", () => {
  beforeEach(() => {
    capturedSetupOptions = null;
    vi.clearAllMocks();
  });

  it("re-exports model and drawer helpers", () => {
    const { runtime } = buildRuntime("token");

    expect(runtime.drawerControls).toBe(drawerControls);
    expect(runtime.readCurrentModelValue()).toBe("auto");
    runtime.setModelValue("openai/gpt-5.4");
    expect(modelPresetsController.setValue).toHaveBeenCalledWith("openai/gpt-5.4");
  });

  it("reuses an existing token and only generates when missing", async () => {
    const existing = buildRuntime("existing-token");
    expect(await capturedSetupOptions?.ensureToken()).toBe("existing-token");
    expect(existing.patchSettings).not.toHaveBeenCalled();

    const missing = buildRuntime("");
    expect(await capturedSetupOptions?.ensureToken()).toBe("generated-token");
    expect(missing.generateToken).toHaveBeenCalledOnce();
    expect(missing.patchSettings).toHaveBeenCalledWith({ token: "generated-token" });
    expect(await capturedSetupOptions?.loadToken()).toBe("");
  });
});
