import { isGeminiNanoModel } from "../../lib/model-routing";
import type { Settings } from "../../lib/settings";
import type { UiState } from "./types";

export function shouldShowDaemonHint(state: UiState): boolean {
  if (!state.settings.daemonAllowed) return true;
  const model = state.settings.model.trim().toLowerCase();
  const usesLocalDefault = model === "auto" || isGeminiNanoModel(model);
  return (
    !state.settings.daemonHintDismissed &&
    !(state.daemon.ok && state.daemon.authed) &&
    state.settings.summaryRuntime === "direct" &&
    state.settings.slideRuntime === "browser" &&
    !state.settings.providerConfigured &&
    usesLocalDefault
  );
}

export function createDaemonHintRuntime(options: {
  hintEl: HTMLElement;
  actionBtn: HTMLButtonElement;
  closeBtn: HTMLButtonElement;
  patchSettings: (patch: Pick<Settings, "daemonHintDismissed">) => Promise<unknown>;
  openOptions: () => void;
}) {
  let dismissedLocally = false;

  const update = (state: UiState) => {
    const disabledByAdmin = !state.settings.daemonAllowed;
    const visible = (disabledByAdmin || !dismissedLocally) && shouldShowDaemonHint(state);
    const messageEl = options.hintEl.querySelector<HTMLElement>(".daemonHint__message");
    if (messageEl) {
      messageEl.textContent = disabledByAdmin
        ? "Local companion: Disabled by administrator. Direct and Browser modes remain available."
        : "Works locally in Chrome. Connect the daemon for faster media, OCR, and more.";
    }
    options.actionBtn.hidden = disabledByAdmin;
    options.closeBtn.hidden = disabledByAdmin;
    options.hintEl.classList.toggle("hidden", !visible);
  };

  options.actionBtn.addEventListener("click", options.openOptions);
  options.closeBtn.addEventListener("click", () => {
    dismissedLocally = true;
    options.hintEl.classList.add("hidden");
    void options.patchSettings({ daemonHintDismissed: true }).catch(() => {});
  });

  return { update };
}
