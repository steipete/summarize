import { mountSummarizeControl } from "./pickers";
import type { SlideTextMode } from "./slides-state";
import type { PanelState } from "./types";

type SlidesTextViewState = {
  getTextMode: () => SlideTextMode;
  getTextToggleVisible: () => boolean;
};

type SummarizeControlActions = {
  onSlidesTextModeChange: (value: SlideTextMode) => void;
  onChange: (value: { mode: "page" | "video"; slides: boolean }) => void | Promise<void>;
  onSummarize: () => void;
};

export function createSummarizeControlView({
  root,
  panelState,
  slidesTextController,
}: {
  root: HTMLElement;
  panelState: PanelState;
  slidesTextController: SlidesTextViewState;
}) {
  let actions: SummarizeControlActions | null = null;
  let control: ReturnType<typeof mountSummarizeControl> | null = null;

  const buildProps = (boundActions: SummarizeControlActions) => {
    const state = panelState.slidesSession;
    return {
      mode: state.inputMode,
      slidesEnabled: state.slidesEnabled,
      mediaAvailable: state.mediaAvailable,
      busy: state.slidesBusy,
      mediaKind: state.summarizeMediaKind,
      pageWords: state.summarizePageWords,
      videoDurationSeconds: state.summarizeVideoDurationSeconds,
      slidesTextMode: slidesTextController.getTextMode(),
      slidesTextToggleVisible: slidesTextController.getTextToggleVisible(),
      ...boundActions,
    };
  };

  return {
    bindActions(nextActions: SummarizeControlActions) {
      if (control) return;
      actions = nextActions;
      control = mountSummarizeControl(root, buildProps(nextActions));
    },
    refresh() {
      if (!control || !actions) return;
      control.update(buildProps(actions));
    },
  };
}
