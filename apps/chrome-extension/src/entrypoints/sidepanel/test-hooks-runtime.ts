import type { BgToPanel, UiState } from "../../lib/panel-contracts";
import type { SidepanelDom } from "./dom";
import { isPanelChatAvailable } from "./panel-capabilities";
import type { PanelStateAction } from "./panel-state-store";
import type { createSidepanelPresentationRuntime } from "./presentation-runtime";
import { selectRetainedSlideSummaryMarkdown } from "./retained-slide-summary";
import type { createSidepanelRunRuntime } from "./run-runtime";
import { resolveSlidesInputMode } from "./slides-session-state";
import type { createSidepanelStateEffectsRuntime } from "./state-effects-runtime";
import { registerSidepanelTestHooks } from "./test-hooks";
import type { PanelState } from "./types";

type PresentationRuntime = ReturnType<typeof createSidepanelPresentationRuntime>;
type RunRuntime = ReturnType<typeof createSidepanelRunRuntime>;
type StateEffectsRuntime = ReturnType<typeof createSidepanelStateEffectsRuntime>;

export function registerSidepanelRuntimeTestHooks({
  dom,
  panelState,
  dispatchPanelState,
  presentationRuntime,
  runRuntime,
  stateEffectsRuntime,
}: {
  dom: SidepanelDom;
  panelState: PanelState;
  dispatchPanelState: (action: PanelStateAction) => void;
  presentationRuntime: PresentationRuntime;
  runRuntime: RunRuntime;
  stateEffectsRuntime: StateEffectsRuntime;
}) {
  const {
    feedback: { errorController },
    phase: { setPhase },
    summary: { renderMarkdown },
    slides: {
      applySlidesPayload,
      controlRuntime: summarizeControlRuntime,
      refreshSummarizeControl,
      setSlidesTranscriptTimedText,
      textController: slidesTextController,
      updateSlideSummaryFromMarkdown,
      viewRuntime: slidesViewRuntime,
    },
  } = presentationRuntime;

  registerSidepanelTestHooks({
    applySlidesPayload,
    getRunId: () => panelState.runId,
    getSummaryMarkdown: () => panelState.summaryMarkdown ?? "",
    getRetainedSlideSummaryMarkdown: () => selectRetainedSlideSummaryMarkdown(panelState) ?? "",
    getSlideDescriptions: () => slidesTextController.getDescriptionEntries(),
    getSlideSummaryEntries: () => slidesTextController.getSummaryEntries(),
    getSlideTitleEntries: () => Array.from(slidesTextController.getTitles().entries()),
    getPhase: () => panelState.phase,
    getModel: () => panelState.lastMeta.model ?? null,
    getSlidesTimeline: () =>
      panelState.slides?.slides.map((slide) => ({
        index: slide.index,
        timestamp: Number.isFinite(slide.timestamp) ? slide.timestamp : null,
      })) ?? [],
    getTranscriptTimedText: () => slidesTextController.getTranscriptTimedText(),
    getSlidesSummaryMarkdown: () => panelState.slidesSummary.markdown,
    getSlidesSummaryComplete: () => panelState.slidesSummary.complete,
    getSlidesSummaryModel: () => panelState.slidesSummary.model,
    getChatEnabled: () => isPanelChatAvailable(panelState),
    getSettingsHydrated: () => panelState.panelSession.settingsHydrated,
    setTranscriptTimedText: (value) => {
      setSlidesTranscriptTimedText(value);
      slidesViewRuntime.updateSlidesTextState();
    },
    setSummarizeMode: async (payload) => {
      await summarizeControlRuntime.handleSummarizeControlChange(payload);
      refreshSummarizeControl();
    },
    getSummarizeMode: () => ({
      mode: resolveSlidesInputMode(panelState.slidesSession),
      slides: panelState.slidesSession.slidesEnabled,
      mediaAvailable: panelState.slidesSession.mediaAvailable,
    }),
    getSlidesState: () => ({
      slidesCount: panelState.slides?.slides.length ?? 0,
      layout: panelState.slidesSession.slidesLayout,
      hasSlides: Boolean(panelState.slides),
    }),
    renderSlidesNow: slidesViewRuntime.queueSlidesRender,
    applyUiState: (state: UiState) => {
      dispatchPanelState({ type: "ui", ui: state });
      stateEffectsRuntime.applyUiState(state);
    },
    applyBgMessage: (message: BgToPanel) => {
      stateEffectsRuntime.handleBgMessage(message);
    },
    applySummarySnapshot: runRuntime.summaryRunRuntime.applySnapshot,
    applySummaryMarkdown: (markdown) => {
      renderMarkdown(markdown);
      setPhase("idle");
    },
    applySlidesSummaryMarkdown: (markdown) => {
      updateSlideSummaryFromMarkdown(markdown, {
        preserveIfEmpty: true,
        source: "slides-partial",
      });
      setPhase("idle");
    },
    forceRenderSlides: () => {
      dispatchPanelState({
        type: "slides-session-update",
        value: {
          slidesEnabled: true,
          inputMode: "video",
          inputModeOverride: "video",
        },
      });
      return slidesViewRuntime.slidesRenderer.forceRender();
    },
    showInlineError: errorController.showInlineError,
    isInlineErrorVisible: () => !dom.inlineErrorEl.classList.contains("hidden"),
    getInlineErrorMessage: () => dom.inlineErrorMessageEl.textContent ?? "",
  });
}
