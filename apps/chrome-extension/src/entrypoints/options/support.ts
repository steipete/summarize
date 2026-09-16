import { userScriptsGuidanceMessage, getUserScriptsStatus } from "../../automation/userscripts";
import type { LocalizedText } from "../../lib/i18n";
import { setText as setUiText, message as uiMessage } from "../../lib/i18n";

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

  const setStatus = (text: LocalizedText) => {
    window.clearTimeout(statusTimer);
    setUiText(statusEl, text);
  };

  const flashStatus = (text: LocalizedText, duration = 900) => {
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
  setUiText(buildInfoEl, text);
  buildInfoEl.toggleAttribute("hidden", text.length === 0);
}

export async function copyTokenToClipboard(options: {
  tokenEl: HTMLInputElement;
  flashStatus: (text: LocalizedText) => void;
}) {
  const { tokenEl, flashStatus } = options;
  const token = tokenEl.value.trim();
  if (!token) {
    flashStatus(uiMessage("token.empty"));
    return;
  }
  try {
    await navigator.clipboard.writeText(token);
    flashStatus(uiMessage("token.copied"));
    return;
  } catch {
    // fallback
  }
  tokenEl.focus();
  tokenEl.select();
  tokenEl.setSelectionRange(0, token.length);
  const ok = document.execCommand("copy");
  flashStatus(ok ? uiMessage("token.copied") : uiMessage("copy.failed"));
}

export function createAutomationPermissionsController(options: {
  automationPermissionsBtn: HTMLButtonElement;
  userScriptsNoticeEl: HTMLElement;
  getAutomationEnabled: () => boolean;
  flashStatus: (text: LocalizedText) => void;
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
    setUiText(
      automationPermissionsBtn,
      needsChromeToggle
        ? uiMessage("open.chrome.user.scripts.settings")
        : hasPermissions
          ? uiMessage("automation.permissions.granted")
          : uiMessage("enable.automation.permissions"),
    );

    if (!getAutomationEnabled()) {
      userScriptsNoticeEl.hidden = true;
      return;
    }

    if (apiAvailable && hasPermissions) {
      userScriptsNoticeEl.hidden = true;
      return;
    }

    setUiText(userScriptsNoticeEl, userScriptsGuidanceMessage(status));
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
        flashStatus(uiMessage("permission.request.denied"));
      }
    } catch {
      // ignore
    }
    await updateUi();
  };

  return { updateUi, requestPermissions };
}
