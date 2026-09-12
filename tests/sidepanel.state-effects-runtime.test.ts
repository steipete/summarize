import { afterEach, describe, expect, it, vi } from "vitest";
import type { createSidepanelBgMessageRuntime } from "../apps/chrome-extension/src/entrypoints/sidepanel/bg-message-runtime";
import type { SidepanelDom } from "../apps/chrome-extension/src/entrypoints/sidepanel/dom";
import { createInitialPanelState } from "../apps/chrome-extension/src/entrypoints/sidepanel/panel-state-store";
import type { createSidepanelPresentationRuntime } from "../apps/chrome-extension/src/entrypoints/sidepanel/presentation-runtime";
import type { createSidepanelRunRuntime } from "../apps/chrome-extension/src/entrypoints/sidepanel/run-runtime";
import type { createSidepanelSessionRuntime } from "../apps/chrome-extension/src/entrypoints/sidepanel/session-runtime";
import { createSidepanelStateEffectsRuntime } from "../apps/chrome-extension/src/entrypoints/sidepanel/state-effects-runtime";
import type { createUiStateRuntime } from "../apps/chrome-extension/src/entrypoints/sidepanel/ui-state-runtime";

let uiStateOptions: Parameters<typeof createUiStateRuntime>[0] | null = null;
let bgMessageOptions: Parameters<typeof createSidepanelBgMessageRuntime>[0] | null = null;
const applyUiState = vi.fn();
const handleBgMessage = vi.fn();

vi.mock("../apps/chrome-extension/src/entrypoints/sidepanel/ui-state-runtime", () => ({
  createUiStateRuntime: vi.fn((options) => {
    uiStateOptions = options;
    return { apply: applyUiState };
  }),
}));

vi.mock("../apps/chrome-extension/src/entrypoints/sidepanel/bg-message-runtime", () => ({
  createSidepanelBgMessageRuntime: vi.fn((options) => {
    bgMessageOptions = options;
    return { handle: handleBgMessage };
  }),
}));

afterEach(() => {
  uiStateOptions = null;
  bgMessageOptions = null;
  vi.clearAllMocks();
});

describe("sidepanel state effects runtime", () => {
  it("wires UI state and background messages through subsystem ports", () => {
    const store = createInitialPanelState();
    const send = vi.fn(async () => {});
    const renderInlineSlides = vi.fn();
    const startSlidesSummaryStreamForRunId = vi.fn();
    const setSlidesLayout = vi.fn();
    const applyPanelCache = vi.fn();
    const updateDaemonHint = vi.fn();
    const renderMarkdownHostEl = {} as HTMLElement;
    const runtime = createSidepanelStateEffectsRuntime({
      dom: {
        modelRefreshBtn: { disabled: false },
        renderMarkdownHostEl,
      } as SidepanelDom,
      panelState: store,

      appearanceControls: {} as Parameters<
        typeof createSidepanelStateEffectsRuntime
      >[0]["appearanceControls"],
      typographyController: {} as Parameters<
        typeof createSidepanelStateEffectsRuntime
      >[0]["typographyController"],
      panelMessagingRuntime: {
        handleLocalSlidesResponse: vi.fn(),
        send,
      } as unknown as Parameters<
        typeof createSidepanelStateEffectsRuntime
      >[0]["panelMessagingRuntime"],
      presentationRuntime: {
        isStreaming: vi.fn(() => false),
        panelCacheController: {
          clear: vi.fn(),
          consumeResponse: vi.fn(),
          scheduleSync: vi.fn(),
        },
        feedback: {
          errorController: {
            clearInlineError: vi.fn(),
          },
          headerController: {
            setStatus: vi.fn(),
          },
          hideSlideNotice: vi.fn(),
          showSlideNotice: vi.fn(),
        },
        phase: {
          setPhase: vi.fn(),
        },
        slides: {
          controlRuntime: {
            setSlidesLayout,
          },
          refreshSummarizeControl: vi.fn(),
          renderInlineSlides,
          runtime: {
            maybeApplyPendingSlidesSummary: vi.fn(),
            maybeStartPendingSlidesForUrl: vi.fn(),
            rememberPendingSlidesRun: vi.fn(),
            resolveActiveSlidesRunId: vi.fn(),
            startSlidesStreamForRunId: vi.fn(),
            startSlidesSummaryStreamForRunId,
          },
          setSlidesTranscriptTimedText: vi.fn(),
          updateSlideSummaryFromMarkdown: vi.fn(),
          viewRuntime: {
            rebuildSlideDescriptions: vi.fn(),
            renderMarkdownDisplay: vi.fn(),
            setSlidesBusy: vi.fn(),
            updateSlidesTextState: vi.fn(),
          },
        },
      } as unknown as ReturnType<typeof createSidepanelPresentationRuntime>,
      runRuntime: {
        plannedSlidesRuntime: {
          maybeSeedPendingRun: vi.fn(),
        },
        streamController: {
          abort: vi.fn(),
        },
        summaryRunRuntime: {
          applySnapshot: vi.fn(),
          attachRun: vi.fn(),
          maybeStartPendingForUrl: vi.fn(),
          rememberPendingRun: vi.fn(),
          rememberPendingSnapshot: vi.fn(),
        },
      } as unknown as ReturnType<typeof createSidepanelRunRuntime>,
      sessionRuntime: {
        applyPanelCache,
        chatRuntime: {
          applyEnabled: vi.fn(),
          clearHistoryForActiveTab: vi.fn(),
          finishStreamingMessage: vi.fn(),
          handleAgentChunk: vi.fn(),
          handleAgentResponse: vi.fn(),
          handleHistory: vi.fn(),
          hideAutomationNotice: vi.fn(),
          migrateHistory: vi.fn(),
          requestAbort: vi.fn(),
          restoreHistory: vi.fn(),
        },
        navigationRuntime: {},
        resetPanelView: vi.fn(),
      } as unknown as ReturnType<typeof createSidepanelSessionRuntime>,
      setupControlsRuntime: {
        isRefreshFreeRunning: vi.fn(),
        maybeShowSetup: vi.fn(),
        readCurrentModelValue: vi.fn(),
        setModelValue: vi.fn(),
        updateModelRowUI: vi.fn(),
      } as unknown as Parameters<
        typeof createSidepanelStateEffectsRuntime
      >[0]["setupControlsRuntime"],
      daemonHintRuntime: {
        update: updateDaemonHint,
      },
    });
    const state = { panelOpen: true } as Parameters<typeof runtime.applyUiState>[0];
    const message = { type: "ui:status", status: "Ready" } as const;

    runtime.applyUiState(state);
    runtime.handleBgMessage(message);
    uiStateOptions?.requestSlidesCapture();
    uiStateOptions?.setSlidesLayout("gallery");
    bgMessageOptions?.setSlidesContextPending(true);
    bgMessageOptions?.applyPanelCache({}, { preserveChat: true });
    bgMessageOptions?.renderInlineSlidesFallback();
    bgMessageOptions?.startSlidesSummaryStreamForRunId("run-1", undefined);

    expect(applyUiState).toHaveBeenCalledWith(state);
    expect(uiStateOptions?.updateDaemonHint).toBe(updateDaemonHint);
    expect(handleBgMessage).toHaveBeenCalledWith(message);
    expect(send).toHaveBeenCalledWith({ type: "panel:slides-capture" });
    expect(setSlidesLayout).toHaveBeenCalledWith("gallery");
    expect(store.slidesSession.slidesContextPending).toBe(true);
    expect(applyPanelCache).toHaveBeenCalledWith({}, { preserveChat: true });
    expect(renderInlineSlides).toHaveBeenCalledWith(renderMarkdownHostEl, { fallback: true });
    expect(startSlidesSummaryStreamForRunId).toHaveBeenCalledWith("run-1", null);
  });
});
