import type { SlidesLayout } from "../../lib/settings";

type InputMode = "page" | "video";

export type SlidesSessionState = {
  slidesEnabled: boolean;
  slidesParallel: boolean;
  slidesOcrEnabled: boolean;
  inputMode: InputMode;
  inputModeOverride: InputMode | null;
  mediaAvailable: boolean;
  summarizeMediaKind: "audio" | "video";
  summarizePageWords: number | null;
  summarizeVideoDurationSeconds: number | null;
  slidesBusy: boolean;
  slidesExpanded: boolean;
  slidesLayout: SlidesLayout;
  slidesContextRequestId: number;
  slidesContextPending: boolean;
  slidesContextUrl: string | null;
  slidesSeededSourceId: string | null;
  slidesAppliedRunId: string | null;
};

export function createInitialSlidesSessionState(options: {
  slidesEnabled: boolean;
  slidesParallel: boolean;
  slidesOcrEnabled: boolean;
  slidesLayout: SlidesLayout;
}): SlidesSessionState {
  return {
    slidesEnabled: options.slidesEnabled,
    slidesParallel: options.slidesParallel,
    slidesOcrEnabled: options.slidesOcrEnabled,
    inputMode: "page",
    inputModeOverride: null,
    mediaAvailable: false,
    summarizeMediaKind: "video",
    summarizePageWords: null,
    summarizeVideoDurationSeconds: null,
    slidesBusy: false,
    slidesExpanded: true,
    slidesLayout: options.slidesLayout,
    slidesContextRequestId: 0,
    slidesContextPending: false,
    slidesContextUrl: null,
    slidesSeededSourceId: null,
    slidesAppliedRunId: null,
  };
}

export function resolveSlidesInputMode(state: SlidesSessionState): InputMode {
  return state.inputModeOverride ?? state.inputMode;
}
