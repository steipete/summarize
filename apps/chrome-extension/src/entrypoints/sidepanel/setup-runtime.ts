import { isGeminiNanoModel } from "../../lib/model-routing";
import { installStepsHtml, wireSetupButtons } from "./setup-view";
import type { UiState } from "./types";

export type PlatformKind = "mac" | "windows" | "linux" | "other";
export type SetupDisplay = "hidden" | "advisory" | "blocking";

export function resolvePlatformKind(): PlatformKind {
  const nav = navigator as Navigator & { userAgentData?: { platform?: string } };
  const uaPlatform = nav.userAgentData?.platform;
  const effectivePlatform = uaPlatform && uaPlatform.trim() ? uaPlatform : navigator.platform;
  const raw = (effectivePlatform ?? navigator.userAgent ?? "").toLowerCase().trim();

  if (raw.includes("mac")) return "mac";
  if (raw.includes("win")) return "windows";
  if (raw.includes("linux") || raw.includes("cros") || raw.includes("chrome os")) return "linux";
  return "other";
}

export function friendlyFetchError(err: unknown, context: string): string {
  const message = err instanceof Error ? err.message : String(err);
  if (message.toLowerCase() === "failed to fetch") {
    return `${context}: Failed to fetch (daemon unreachable or blocked by Chrome; try \`summarize daemon status\`, maybe \`summarize daemon restart\`, and check ~/.summarize/logs/daemon.err.log)`;
  }
  return `${context}: ${message}`;
}

export function createSetupRuntime(options: {
  setupEl: HTMLDivElement;
  loadToken: () => Promise<string>;
  ensureToken: () => Promise<string>;
  patchSettings: typeof import("../../lib/settings").patchSettings;
  generateToken: typeof import("../../lib/token").generateToken;
  headerSetStatus: (text: string) => void;
  getStatusResetText: () => string;
}) {
  const platformKind = resolvePlatformKind();

  const renderSetup = (
    token: string,
    copy: {
      headline: string;
      message: string;
    } = {
      headline: "Setup",
      message:
        "Install summarize, then register the daemon so the side panel can stream summaries.",
    },
  ) => {
    options.setupEl.classList.remove("hidden");
    options.setupEl.innerHTML = installStepsHtml({
      token,
      headline: copy.headline,
      message: copy.message,
      platformKind,
    });
    wireSetupButtons({
      setupEl: options.setupEl,
      token,
      platformKind,
      headerSetStatus: options.headerSetStatus,
      getStatusResetText: options.getStatusResetText,
      patchSettings: options.patchSettings,
      generateToken: options.generateToken,
      renderSetup: (nextToken) => renderSetup(nextToken, copy),
    });
  };

  const maybeShowSetup = (state: UiState): SetupDisplay => {
    const summaryNeedsDaemon =
      state.settings.summaryRuntime === "daemon" && !isGeminiNanoModel(state.settings.model);
    const capabilityNeedsDaemon =
      (state.settings.summaryRuntime === "daemon" &&
        (state.settings.chatEnabled ||
          state.settings.automationEnabled ||
          state.settings.hoverSummaries)) ||
      (state.settings.slidesEnabled && state.settings.slideRuntime === "daemon");
    const display: SetupDisplay = summaryNeedsDaemon
      ? "blocking"
      : capabilityNeedsDaemon
        ? "advisory"
        : "hidden";
    if (display === "hidden") {
      options.setupEl.classList.add("hidden");
      return "hidden";
    }
    const copy =
      display === "advisory"
        ? {
            headline: "Daemon capabilities unavailable",
            message:
              "Gemini Nano summaries work on-device. Install the daemon to enable the selected daemon-backed capabilities.",
          }
        : {
            headline: "Setup",
            message:
              "Install summarize, then register the daemon so the side panel can stream summaries.",
          };
    if (!state.settings.tokenPresent) {
      void options.ensureToken().then((token) => {
        renderSetup(token, copy);
      });
      return display;
    }
    if (!state.daemon.ok || !state.daemon.authed) {
      options.setupEl.classList.remove("hidden");
      void options.loadToken().then((token) => {
        options.setupEl.innerHTML = `
          ${installStepsHtml({
            token,
            headline:
              display === "advisory" ? "Daemon capabilities unavailable" : "Daemon not reachable",
            message: state.daemon.error ?? "Check that the LaunchAgent is installed.",
            platformKind,
            showTroubleshooting: true,
          })}
        `;
        wireSetupButtons({
          setupEl: options.setupEl,
          token,
          platformKind,
          headerSetStatus: options.headerSetStatus,
          getStatusResetText: options.getStatusResetText,
          patchSettings: options.patchSettings,
          generateToken: options.generateToken,
          renderSetup: (nextToken) => renderSetup(nextToken, copy),
        });
      });
      return display;
    }
    options.setupEl.classList.add("hidden");
    return "hidden";
  };

  return {
    platformKind,
    renderSetup,
    maybeShowSetup,
  };
}
