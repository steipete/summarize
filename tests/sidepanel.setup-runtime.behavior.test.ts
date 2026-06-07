import { beforeEach, describe, expect, it, vi } from "vitest";
import type { UiState } from "../apps/chrome-extension/src/entrypoints/sidepanel/types";

const setupViewMocks = vi.hoisted(() => ({
  installStepsHtml: vi.fn(
    ({
      token,
      headline,
      message,
      showTroubleshooting,
    }: {
      token: string;
      headline: string;
      message?: string;
      showTroubleshooting?: boolean;
    }) =>
      `headline=${headline};token=${token};message=${message ?? ""};troubleshooting=${
        showTroubleshooting ? "yes" : "no"
      }`,
  ),
  wireSetupButtons: vi.fn(),
}));

vi.mock("../apps/chrome-extension/src/entrypoints/sidepanel/setup-view", () => ({
  installStepsHtml: setupViewMocks.installStepsHtml,
  wireSetupButtons: setupViewMocks.wireSetupButtons,
}));

import {
  createSetupRuntime,
  friendlyFetchError,
} from "../apps/chrome-extension/src/entrypoints/sidepanel/setup-runtime";

function stubNavigator(value: Partial<Navigator> & { userAgentData?: { platform?: string } }) {
  vi.stubGlobal("navigator", value);
}

function flushPromises() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function makeUiState(overrides?: Partial<UiState>): UiState {
  return {
    panelOpen: true,
    daemon: { ok: true, authed: true },
    tab: { id: 1, url: "https://example.com", title: "Example" },
    media: null,
    stats: { pageWords: 10, videoDurationSeconds: null },
    settings: {
      autoSummarize: true,
      hoverSummaries: false,
      chatEnabled: true,
      automationEnabled: false,
      slidesEnabled: true,
      slidesParallel: false,
      slidesOcrEnabled: false,
      slidesLayout: "strip",
      slideRuntime: "browser",
      fontSize: 15,
      lineHeight: 1.6,
      model: "auto",
      length: "medium",
      tokenPresent: true,
    },
    status: "Ready",
    ...overrides,
  };
}

function makeSetupEl() {
  return {
    innerHTML: "",
    classList: {
      add: vi.fn(),
      remove: vi.fn(),
    },
  } as unknown as HTMLDivElement;
}

describe("sidepanel setup runtime behavior", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllGlobals();
    stubNavigator({
      platform: "MacIntel",
      userAgent: "Mozilla/5.0",
      userAgentData: { platform: "macOS" },
    } as Navigator & { userAgentData: { platform: string } });
  });

  it("formats failed fetch guidance with daemon troubleshooting help", () => {
    expect(friendlyFetchError(new Error("Failed to fetch"), "Connect")).toContain(
      "daemon unreachable or blocked by Chrome",
    );
  });

  it("formats non-fetch errors directly", () => {
    expect(friendlyFetchError(new Error("boom"), "Connect")).toBe("Connect: boom");
  });

  it("renders setup immediately when the token is missing", async () => {
    const setupEl = makeSetupEl();
    const ensureToken = vi.fn(async () => "fresh-token");
    const loadToken = vi.fn(async () => "unused-token");

    const runtime = createSetupRuntime({
      setupEl,
      ensureToken,
      loadToken,
      patchSettings: vi.fn() as never,
      generateToken: vi.fn() as never,
      headerSetStatus: vi.fn(),
      getStatusResetText: vi.fn(() => "Ready"),
    });

    expect(
      runtime.maybeShowSetup(
        makeUiState({
          settings: { ...makeUiState().settings, slideRuntime: "daemon", tokenPresent: false },
        }),
      ),
    ).toBe(true);

    await flushPromises();

    expect(ensureToken).toHaveBeenCalledOnce();
    expect(setupEl.classList.remove).toHaveBeenCalledWith("hidden");
    expect(setupViewMocks.installStepsHtml).toHaveBeenCalledWith(
      expect.objectContaining({
        token: "fresh-token",
        headline: "Setup",
      }),
    );
    expect(setupViewMocks.wireSetupButtons).toHaveBeenCalledWith(
      expect.objectContaining({
        setupEl,
        token: "fresh-token",
        platformKind: "mac",
      }),
    );
  });

  it("renders troubleshooting setup when the daemon is not reachable", async () => {
    const setupEl = makeSetupEl();
    const loadToken = vi.fn(async () => "saved-token");

    const runtime = createSetupRuntime({
      setupEl,
      ensureToken: vi.fn(async () => "unused-token"),
      loadToken,
      patchSettings: vi.fn() as never,
      generateToken: vi.fn() as never,
      headerSetStatus: vi.fn(),
      getStatusResetText: vi.fn(() => "Ready"),
    });

    expect(
      runtime.maybeShowSetup(
        makeUiState({
          daemon: { ok: false, authed: false },
          settings: { ...makeUiState().settings, slideRuntime: "daemon" },
        }),
      ),
    ).toBe(true);

    await flushPromises();

    expect(loadToken).toHaveBeenCalledOnce();
    expect(setupEl.classList.remove).toHaveBeenCalledWith("hidden");
    expect(setupEl.innerHTML).toContain("headline=Daemon not reachable");
    expect(setupEl.innerHTML).toContain("Check that the LaunchAgent is installed.");
    expect(setupViewMocks.installStepsHtml).toHaveBeenCalledWith(
      expect.objectContaining({
        token: "saved-token",
        headline: "Daemon not reachable",
        showTroubleshooting: true,
      }),
    );
  });

  it("hides setup when the daemon is healthy and authed", () => {
    const setupEl = makeSetupEl();

    const runtime = createSetupRuntime({
      setupEl,
      ensureToken: vi.fn(async () => "unused-token"),
      loadToken: vi.fn(async () => "unused-token"),
      patchSettings: vi.fn() as never,
      generateToken: vi.fn() as never,
      headerSetStatus: vi.fn(),
      getStatusResetText: vi.fn(() => "Ready"),
    });

    expect(runtime.maybeShowSetup(makeUiState())).toBe(false);
    expect(setupEl.classList.add).toHaveBeenCalledWith("hidden");
  });

  it("hides setup in browser runtime even when chat is enabled", async () => {
    const setupEl = makeSetupEl();
    const ensureToken = vi.fn(async () => "fresh-token");
    const loadToken = vi.fn(async () => "unused-token");

    const runtime = createSetupRuntime({
      setupEl,
      ensureToken,
      loadToken,
      patchSettings: vi.fn() as never,
      generateToken: vi.fn() as never,
      headerSetStatus: vi.fn(),
      getStatusResetText: vi.fn(() => "Ready"),
    });

    expect(
      runtime.maybeShowSetup(
        makeUiState({
          daemon: { ok: false, authed: false },
          settings: { ...makeUiState().settings, slideRuntime: "browser", tokenPresent: false },
        }),
      ),
    ).toBe(false);
    await flushPromises();
    expect(setupEl.classList.add).toHaveBeenCalledWith("hidden");
    expect(ensureToken).not.toHaveBeenCalled();
    expect(loadToken).not.toHaveBeenCalled();
  });

  it("hides setup in browser runtime when daemon-backed chat is disabled", () => {
    const setupEl = makeSetupEl();
    const ensureToken = vi.fn(async () => "unused-token");
    const loadToken = vi.fn(async () => "unused-token");

    const runtime = createSetupRuntime({
      setupEl,
      ensureToken,
      loadToken,
      patchSettings: vi.fn() as never,
      generateToken: vi.fn() as never,
      headerSetStatus: vi.fn(),
      getStatusResetText: vi.fn(() => "Ready"),
    });

    expect(
      runtime.maybeShowSetup(
        makeUiState({
          daemon: { ok: false, authed: false },
          settings: {
            ...makeUiState().settings,
            chatEnabled: false,
            slideRuntime: "browser",
            tokenPresent: false,
          },
        }),
      ),
    ).toBe(false);
    expect(setupEl.classList.add).toHaveBeenCalledWith("hidden");
    expect(ensureToken).not.toHaveBeenCalled();
    expect(loadToken).not.toHaveBeenCalled();
  });
});
