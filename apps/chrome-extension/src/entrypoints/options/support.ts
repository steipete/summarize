import { buildUserScriptsGuidance, getUserScriptsStatus } from "../../automation/userscripts";

const AUTOMATION_PERMISSIONS = ["userScripts"] as const;

export function getOptionalAutomationPermissions() {
  const optionalPermissions = chrome.runtime?.getManifest?.().optional_permissions ?? [];
  return AUTOMATION_PERMISSIONS.filter((permission) => optionalPermissions.includes(permission));
}

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
    const optionalPermissions = getOptionalAutomationPermissions();
    const hasPermissions = Boolean(
      optionalPermissions.length > 0 &&
      (await chrome.permissions?.contains?.({ permissions: optionalPermissions })),
    );
    const apiAvailable = status.apiAvailable;
    const needsChromeToggle = status.chromeVersion !== null && hasPermissions && !apiAvailable;

    automationPermissionsBtn.disabled =
      !chrome.permissions || optionalPermissions.length === 0 || (hasPermissions && apiAvailable);
    automationPermissionsBtn.textContent = needsChromeToggle
      ? "Open Chrome User Scripts settings"
      : hasPermissions
        ? "Automation permissions granted"
        : "Enable automation permissions";

    if (!getAutomationEnabled()) {
      userScriptsNoticeEl.hidden = true;
      return;
    }

    if (apiAvailable && hasPermissions) {
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
      const status = await getUserScriptsStatus();
      const optionalPermissions = getOptionalAutomationPermissions();
      if (optionalPermissions.length === 0) return;
      const hasPermissions = Boolean(
        await chrome.permissions.contains({ permissions: optionalPermissions }),
      );
      if (status.chromeVersion !== null && hasPermissions && !status.apiAvailable) {
        await chrome.tabs.create({
          url: `chrome://extensions/?id=${chrome.runtime.id}`,
        });
        return;
      }
      const ok = await chrome.permissions.request({
        permissions: optionalPermissions,
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
