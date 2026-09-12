import { afterEach, describe, expect, it, vi } from "vitest";
import type { SidepanelDom } from "../apps/chrome-extension/src/entrypoints/sidepanel/dom";
import { createInitialPanelState } from "../apps/chrome-extension/src/entrypoints/sidepanel/panel-state-store";
import type { createSidepanelPresentationRuntime } from "../apps/chrome-extension/src/entrypoints/sidepanel/presentation-runtime";
import { createSidepanelSessionRuntime } from "../apps/chrome-extension/src/entrypoints/sidepanel/session-runtime";

const syncNavigationWithActiveTab = vi.hoisted(() => vi.fn(async () => {}));
const chatRuntime = vi.hoisted(() => ({
  clearHistoryForActiveTab: vi.fn(async () => {}),
  requestAbort: vi.fn(),
  reset: vi.fn(),
}));

vi.mock("../apps/chrome-extension/src/entrypoints/sidepanel/active-tab-sync", () => ({
  syncNavigationWithActiveTab,
}));

vi.mock("../apps/chrome-extension/src/entrypoints/sidepanel/chat-runtime", () => ({
  createSidepanelChatRuntime: vi.fn(() => chatRuntime),
}));

afterEach(() => {
  vi.clearAllMocks();
});

describe("sidepanel session runtime", () => {
  it("owns tab sync and coordinated view clearing", async () => {
    const store = createInitialPanelState();
    store.chat.streaming = true;
    const abortSummaryStream = vi.fn();
    const stopSlidesStream = vi.fn();
    const resetSummaryView = vi.fn();
    const scheduleSync = vi.fn();
    const setStatus = vi.fn();
    const setPhase = vi.fn();
    const presentationRuntime = {
      markdown: {},
      panelCacheController: {
        scheduleSync,
      },
      feedback: {
        errorController: {
          clearAll: vi.fn(),
          showInlineError: vi.fn(),
        },
        headerController: {
          setBaseSubtitle: vi.fn(),
          setBaseTitle: vi.fn(),
          setStatus,
        },
      },
      phase: {
        setPhase,
      },
      summary: {
        viewRuntime: {
          applyPanelCache: vi.fn(),
          resetSummaryView,
        },
      },
      slides: {
        renderInlineSlides: vi.fn(),
        runtime: {
          stopSlidesStream,
        },
      },
    } as unknown as ReturnType<typeof createSidepanelPresentationRuntime>;

    const runtime = createSidepanelSessionRuntime({
      dom: {} as SidepanelDom,
      panelState: store,

      metricsController: {
        clearForMode: vi.fn(),
        setActiveMode: vi.fn(),
      },
      presentationRuntime,
      send: vi.fn(async () => {}),
    });
    runtime.bindRunActions({ abortSummaryStream });

    await runtime.syncWithActiveTab();
    await runtime.clearCurrentView();

    expect(syncNavigationWithActiveTab).toHaveBeenCalledOnce();
    expect(chatRuntime.requestAbort).toHaveBeenCalledWith("Cleared");
    expect(abortSummaryStream).toHaveBeenCalledOnce();
    expect(stopSlidesStream).toHaveBeenCalledOnce();
    expect(chatRuntime.reset).toHaveBeenCalledOnce();
    expect(resetSummaryView).toHaveBeenCalledWith({
      clearRunId: undefined,
      stopSlides: undefined,
    });
    expect(chatRuntime.clearHistoryForActiveTab).toHaveBeenCalledOnce();
    expect(scheduleSync).toHaveBeenCalledOnce();
    expect(setStatus).toHaveBeenCalledWith("");
    expect(setPhase).toHaveBeenCalledWith("idle");
    expect(() => runtime.bindRunActions({ abortSummaryStream })).toThrow(
      "sidepanel session run actions already bound",
    );
  });
});
