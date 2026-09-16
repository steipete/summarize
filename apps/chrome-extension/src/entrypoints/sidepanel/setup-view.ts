import type { LocalizedText } from "../../lib/i18n";
import {
  setText as setUiText,
  message as uiMessage,
  localizedHtml,
  escapeUiHtml,
} from "../../lib/i18n";
import { getLocalStorage } from "../../lib/local-storage";
import type { Settings } from "../../lib/settings";

type PlatformKind = "mac" | "windows" | "linux" | "other";

export function installStepsHtml({
  token,
  daemonPort,
  headline,
  message,
  platformKind,
  showTroubleshooting,
}: {
  token: string;
  daemonPort: string;
  headline: LocalizedText;
  message?: LocalizedText;
  platformKind: PlatformKind;
  showTroubleshooting?: boolean;
}) {
  const npmCmd = "npm i -g @steipete/summarize";
  const brewCmd = "brew install summarize";
  // i18n-ignore: Executable install command; interpolated values are literal credentials/ports.
  const daemonCmd = `summarize daemon install --token ${token} --port ${daemonPort}`;
  const isMac = platformKind === "mac";
  const isLinux = platformKind === "linux";
  const isWindows = platformKind === "windows";
  const isSupported = isMac || isLinux || isWindows;

  const installToggle = isMac
    ? `
      <div class="setup__toggle" role="tablist" data-i18n-aria-label="install.method">
        <button class="setup__pill" type="button" data-install="npm" role="tab" aria-selected="false">NPM</button>
        <button class="setup__pill" type="button" data-install="brew" role="tab" aria-selected="false">Homebrew</button>
      </div>
    `
    : "";

  const installIntro = `
    <div class="setup__section">
      <div class="setup__headerRow">
        <p class="setup__title" data-install-title><strong>${localizedHtml(uiMessage("setup.installStep", { method: "", hasMethod: false }))}</strong></p>
        ${installToggle}
      </div>
      <div class="setup__codeRow">
        <code data-install-code>${escapeUiHtml(isMac ? brewCmd : npmCmd)}</code>
        <button class="ghost icon setup__copy" type="button" data-copy="install" data-i18n-aria-label="copy.install.command">
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M8 6a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2h-8a2 2 0 0 1-2-2V6Zm-4 4a2 2 0 0 1 2-2h1v2H6v8h8v1a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2v-9Z" />
          </svg>
        </button>
      </div>
      <p class="setup__hint" data-install-hint>${
        isMac
          ? localizedHtml(
              uiMessage("homebrew.installs.summarize.plus.the.local.media.dependencies"),
            )
          : localizedHtml(uiMessage("npm.installs.the.cli.requires.node.js"))
      }</p>
    </div>
  `;

  const daemonIntro = isSupported
    ? `
      <div class="setup__section">
        <p class="setup__title"><strong>${localizedHtml(uiMessage("setup.registerStep", { platform: platformKind }))}</strong></p>
        <div class="setup__codeRow">
          <code data-daemon-code>${escapeUiHtml(daemonCmd)}</code>
          <button class="ghost icon setup__copy" type="button" data-copy="daemon" data-i18n-aria-label="copy.daemon.command">
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="M8 6a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2h-8a2 2 0 0 1-2-2V6Zm-4 4a2 2 0 0 1 2-2h1v2H6v8h8v1a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2v-9Z" />
            </svg>
          </button>
        </div>
      </div>
    `
    : `
      <div class="setup__section">
        <p class="setup__title"><strong>${localizedHtml(uiMessage("2.daemon.auto.start"))}</strong></p>
        <p class="setup__hint">${localizedHtml(uiMessage("not.supported.on.this.os.yet"))}</p>
      </div>
    `;

  const troubleshooting =
    showTroubleshooting && isSupported
      ? `
      <div class="setup__section">
        <p class="setup__title"><strong>${localizedHtml(uiMessage("troubleshooting"))}</strong></p>
        <div class="setup__codeRow">
          <code>summarize daemon status</code>
          <button class="ghost icon setup__copy" type="button" data-copy="status" data-i18n-aria-label="copy.status.command">
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="M8 6a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2h-8a2 2 0 0 1-2-2V6Zm-4 4a2 2 0 0 1 2-2h1v2H6v8h8v1a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2v-9Z" />
            </svg>
          </button>
        </div>
        <p class="setup__hint">${localizedHtml(uiMessage("shows.daemon.health.version.and.token.auth.status"))}</p>
        <div class="setup__codeRow">
          <code>summarize daemon restart</code>
          <button class="ghost icon setup__copy" type="button" data-copy="restart" data-i18n-aria-label="copy.restart.command">
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="M8 6a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2h-8a2 2 0 0 1-2-2V6Zm-4 4a2 2 0 0 1 2-2h1v2H6v8h8v1a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2v-9Z" />
            </svg>
          </button>
        </div>
        <p class="setup__hint">${localizedHtml(uiMessage("restarts.the.daemon.if.it.s.stuck.or.not.responding"))}</p>
      </div>
    `
      : "";

  return `
    <h2>${localizedHtml(headline)}</h2>
    ${message ? `<p>${localizedHtml(message)}</p>` : ""}
    ${installIntro}
    ${daemonIntro}
    <div class="setup__section setup__actions">
      <button id="regen" type="button" class="ghost">${localizedHtml(uiMessage("regenerate.token"))}</button>
    </div>
    ${troubleshooting}
  `;
}

export function wireSetupButtons({
  setupEl,
  token,
  daemonPort,
  platformKind,
  headerSetStatus,
  getStatusResetText,
  patchSettings,
  generateToken,
  renderSetup,
}: {
  setupEl: HTMLElement;
  token: string;
  daemonPort: string;
  platformKind: PlatformKind;
  headerSetStatus: (text: LocalizedText) => void;
  getStatusResetText: () => string;
  patchSettings: (patch: Partial<Settings>) => Promise<Settings>;
  generateToken: () => string;
  renderSetup: (token: string) => void;
}) {
  const npmCmd = "npm i -g @steipete/summarize";
  const brewCmd = "brew install summarize";
  // i18n-ignore: Executable install command; interpolated values are literal credentials/ports.
  const daemonCmd = `summarize daemon install --token ${token} --port ${daemonPort}`;
  const isMac = platformKind === "mac";
  const installMethodKey = "summarize.installMethod";
  const storage = getLocalStorage();
  type InstallMethod = "npm" | "brew";

  const resolveInstallMethod = (): InstallMethod => {
    if (!isMac) return "npm";
    try {
      const stored = storage?.getItem(installMethodKey);
      if (stored === "npm" || stored === "brew") return stored;
    } catch {
      // ignore
    }
    return "brew";
  };

  const persistInstallMethod = (method: InstallMethod) => {
    if (!isMac) return;
    try {
      storage?.setItem(installMethodKey, method);
    } catch {
      // ignore
    }
  };

  const flashCopied = () => {
    headerSetStatus(uiMessage("copied"));
    setTimeout(() => headerSetStatus(getStatusResetText()), 800);
  };

  const installTitleEl = setupEl.querySelector<HTMLElement>("[data-install-title]");
  const installCodeEl = setupEl.querySelector<HTMLElement>("[data-install-code]");
  const installHintEl = setupEl.querySelector<HTMLElement>("[data-install-hint]");
  const installButtons = Array.from(setupEl.querySelectorAll<HTMLButtonElement>("[data-install]"));

  const applyInstallMethod = (method: InstallMethod) => {
    const label = method === "brew" ? "Homebrew" : "NPM";
    if (installTitleEl) {
      installTitleEl.innerHTML = `<strong>${localizedHtml(uiMessage("setup.installStep", { method: label, hasMethod: true }))}</strong>`;
    }
    if (installCodeEl) {
      setUiText(installCodeEl, method === "brew" ? brewCmd : npmCmd);
    }
    if (installHintEl) {
      if (!isMac) {
        setUiText(installHintEl, uiMessage("npm.installs.the.cli.requires.node.js"));
      } else if (method === "brew") {
        setUiText(
          installHintEl,
          uiMessage("homebrew.installs.summarize.plus.the.local.media.dependencies"),
        );
      } else {
        setUiText(installHintEl, uiMessage("npm.installs.the.cli.requires.node.js"));
      }
    }
    for (const button of installButtons) {
      const isActive = button.dataset.install === method;
      button.classList.toggle("isActive", isActive);
      button.setAttribute("aria-selected", isActive ? "true" : "false");
    }
    persistInstallMethod(method);
  };

  applyInstallMethod(resolveInstallMethod());

  for (const button of installButtons) {
    button.addEventListener("click", () => {
      applyInstallMethod(button.dataset.install === "brew" ? "brew" : "npm");
    });
  }

  setupEl.querySelectorAll<HTMLButtonElement>("[data-copy]").forEach((button) => {
    button.addEventListener("click", () => {
      void (async () => {
        const copyType = button.dataset.copy;
        const installMethod = resolveInstallMethod();
        const payload =
          copyType === "install"
            ? installMethod === "brew"
              ? brewCmd
              : npmCmd
            : copyType === "daemon"
              ? daemonCmd
              : copyType === "status"
                ? /* i18n-ignore: Executable CLI command copied to the clipboard. */ "summarize daemon status"
                : copyType === "restart"
                  ? /* i18n-ignore: Executable CLI command copied to the clipboard. */ "summarize daemon restart"
                  : "";
        if (!payload) return;
        await navigator.clipboard.writeText(payload);
        flashCopied();
      })();
    });
  });

  setupEl.querySelector<HTMLButtonElement>("#regen")?.addEventListener("click", () => {
    void (async () => {
      const nextToken = generateToken();
      await patchSettings({ token: nextToken });
      renderSetup(nextToken);
    })();
  });
}
