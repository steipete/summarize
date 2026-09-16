import { hasDaemonPermission, requestDaemonPermission } from "../../lib/daemon-permission";
import { type DaemonPolicy, defaultDaemonPolicy, readDaemonPolicy } from "../../lib/daemon-policy";
import type { LocalizedText } from "../../lib/i18n";
import { setText as setUiText, message as uiMessage } from "../../lib/i18n";

type CapabilityState = {
  policy: DaemonPolicy;
  permissionGranted: boolean;
};

export function createDaemonCapabilityController(options: {
  statusEl: HTMLElement;
  enableBtn: HTMLButtonElement;
  daemonFieldsEl: HTMLElement;
  summaryRuntimeRoot: HTMLElement;
  slideRuntimeRoot: HTMLElement;
  onStateChanged?: () => void;
}) {
  let state: CapabilityState = {
    policy: defaultDaemonPolicy,
    permissionGranted: false,
  };
  let requestPending = false;
  let transientMessage: LocalizedText = "";

  const daemonRuntimeInputs = [
    ...options.summaryRuntimeRoot.querySelectorAll<HTMLInputElement>('input[value="daemon"]'),
    ...options.slideRuntimeRoot.querySelectorAll<HTMLInputElement>('input[value="daemon"]'),
  ];

  const render = () => {
    const disabledByAdmin = !state.policy.daemonAllowed;
    for (const input of daemonRuntimeInputs) input.disabled = disabledByAdmin || requestPending;
    for (const control of options.daemonFieldsEl.querySelectorAll<
      HTMLInputElement | HTMLButtonElement
    >("input, button")) {
      control.disabled = disabledByAdmin || requestPending;
    }
    options.enableBtn.hidden = disabledByAdmin || state.permissionGranted;
    options.enableBtn.disabled = requestPending;
    setUiText(
      options.statusEl,
      disabledByAdmin
        ? uiMessage("disabled.by.administrator")
        : transientMessage ||
            (state.permissionGranted
              ? uiMessage(
                  "enabled.chrome.allows.this.extension.to.use.the.installed.local.companion",
                )
              : uiMessage("not.enabled.chrome.will.ask.before.allowing.local.companion.access")),
    );
    options.statusEl.dataset.state = disabledByAdmin
      ? "managed"
      : state.permissionGranted
        ? "enabled"
        : "disabled";
  };

  const initialize = async () => {
    const [policy, permissionGranted] = await Promise.all([
      readDaemonPolicy(),
      hasDaemonPermission(),
    ]);
    state = { policy, permissionGranted: policy.daemonAllowed && permissionGranted };
    render();
    return { ...state };
  };

  const ensureEnabled = async () => {
    if (!state.policy.daemonAllowed) {
      render();
      return false;
    }
    if (state.permissionGranted) return true;
    requestPending = true;
    transientMessage = uiMessage("waiting.for.chrome.permission");
    render();
    // skipContains keeps permissions.request() in the initiating click gesture.
    const result = await requestDaemonPermission({
      policy: state.policy,
      skipContains: true,
    });
    requestPending = false;
    state.permissionGranted = result.granted;
    transientMessage = result.granted
      ? ""
      : result.reason === "managed"
        ? uiMessage("disabled.by.administrator")
        : uiMessage("permission.denied.direct.and.browser.modes.remain.active");
    render();
    options.onStateChanged?.();
    return result.granted;
  };

  options.enableBtn.addEventListener("click", () => {
    void ensureEnabled();
  });

  return {
    ensureEnabled,
    getState: () => ({ ...state }),
    initialize,
    render,
  };
}
