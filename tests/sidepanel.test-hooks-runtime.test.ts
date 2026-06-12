import { afterEach, describe, expect, it, vi } from "vitest";
import type { SidepanelDom } from "../apps/chrome-extension/src/entrypoints/sidepanel/dom";
import { createPanelStateStore } from "../apps/chrome-extension/src/entrypoints/sidepanel/panel-state-store";
import type { createSidepanelPresentationRuntime } from "../apps/chrome-extension/src/entrypoints/sidepanel/presentation-runtime";
import type { createSidepanelRunRuntime } from "../apps/chrome-extension/src/entrypoints/sidepanel/run-runtime";
import type { createSidepanelStateEffectsRuntime } from "../apps/chrome-extension/src/entrypoints/sidepanel/state-effects-runtime";
import type { SidepanelTestHooks } from "../apps/chrome-extension/src/entrypoints/sidepanel/test-hooks";
import { registerSidepanelRuntimeTestHooks } from "../apps/chrome-extension/src/entrypoints/sidepanel/test-hooks-runtime";

afterEach(() => {
  delete (globalThis as typeof globalThis & { __summarizeTestHooks?: SidepanelTestHooks })
    .__summarizeTestHooks;
  vi.clearAllMocks();
});

describe("sidepanel test hooks runtime", () => {
  it("adapts composed runtimes to the browser test API", async () => {
    const hooks: SidepanelTestHooks = {};
    (
      globalThis as typeof globalThis & {
        __summarizeTestHooks?: SidepanelTestHooks;
      }
    ).__summarizeTestHooks = hooks;

    const store = createPanelStateStore();
    store.state.runId = "run-1";
    store.state.summaryMarkdown = "summary";
    store.state.lastMeta.model = "openai/gpt-5.4";
    store.state.slidesSession.mediaAvailable = true;
    store.state.slidesSummary.markdown = "slide summary";
    store.state.slidesSummary.complete = true;
    store.state.slidesSummary.model = "openai/gpt-5.4";

    const setSlidesTranscriptTimedText = vi.fn();
    const updateSlidesTextState = vi.fn();
    const handleSummarizeControlChange = vi.fn(async () => {});
    const refreshSummarizeControl = vi.fn();
    const renderMarkdown = vi.fn();
    const setPhase = vi.fn();
    const updateSlideSummaryFromMarkdown = vi.fn();
    const forceRender = vi.fn(() => 3);
    const applyUiState = vi.fn();
    const handleBgMessage = vi.fn();
    const applySnapshot = vi.fn();
    const showInlineError = vi.fn();
    const presentationRuntime = {
      feedback: {
        errorController: {
          showInlineError,
        },
      },
      phase: {
        setPhase,
      },
      summary: {
        renderMarkdown,
      },
      slides: {
        applySlidesPayload: vi.fn(),
        controlRuntime: {
          handleSummarizeControlChange,
        },
        refreshSummarizeControl,
        setSlidesTranscriptTimedText,
        textController: {
          getDescriptionEntries: vi.fn(() => [[1, "description"]]),
          getSummaryEntries: vi.fn(() => [[1, "summary"]]),
          getTitles: vi.fn(() => new Map([[1, "title"]])),
          getTranscriptTimedText: vi.fn(() => "timed text"),
        },
        updateSlideSummaryFromMarkdown,
        viewRuntime: {
          queueSlidesRender: vi.fn(),
          slidesRenderer: {
            forceRender,
          },
          updateSlidesTextState,
        },
      },
    } as unknown as ReturnType<typeof createSidepanelPresentationRuntime>;
    const stateEffectsRuntime = {
      applyUiState,
      handleBgMessage,
    } as ReturnType<typeof createSidepanelStateEffectsRuntime>;
    const runRuntime = {
      summaryRunRuntime: {
        applySnapshot,
      },
    } as unknown as ReturnType<typeof createSidepanelRunRuntime>;

    registerSidepanelRuntimeTestHooks({
      dom: {
        inlineErrorEl: {
          classList: {
            contains: vi.fn(() => false),
          },
        },
        inlineErrorMessageEl: {
          textContent: "Failure",
        },
      } as unknown as SidepanelDom,
      panelState: store.state,
      dispatchPanelState: store.dispatch,
      presentationRuntime,
      runRuntime,
      stateEffectsRuntime,
    });

    expect(hooks.getRunId?.()).toBe("run-1");
    expect(hooks.getSummaryMarkdown?.()).toBe("summary");
    expect(hooks.getModel?.()).toBe("openai/gpt-5.4");
    expect(hooks.getSlidesSummaryMarkdown?.()).toBe("slide summary");
    expect(hooks.getSlidesSummaryComplete?.()).toBe(true);
    expect(hooks.getSlidesSummaryModel?.()).toBe("openai/gpt-5.4");
    expect(hooks.getSlideDescriptions?.()).toEqual([[1, "description"]]);
    expect(hooks.getSlideSummaryEntries?.()).toEqual([[1, "summary"]]);
    expect(hooks.getSlideTitleEntries?.()).toEqual([[1, "title"]]);
    expect(hooks.getTranscriptTimedText?.()).toBe("timed text");
    expect(hooks.getSummarizeMode?.()).toEqual({
      mode: "page",
      slides: true,
      mediaAvailable: true,
    });

    hooks.setTranscriptTimedText?.("next transcript");
    await hooks.setSummarizeMode?.({ mode: "video", slides: true });
    hooks.applyUiState?.({ panelOpen: true });
    hooks.applyBgMessage?.({ type: "ui:status", status: "Ready" });
    hooks.applySummaryMarkdown?.("next summary");
    hooks.applySlidesSummaryMarkdown?.("next slide summary");
    expect(hooks.forceRenderSlides?.()).toBe(3);
    hooks.showInlineError?.("Failure");

    expect(setSlidesTranscriptTimedText).toHaveBeenCalledWith("next transcript");
    expect(updateSlidesTextState).toHaveBeenCalledOnce();
    expect(handleSummarizeControlChange).toHaveBeenCalledWith({ mode: "video", slides: true });
    expect(refreshSummarizeControl).toHaveBeenCalledOnce();
    expect(store.state.ui).toEqual({ panelOpen: true });
    expect(applyUiState).toHaveBeenCalledWith({ panelOpen: true });
    expect(handleBgMessage).toHaveBeenCalledWith({ type: "ui:status", status: "Ready" });
    expect(renderMarkdown).toHaveBeenCalledWith("next summary");
    expect(updateSlideSummaryFromMarkdown).toHaveBeenCalledWith("next slide summary", {
      preserveIfEmpty: true,
      source: "slides-partial",
    });
    expect(setPhase).toHaveBeenCalledTimes(2);
    expect(store.state.slidesSession).toMatchObject({
      slidesEnabled: true,
      inputMode: "video",
      inputModeOverride: "video",
    });
    expect(forceRender).toHaveBeenCalledOnce();
    expect(showInlineError).toHaveBeenCalledWith("Failure");
    expect(hooks.isInlineErrorVisible?.()).toBe(true);
    expect(hooks.getInlineErrorMessage?.()).toBe("Failure");
  });
});
