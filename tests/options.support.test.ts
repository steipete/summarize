import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../apps/chrome-extension/src/automation/userscripts.js", () => ({
  buildUserScriptsGuidance: vi.fn(() => "Enable User Scripts"),
  getUserScriptsStatus: vi.fn(async () => ({
    apiAvailable: false,
    permissionGranted: false,
    chromeVersion: 138,
  })),
}));

import {
  buildUserScriptsGuidance,
  getUserScriptsStatus,
} from "../apps/chrome-extension/src/automation/userscripts.js";
import {
  applyBuildInfo,
  copyTokenToClipboard,
  createAutomationPermissionsController,
  createStatusController,
  getOptionalAutomationPermissions,
  resolveBuildInfoText,
} from "../apps/chrome-extension/src/entrypoints/options/support.js";

function createFakeElement() {
  return {
    textContent: "",
    hidden: false,
    toggleAttribute(name: string, force?: boolean) {
      if (name === "hidden") this.hidden = Boolean(force);
    },
  } as unknown as HTMLElement;
}

function createFakeInput(value = "") {
  return {
    value,
    focus: vi.fn(),
    select: vi.fn(),
    setSelectionRange: vi.fn(),
  } as unknown as HTMLInputElement;
}

describe("options support", () => {
  beforeEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.stubGlobal("chrome", {});
    vi.stubGlobal("window", globalThis);
  });

  it("builds version text from injected or manifest values", () => {
    expect(
      resolveBuildInfoText({
        injectedVersion: "0.12.0",
        manifestVersion: "0.11.1",
        gitHash: "abc123",
      }),
    ).toBe("v0.12.0 · abc123");

    expect(
      resolveBuildInfoText({
        injectedVersion: "",
        manifestVersion: "0.11.1",
        gitHash: "unknown",
      }),
    ).toBe("v0.11.1");
  });

  it("applies build info text and hidden state", () => {
    const el = createFakeElement();
    applyBuildInfo(el, {
      injectedVersion: "",
      manifestVersion: "",
      gitHash: "unknown",
    });
    expect(el.textContent).toBe("");
    expect(el.hidden).toBe(true);

    applyBuildInfo(el, {
      injectedVersion: "0.12.0",
      manifestVersion: "0.11.1",
      gitHash: "abc123",
    });
    expect(el.textContent).toBe("v0.12.0 · abc123");
    expect(el.hidden).toBe(false);
  });

  it("sets and clears transient status text", () => {
    vi.useFakeTimers();
    const el = createFakeElement();
    const controller = createStatusController(el);

    controller.setStatus("Ready");
    expect(el.textContent).toBe("Ready");

    controller.flashStatus("Copied", 100);
    expect(el.textContent).toBe("Copied");
    vi.advanceTimersByTime(100);
    expect(el.textContent).toBe("");
  });

  it("keeps explicit status text from being cleared by an older flash timer", () => {
    vi.useFakeTimers();
    const el = createFakeElement();
    const controller = createStatusController(el);

    controller.flashStatus("Saved", 100);
    controller.setStatus("Save failed");
    vi.advanceTimersByTime(100);

    expect(el.textContent).toBe("Save failed");
  });

  it("copies token via clipboard when available", async () => {
    const tokenEl = createFakeInput("  abc123  ");
    const flashStatus = vi.fn();
    vi.stubGlobal("navigator", {
      clipboard: { writeText: vi.fn(async () => undefined) },
    });

    await copyTokenToClipboard({ tokenEl, flashStatus });

    expect(navigator.clipboard.writeText).toHaveBeenCalledWith("abc123");
    expect(flashStatus).toHaveBeenCalledWith("Token copied");
  });

  it("uses execCommand fallback when clipboard write fails", async () => {
    const tokenEl = createFakeInput("abc123");
    const flashStatus = vi.fn();
    vi.stubGlobal("navigator", {
      clipboard: { writeText: vi.fn(async () => Promise.reject(new Error("boom"))) },
    });
    const execCommand = vi.fn(() => true);
    vi.stubGlobal("document", {
      execCommand,
    });

    await copyTokenToClipboard({ tokenEl, flashStatus });

    expect(execCommand).toHaveBeenCalledWith("copy");
    expect(flashStatus).toHaveBeenCalledWith("Token copied");
  });

  it("reports empty or failed token copies", async () => {
    const emptyEl = createFakeInput("   ");
    const flashStatus = vi.fn();

    await copyTokenToClipboard({ tokenEl: emptyEl, flashStatus });
    expect(flashStatus).toHaveBeenCalledWith("Token empty");

    const tokenEl = createFakeInput("abc123");
    vi.stubGlobal("navigator", {
      clipboard: { writeText: vi.fn(async () => Promise.reject(new Error("boom"))) },
    });
    vi.stubGlobal("document", {
      execCommand: vi.fn(() => false),
    });

    await copyTokenToClipboard({ tokenEl, flashStatus });
    expect(flashStatus).toHaveBeenLastCalledWith("Copy failed");
  });

  it("uses only automation permissions declared optional by the browser build", () => {
    vi.stubGlobal("chrome", {
      runtime: {
        getManifest: () => ({ optional_permissions: ["nativeMessaging", "userScripts"] }),
      },
    });

    expect(getOptionalAutomationPermissions()).toEqual(["userScripts"]);
  });

  it("updates automation permissions ui for disabled and satisfied states", async () => {
    const automationPermissionsBtn = {
      disabled: false,
      textContent: "",
    } as HTMLButtonElement;
    const userScriptsNoticeEl = createFakeElement();
    const contains = vi
      .fn<(permissions: chrome.permissions.Permissions) => Promise<boolean>>()
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);
    vi.stubGlobal("chrome", {
      permissions: { contains, request: vi.fn(async () => true) },
      runtime: {
        getManifest: () => ({ optional_permissions: ["userScripts"] }),
      },
    });
    vi.mocked(getUserScriptsStatus).mockResolvedValueOnce({
      apiAvailable: false,
      permissionGranted: false,
      chromeVersion: 138,
    });

    const disabledController = createAutomationPermissionsController({
      automationPermissionsBtn,
      userScriptsNoticeEl,
      getAutomationEnabled: () => false,
      flashStatus: vi.fn(),
    });
    await disabledController.updateUi();
    expect(userScriptsNoticeEl.hidden).toBe(true);
    expect(automationPermissionsBtn.disabled).toBe(false);
    expect(automationPermissionsBtn.textContent).toBe("Enable automation permissions");

    vi.mocked(getUserScriptsStatus).mockResolvedValueOnce({
      apiAvailable: true,
      permissionGranted: true,
      chromeVersion: 138,
    });
    const enabledController = createAutomationPermissionsController({
      automationPermissionsBtn,
      userScriptsNoticeEl,
      getAutomationEnabled: () => true,
      flashStatus: vi.fn(),
    });
    await enabledController.updateUi();
    expect(userScriptsNoticeEl.hidden).toBe(true);
    expect(automationPermissionsBtn.disabled).toBe(true);
    expect(automationPermissionsBtn.textContent).toBe("Automation permissions granted");
  });

  it("shows guidance and handles denied automation permission requests", async () => {
    const automationPermissionsBtn = {
      disabled: false,
      textContent: "",
    } as HTMLButtonElement;
    const userScriptsNoticeEl = createFakeElement();
    const flashStatus = vi.fn();
    const request = vi.fn(async () => false);
    vi.stubGlobal("chrome", {
      permissions: { contains: vi.fn(async () => false), request },
      runtime: {
        getManifest: () => ({ optional_permissions: ["userScripts"] }),
      },
    });
    vi.mocked(getUserScriptsStatus)
      .mockResolvedValueOnce({
        apiAvailable: false,
        permissionGranted: false,
        chromeVersion: 138,
      })
      .mockResolvedValueOnce({
        apiAvailable: false,
        permissionGranted: false,
        chromeVersion: 138,
      });

    const controller = createAutomationPermissionsController({
      automationPermissionsBtn,
      userScriptsNoticeEl,
      getAutomationEnabled: () => true,
      flashStatus,
    });
    await controller.updateUi();
    expect(buildUserScriptsGuidance).toHaveBeenCalled();
    expect(userScriptsNoticeEl.hidden).toBe(false);
    expect(userScriptsNoticeEl.textContent).toBe("Enable User Scripts");

    await controller.requestPermissions();
    expect(request).toHaveBeenCalledWith({ permissions: ["userScripts"] });
    expect(flashStatus).toHaveBeenCalledWith("Permission request denied");
  });

  it("opens Chrome extension settings when the required permission needs its browser toggle", async () => {
    const automationPermissionsBtn = {
      disabled: false,
      textContent: "",
    } as HTMLButtonElement;
    const userScriptsNoticeEl = createFakeElement();
    const createTab = vi.fn(async () => undefined);
    const request = vi.fn(async () => true);
    vi.stubGlobal("chrome", {
      permissions: { contains: vi.fn(async () => true), request },
      runtime: {
        id: "extension-id",
        getManifest: () => ({ optional_permissions: ["userScripts"] }),
      },
      tabs: { create: createTab },
    });
    vi.mocked(getUserScriptsStatus)
      .mockResolvedValueOnce({
        apiAvailable: false,
        permissionGranted: true,
        chromeVersion: 138,
      })
      .mockResolvedValueOnce({
        apiAvailable: false,
        permissionGranted: true,
        chromeVersion: 138,
      });

    const controller = createAutomationPermissionsController({
      automationPermissionsBtn,
      userScriptsNoticeEl,
      getAutomationEnabled: () => true,
      flashStatus: vi.fn(),
    });
    await controller.updateUi();
    expect(automationPermissionsBtn.disabled).toBe(false);
    expect(automationPermissionsBtn.textContent).toBe("Open Chrome User Scripts settings");

    await controller.requestPermissions();
    expect(createTab).toHaveBeenCalledWith({
      url: "chrome://extensions/?id=extension-id",
    });
    expect(request).not.toHaveBeenCalled();
  });

  it("ignores permission requests when permissions api is missing or throws", async () => {
    const automationPermissionsBtn = {
      disabled: false,
      textContent: "",
    } as HTMLButtonElement;
    const userScriptsNoticeEl = createFakeElement();
    const flashStatus = vi.fn();

    vi.stubGlobal("chrome", {});
    const missingController = createAutomationPermissionsController({
      automationPermissionsBtn,
      userScriptsNoticeEl,
      getAutomationEnabled: () => true,
      flashStatus,
    });
    await missingController.requestPermissions();
    expect(flashStatus).not.toHaveBeenCalled();

    vi.stubGlobal("chrome", {
      permissions: {
        contains: vi.fn(async () => false),
        request: vi.fn(async () => {
          throw new Error("boom");
        }),
      },
      runtime: {
        getManifest: () => ({ optional_permissions: ["userScripts"] }),
      },
    });
    vi.mocked(getUserScriptsStatus).mockResolvedValueOnce({
      apiAvailable: false,
      permissionGranted: false,
      chromeVersion: 138,
    });
    const throwingController = createAutomationPermissionsController({
      automationPermissionsBtn,
      userScriptsNoticeEl,
      getAutomationEnabled: () => true,
      flashStatus,
    });
    await throwingController.requestPermissions();
    expect(flashStatus).not.toHaveBeenCalledWith("Permission request denied");
  });
});
