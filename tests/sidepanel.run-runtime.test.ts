import { afterEach, describe, expect, it, vi } from "vitest";
import {
  applyPanelStateAction,
  createInitialPanelState,
} from "../apps/chrome-extension/src/entrypoints/sidepanel/panel-state-store";
import { createSidepanelRunRuntime } from "../apps/chrome-extension/src/entrypoints/sidepanel/run-runtime";
import type { RunStart } from "../apps/chrome-extension/src/entrypoints/sidepanel/types";

const streamController = vi.hoisted(() => ({
  abort: vi.fn(),
  isStreaming: vi.fn(() => false),
  start: vi.fn(async () => {}),
}));

vi.mock("../apps/chrome-extension/src/entrypoints/sidepanel/stream-controller", () => ({
  createStreamController: vi.fn(() => streamController),
}));

afterEach(() => {
  vi.clearAllMocks();
  vi.useRealTimers();
});

describe("sidepanel run runtime", () => {
  it("wires summary attachment, slide planning, and auto-summarize", async () => {
    vi.useFakeTimers();
    const panelState = createInitialPanelState();
    panelState.navigation.activeTabId = 7;
    panelState.navigation.activeTabUrl = "https://example.com/video";
    panelState.panelSession.autoSummarize = true;
    panelState.slidesSession.slidesEnabled = true;
    panelState.slidesSession.inputMode = "video";
    panelState.slidesSession.summarizeVideoDurationSeconds = 900;
    const sendSummarize = vi.fn();
    const stopSlidesStream = vi.fn();
    const queueSlidesRender = vi.fn();
    const chatReset = vi.fn();
    const run: RunStart = {
      id: "run-1",
      url: "https://example.com/video",
      title: "Video",
      model: "openai/gpt-5.4",
      reason: "manual",
      slides: false,
    };

    const runtime = createSidepanelRunRuntime({
      panelState,
      dispatchPanelState: (action) => applyPanelStateAction(panelState, action),
      getActiveTabId: () => panelState.navigation.activeTabId,
      getActiveTabUrl: () => panelState.navigation.activeTabUrl,
      appearanceControls: {
        getLengthValue: () => "medium",
      },
      chatRuntime: {
        clearHistoryForActiveTab: vi.fn(async () => {}),
        finishStreamingMessage: vi.fn(),
        reset: chatReset,
      },
      navigationRuntime: {
        shouldPreserveChatForRun: () => false,
      },
      metricsController: {
        setActiveMode: vi.fn(),
        setForMode: vi.fn(),
      },
      headerController: {
        armProgress: vi.fn(),
        setBaseSubtitle: vi.fn(),
        setBaseTitle: vi.fn(),
        setProgressOverride: vi.fn(),
        setStatus: vi.fn(),
        stopProgress: vi.fn(),
        updateHeaderOffset: vi.fn(),
      },
      panelCacheController: {
        clear: vi.fn(),
        consumeResponse: vi.fn(() => null),
        request: vi.fn(),
        resolve: vi.fn(() => null),
        scheduleSync: vi.fn(),
        syncNow: vi.fn(),
      },
      presentationRuntime: {
        isStreaming: () => false,
        phase: {
          setPhase: vi.fn(),
        },
        summary: {
          browserAiRuntime: {
            cancel: vi.fn(),
            destroy: vi.fn(),
            prepare: vi.fn(),
            summarize: vi.fn(async () => null),
          },
          renderMarkdown: vi.fn(),
          sendSummarize,
          viewRuntime: {
            resetSummaryView: vi.fn(),
          },
        },
        slides: {
          runtime: {
            maybeApplyPendingSlidesSummary: vi.fn(),
            slidesHydrator: {
              handlePayload: vi.fn(),
              handleSummaryFromCache: vi.fn(),
            },
            startSlidesStream: vi.fn(),
            stopSlidesStream,
          },
          setSlidesTranscriptTimedText: vi.fn(),
          textController: {
            hasSummaryTitles: vi.fn(() => false),
          },
          viewRuntime: {
            queueSlidesRender,
            rebuildSlideDescriptions: vi.fn(),
            renderMarkdownDisplay: vi.fn(),
            setSlidesBusy: vi.fn(),
            updateSlidesTextState: vi.fn(),
          },
        },
      } as unknown as Parameters<typeof createSidepanelRunRuntime>[0]["presentationRuntime"],
      send: vi.fn(async () => {}),
      syncWithActiveTab: vi.fn(async () => {}),
    });

    runtime.summaryRunRuntime.attachRun(run);

    expect(stopSlidesStream).toHaveBeenCalledOnce();
    expect(chatReset).toHaveBeenCalledOnce();
    expect(streamController.start).toHaveBeenCalledWith(run);
    expect(panelState.runId).toBe(run.id);

    expect(runtime.plannedSlidesRuntime.seedForRun({ ...run, slides: true })).toBe(true);
    expect(panelState.slides?.slides.length).toBe(3);
    expect(queueSlidesRender).toHaveBeenCalledOnce();

    panelState.phase = "idle";
    panelState.summaryMarkdown = null;
    runtime.autoSummarizeRuntime.schedule();
    await vi.advanceTimersByTimeAsync(350);

    expect(sendSummarize).toHaveBeenCalledOnce();
  });
});
