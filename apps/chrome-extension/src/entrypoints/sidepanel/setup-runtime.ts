import {
  message as uiMessage,
  readLocalizedMessage,
  localizedErrorText,
  type LocalizedDescriptor,
} from "../../lib/i18n";
import type { LocalizedText } from "../../lib/i18n";
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
  if (
    raw.includes("linux") ||
    raw.includes("cros") ||
    raw.includes(/* i18n-ignore: Navigator platform identifier. */ "chrome os")
  )
    return "linux";
  return "other";
}

export function friendlyFetchError(
  err: unknown,
  context: string | LocalizedDescriptor,
): LocalizedDescriptor {
  const message = err instanceof Error ? err.message : String(err);
  if (
    message.toLowerCase() ===
    /* i18n-ignore: Native fetch error before localized presentation. */ "failed to fetch"
  ) {
    return uiMessage("error.fetch", { context });
  }
  return uiMessage("error.context", { context, error: localizedErrorText(err) });
}

export function createSetupRuntime(options: {
  setupEl: HTMLDivElement;
  loadToken: () => Promise<string>;
  loadDaemonPort: () => Promise<string>;
  ensureToken: () => Promise<string>;
  patchSettings: typeof import("../../lib/settings").patchSettings;
  generateToken: typeof import("../../lib/token").generateToken;
  headerSetStatus: (text: LocalizedText) => void;
  getStatusResetText: () => string;
}) {
  const platformKind = resolvePlatformKind();

  const renderSetup = async (
    token: string,
    copy: {
      headline: LocalizedText;
      message: LocalizedText;
    } = {
      headline: uiMessage("setup"),
      message: uiMessage("setup.intro"),
    },
  ) => {
    const daemonPort = await options.loadDaemonPort();
    options.setupEl.classList.remove("hidden");
    options.setupEl.innerHTML = installStepsHtml({
      token,
      daemonPort,
      headline: copy.headline,
      message: copy.message,
      platformKind,
    });
    wireSetupButtons({
      setupEl: options.setupEl,
      token,
      daemonPort,
      platformKind,
      headerSetStatus: options.headerSetStatus,
      getStatusResetText: options.getStatusResetText,
      patchSettings: options.patchSettings,
      generateToken: options.generateToken,
      renderSetup: (nextToken) => {
        void renderSetup(nextToken, copy);
      },
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
            headline: uiMessage("daemon.capabilities.unavailable"),
            message: uiMessage("setup.advisory"),
          }
        : {
            headline: uiMessage("setup"),
            message: uiMessage("setup.intro"),
          };
    if (!state.settings.tokenPresent) {
      void options.ensureToken().then((token) => {
        void renderSetup(token, copy);
      });
      return display;
    }
    if (!state.daemon.ok || !state.daemon.authed) {
      options.setupEl.classList.remove("hidden");
      void Promise.all([options.loadToken(), options.loadDaemonPort()]).then(
        ([token, daemonPort]) => {
          options.setupEl.innerHTML = `
          ${installStepsHtml({
            token,
            daemonPort,
            headline:
              display === "advisory"
                ? uiMessage("daemon.capabilities.unavailable")
                : uiMessage("daemon.not.reachable"),
            message:
              readLocalizedMessage(state.daemon.localized) ??
              state.daemon.error ??
              uiMessage("check.that.the.launchagent.is.installed"),
            platformKind,
            showTroubleshooting: true,
          })}
        `;
          wireSetupButtons({
            setupEl: options.setupEl,
            token,
            daemonPort,
            platformKind,
            headerSetStatus: options.headerSetStatus,
            getStatusResetText: options.getStatusResetText,
            patchSettings: options.patchSettings,
            generateToken: options.generateToken,
            renderSetup: (nextToken) => {
              void renderSetup(nextToken, copy);
            },
          });
        },
      );
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
