import { mountSummarizeControl } from "./pickers";
import type { SlideTextMode } from "./slides-state";
import type { PanelState } from "./types";

type SlidesTextViewState = {
  getTextMode: () => SlideTextMode;
  getTextToggleVisible: () => boolean;
};

export function createSummarizeControlView({
  root,
  panelState,
  slidesTextController,
  onSlidesTextModeChange,
  onChange,
  onSummarize,
}: {
  root: HTMLElement;
  panelState: PanelState;
  slidesTextController: SlidesTextViewState;
  onSlidesTextModeChange: (value: SlideTextMode) => void;
  onChange: (value: { mode: "page" | "video"; slides: boolean }) => void | Promise<void>;
  onSummarize: () => void;
}) {
  const buildProps = () => {
    const state = panelState.slidesSession;
    return {
      mode: state.inputMode,
      slidesEnabled: state.slidesEnabled,
      mediaAvailable: state.mediaAvailable,
      busy: state.slidesBusy,
      videoLabel: state.summarizeVideoLabel,
      pageWords: state.summarizePageWords,
      videoDurationSeconds: state.summarizeVideoDurationSeconds,
      slidesTextMode: slidesTextController.getTextMode(),
      slidesTextToggleVisible: slidesTextController.getTextToggleVisible(),
      onSlidesTextModeChange,
      onChange,
      onSummarize,
    };
  };

  const control = mountSummarizeControl(root, buildProps());

  return {
    refresh() {
      control.update(buildProps());
    },
  };
}
