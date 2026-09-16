import { message, resolveText } from "../lib/i18n";

const MIN_EXECUTE_CHROME_VERSION = 135;

export type UserScriptsStatus = {
  apiAvailable: boolean;
  permissionGranted: boolean;
  chromeVersion: number | null;
};

export function getChromeVersion(): number | null {
  // i18n-ignore: Browser product/version identifiers in the User-Agent protocol.
  const match = navigator.userAgent.match(/(Chrome|Chromium)\/(\d+)/);
  if (!match) return null;
  return Number(match[2]);
}

export async function getUserScriptsStatus(): Promise<UserScriptsStatus> {
  const apiAvailable = typeof chrome.userScripts?.execute === "function";
  const permissionGranted = Boolean(
    await chrome.permissions?.contains?.({ permissions: ["userScripts"] }),
  );
  return {
    apiAvailable,
    permissionGranted,
    chromeVersion: getChromeVersion(),
  };
}

export function userScriptsGuidanceMessage(status: UserScriptsStatus) {
  const version = status.chromeVersion ?? 0;
  const mode = status.apiAvailable
    ? "available"
    : version > 0 && version < MIN_EXECUTE_CHROME_VERSION
      ? "upgrade"
      : version >= 138
        ? "toggle"
        : version >= MIN_EXECUTE_CHROME_VERSION
          ? "developer"
          : "unsupported";
  return message("automation.userScriptsGuidance", {
    mode,
    version,
    minimum: MIN_EXECUTE_CHROME_VERSION,
    permissionGranted: status.permissionGranted || mode === "upgrade",
  });
}

/** Tool results are an English model protocol; the options UI binds the descriptor directly. */
export function buildUserScriptsGuidance(status: UserScriptsStatus): string {
  return resolveText(userScriptsGuidanceMessage(status), "en");
}
