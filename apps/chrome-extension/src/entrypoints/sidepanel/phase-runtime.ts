import { LocalizedError, message as uiMessage } from "../../lib/i18n";
import type { ErrorController } from "./error-controller";
import type { HeaderController } from "./header-controller";
import { setPanelPhase } from "./panel-state-store";
import type { PanelPhase, PanelState } from "./types";

type PhaseEventTarget = {
  addEventListener: (type: string, listener: EventListener) => void;
};

export function createPanelPhaseRuntime({
  panelState,

  errorController,
  headerController,
  setSlidesBusy,
  rebuildSlideDescriptions,
  queueSlidesRender,
  eventTarget = window,
}: {
  panelState: PanelState;

  errorController: ErrorController;
  headerController: HeaderController;
  setSlidesBusy: (value: boolean) => void;
  rebuildSlideDescriptions: () => void;
  queueSlidesRender: () => void;
  eventTarget?: PhaseEventTarget;
}) {
  const setPhase = (phase: PanelPhase, options?: { error?: PanelState["error"] }) => {
    setPanelPhase(panelState, phase, options?.error);
    const running = phase === "connecting" || phase === "streaming";
    if (phase === "error") {
      const message =
        panelState.error &&
        (typeof panelState.error !== "string" || panelState.error.trim().length > 0)
          ? panelState.error
          : uiMessage("something.went.wrong.alternate");
      errorController.showPanelError(message);
      setSlidesBusy(false);
    } else {
      errorController.clearPanelError();
      if (!running) setSlidesBusy(false);
    }
    if (running) {
      headerController.armProgress();
      return;
    }
    headerController.stopProgress();
    if (panelState.slides) {
      rebuildSlideDescriptions();
      queueSlidesRender();
    }
  };

  const handleGlobalError = (event: ErrorEvent) => {
    const message =
      event.error instanceof LocalizedError
        ? event.error.localized
        : event.error instanceof Error
          ? event.error.stack || event.error.message
          : event.message;
    headerController.setStatus(
      typeof message === "string" ? uiMessage("error.message", { error: message }) : message,
    );
    setPhase("error", { error: message });
  };

  const handleUnhandledRejection = (event: PromiseRejectionEvent) => {
    const { reason } = event;
    const message =
      reason instanceof LocalizedError
        ? reason.localized
        : reason instanceof Error
          ? reason.stack || reason.message
          : String(reason);
    headerController.setStatus(
      typeof message === "string" ? uiMessage("error.message", { error: message }) : message,
    );
    setPhase("error", { error: message });
  };

  eventTarget.addEventListener("error", handleGlobalError as EventListener);
  eventTarget.addEventListener("unhandledrejection", handleUnhandledRejection as EventListener);

  return { setPhase };
}
