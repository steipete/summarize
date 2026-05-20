import { buildUserScriptsGuidance, getUserScriptsStatus } from "../../automation/userscripts";

export function resolveBuildInfoText({
  injectedVersion,
  manifestVersion,
  gitHash,
}: {
  injectedVersion: string;
  manifestVersion: string;
  gitHash: string;
}) {
  const parts: string[] = [];
  const version = injectedVersion || manifestVersion;
  if (version) parts.push(`v${version}`);
  if (gitHash && gitHash !== "unknown") parts.push(gitHash);
  return parts.join(" · ");
}

export function createStatusController(statusEl: HTMLElement) {
  let statusTimer = 0;

  const setStatus = (text: string) => {
    window.clearTimeout(statusTimer);
    statusEl.textContent = text;
  };

  const flashStatus = (text: string, duration = 900) => {
    setStatus(text);
    statusTimer = window.setTimeout(() => setStatus(""), duration);
  };

  return { setStatus, flashStatus };
}

export function applyBuildInfo(
  buildInfoEl: HTMLElement | null,
  info: { injectedVersion: string; manifestVersion: string; gitHash: string },
) {
  if (!buildInfoEl) return;
  const text = resolveBuildInfoText(info);
  buildInfoEl.textContent = text;
  buildInfoEl.toggleAttribute("hidden", text.length === 0);
}

export async function copyTokenToClipboard(options: {
  tokenEl: HTMLInputElement;
  flashStatus: (text: string) => void;
}) {
  const { tokenEl, flashStatus } = options;
  const token = tokenEl.value.trim();
  if (!token) {
    flashStatus("Token empty");
    return;
  }
  try {
    await navigator.clipboard.writeText(token);
    flashStatus("Token copied");
    return;
  } catch {
    // fallback
  }
  tokenEl.focus();
  tokenEl.select();
  tokenEl.setSelectionRange(0, token.length);
  const ok = document.execCommand("copy");
  flashStatus(ok ? "Token copied" : "Copy failed");
}

export function createAutomationPermissionsController(options: {
  automationPermissionsBtn: HTMLButtonElement;
  userScriptsNoticeEl: HTMLElement;
  getAutomationEnabled: () => boolean;
  flashStatus: (text: string) => void;
}) {
  const { automationPermissionsBtn, userScriptsNoticeEl, getAutomationEnabled, flashStatus } =
    options;

  const updateUi = async () => {
    const status = await getUserScriptsStatus();
    const hasPermission = status.permissionGranted;
    const apiAvailable = status.apiAvailable;

    automationPermissionsBtn.disabled = !chrome.permissions || (hasPermission && apiAvailable);
    automationPermissionsBtn.textContent = hasPermission
      ? "Automation permissions granted"
      : "Enable automation permissions";

    if (!getAutomationEnabled()) {
      userScriptsNoticeEl.hidden = true;
      return;
    }

    if (apiAvailable && hasPermission) {
      userScriptsNoticeEl.hidden = true;
      return;
    }

    const steps = [buildUserScriptsGuidance(status)].filter(Boolean);
    userScriptsNoticeEl.textContent = steps.join(" ");
    userScriptsNoticeEl.hidden = false;
  };

  const requestPermissions = async () => {
    if (!chrome.permissions) return;
    try {
      const ok = await chrome.permissions.request({
        permissions: ["userScripts"],
      });
      if (!ok) {
        flashStatus("Permission request denied");
      }
    } catch {
      // ignore
    }
    await updateUi();
  };

  return { updateUi, requestPermissions };
}
