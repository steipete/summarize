import { hasDaemonPermission, requestDaemonPermission } from "../../lib/daemon-permission";
import { type DaemonPolicy, defaultDaemonPolicy, readDaemonPolicy } from "../../lib/daemon-policy";

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
  let transientMessage = "";

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
    options.statusEl.textContent = disabledByAdmin
      ? "Disabled by administrator"
      : transientMessage ||
        (state.permissionGranted
          ? "Enabled. Chrome allows this extension to use the installed local companion."
          : "Not enabled. Chrome will ask before allowing local companion access.");
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
    transientMessage = "Waiting for Chrome permission…";
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
        ? "Disabled by administrator"
        : "Permission denied. Direct and Browser modes remain active.";
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
