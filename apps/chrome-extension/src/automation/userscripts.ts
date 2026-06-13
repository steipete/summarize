export type UserScriptsStatus = {
  apiAvailable: boolean;
  permissionGranted: boolean;
  chromeVersion: number | null;
};

export function getChromeVersion(): number | null {
  const match = navigator.userAgent.match(/(Chrome|Chromium)\/(\d+)/);
  if (!match) return null;
  return Number(match[2]);
}

export async function getUserScriptsStatus(): Promise<UserScriptsStatus> {
  const apiAvailable = Boolean(chrome.userScripts);
  const permissionGranted = Boolean(
    await chrome.permissions?.contains?.({ permissions: ["userScripts"] }),
  );
  return {
    apiAvailable,
    permissionGranted,
    chromeVersion: getChromeVersion(),
  };
}

// Returns a user-facing, actionable message for the current userScripts status.
export function buildUserScriptsGuidance(status: UserScriptsStatus): string {
  const chromeVersion = status.chromeVersion ?? 0;
  const permissionHint = status.permissionGranted
    ? null
    : "First click “Enable automation permissions” in Settings.";

  if (status.apiAvailable) {
    return [
      permissionHint,
      "User Scripts permission is required. Enable it in Options → Automation permissions, then allow “User Scripts” in chrome://extensions.",
    ]
      .filter(Boolean)
      .join(" ");
  }

  if (chromeVersion >= 138) {
    return [
      permissionHint,
      `Chrome ${chromeVersion} detected. To enable User Scripts:\n\n1. Go to chrome://extensions/\n2. Find this extension and click "Details"\n3. Enable the "Allow User Scripts" toggle\n4. Reload the page and try again`,
    ]
      .filter(Boolean)
      .join("\n\n");
  }

  if (chromeVersion >= 120) {
    return [
      permissionHint,
      `Chrome ${chromeVersion} detected. Enable Developer mode in chrome://extensions, then reload the extension and try again.`,
    ]
      .filter(Boolean)
      .join(" ");
  }

  if (chromeVersion > 0) {
    return [
      permissionHint,
      `Chrome ${chromeVersion} detected. The userScripts API requires Chrome 120 or higher. Please update Chrome.`,
    ]
      .filter(Boolean)
      .join(" ");
  }

  return [permissionHint, "User Scripts API is not available in this browser."]
    .filter(Boolean)
    .join(" ");
}
