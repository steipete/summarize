import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  syncNavigationWithActiveTab,
  type PanelSource,
} from "../apps/chrome-extension/src/entrypoints/sidepanel/active-tab-sync.js";
import { createNavigationRuntime } from "../apps/chrome-extension/src/entrypoints/sidepanel/navigation-runtime.js";
import {
  createInitialPanelState,
  patchPanelState,
} from "../apps/chrome-extension/src/entrypoints/sidepanel/panel-state-store";

function createRuntime(options: { ttlMs?: number } = {}) {
  const store = createInitialPanelState();
  return createNavigationRuntime({
    getState: () => store.navigation,
    updateState: (value) => {
      patchPanelState(store, "navigation", value);
    },
    ...options,
  });
}

function createSyncHarness({
  currentSource = { url: "https://example.com/a", title: "A" },
  tab = null,
}: {
  currentSource?: PanelSource | null;
  tab?: { id?: number; url?: string; title?: string } | null;
} = {}) {
  const navigationRuntime = createRuntime();
  let source = currentSource;
  const resetForNavigation = vi.fn();
  const setBaseTitle = vi.fn();
  const sync = () =>
    syncNavigationWithActiveTab({
      navigationRuntime,
      getCurrentSource: () => source,
      setCurrentSource: (next) => {
        source = next;
      },
      resetForNavigation,
      setBaseTitle,
      queryActiveTab: vi.fn(async () => tab),
    });
  return {
    getCurrentSource: () => source,
    navigationRuntime,
    resetForNavigation,
    setBaseTitle,
    sync,
  };
}

describe("sidepanel navigation runtime", () => {
  beforeEach(() => {
    vi.useRealTimers();
  });

  it("preserves chat when the active tab matches a recent agent navigation", async () => {
    const harness = createSyncHarness({
      tab: { id: 2, url: "https://example.com/b", title: "B" },
    });
    harness.navigationRuntime.markAgentNavigationIntent("https://example.com/b");

    await harness.sync();

    expect(harness.getCurrentSource()).toBeNull();
    expect(harness.resetForNavigation).toHaveBeenCalledWith(true);
    expect(harness.setBaseTitle).toHaveBeenCalledWith("B");
    expect(harness.navigationRuntime.shouldPreserveChatForRun("https://example.com/b")).toBe(true);
  });

  it("updates the current title when the active tab stays on the same page", async () => {
    const harness = createSyncHarness({
      currentSource: { url: "https://example.com/a", title: "Old" },
      tab: { id: 1, url: "https://example.com/a#hash", title: "New" },
    });

    await harness.sync();

    expect(harness.getCurrentSource()).toEqual({
      url: "https://example.com/a",
      title: "New",
    });
    expect(harness.resetForNavigation).not.toHaveBeenCalled();
    expect(harness.setBaseTitle).toHaveBeenCalledWith("New");
  });

  it("ignores blank navigation intents and malformed results", () => {
    const runtime = createRuntime();

    runtime.markAgentNavigationIntent("   ");
    runtime.markAgentNavigationResult(null);
    runtime.markAgentNavigationResult({});

    expect(runtime.getLastAgentNavigationUrl()).toBeNull();
  });

  it("preserves chat for matching pending URLs only within ttl", () => {
    vi.useFakeTimers();
    const runtime = createRuntime({ ttlMs: 100 });

    runtime.notePreserveChatForUrl("https://example.com/next");
    expect(runtime.shouldPreserveChatForRun("https://example.com/next")).toBe(true);
    expect(runtime.shouldPreserveChatForRun("https://example.com/next")).toBe(false);

    runtime.notePreserveChatForUrl("https://example.com/later");
    vi.advanceTimersByTime(101);
    expect(runtime.shouldPreserveChatForRun("https://example.com/later")).toBe(false);
  });

  it("treats matching tab ids as recent agent navigation", () => {
    vi.useFakeTimers();
    const runtime = createRuntime({ ttlMs: 100 });

    runtime.markAgentNavigationResult({ finalUrl: "https://example.com/final", tabId: 7 });
    expect(runtime.isRecentAgentNavigation(7, null)).toBe(true);
    vi.advanceTimersByTime(101);
    expect(runtime.isRecentAgentNavigation(7, null)).toBe(false);
  });

  it("ignores unsupported active-tab schemes and missing current source", async () => {
    const missingSource = createSyncHarness({
      currentSource: null,
      tab: { url: "https://example.com/a", title: "A" },
    });
    const unsupported = createSyncHarness({
      tab: { url: "chrome://extensions", title: "Extensions" },
    });

    await missingSource.sync();
    await unsupported.sync();

    expect(missingSource.resetForNavigation).not.toHaveBeenCalled();
    expect(missingSource.setBaseTitle).not.toHaveBeenCalled();
    expect(unsupported.resetForNavigation).not.toHaveBeenCalled();
    expect(unsupported.setBaseTitle).not.toHaveBeenCalled();
  });

  it("falls back to non-preserved reset when there is no recent navigation", async () => {
    const harness = createSyncHarness({
      tab: { id: 2, url: "https://example.com/b", title: "" },
    });

    await harness.sync();

    expect(harness.getCurrentSource()).toBeNull();
    expect(harness.resetForNavigation).toHaveBeenCalledWith(false);
    expect(harness.setBaseTitle).toHaveBeenCalledWith("https://example.com/b");
  });

  it("swallows tab-query failures", async () => {
    const navigationRuntime = createRuntime();
    const resetForNavigation = vi.fn();

    await expect(
      syncNavigationWithActiveTab({
        navigationRuntime,
        getCurrentSource: () => ({ url: "https://example.com/a", title: "A" }),
        setCurrentSource: vi.fn(),
        resetForNavigation,
        setBaseTitle: vi.fn(),
        queryActiveTab: vi.fn(async () => {
          throw new Error("boom");
        }),
      }),
    ).resolves.toBeUndefined();
    expect(resetForNavigation).not.toHaveBeenCalled();
  });
});
