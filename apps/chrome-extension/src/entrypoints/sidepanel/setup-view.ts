import type { Settings } from "../../lib/settings";

type PlatformKind = "mac" | "windows" | "linux" | "other";

export function installStepsHtml({
  token,
  headline,
  message,
  platformKind,
  showTroubleshooting,
}: {
  token: string;
  headline: string;
  message?: string;
  platformKind: PlatformKind;
  showTroubleshooting?: boolean;
}) {
  const npmCmd = "npm i -g @steipete/summarize";
  const brewCmd = "brew install summarize";
  const daemonCmd = `summarize daemon install --token ${token}`;
  const isMac = platformKind === "mac";
  const isLinux = platformKind === "linux";
  const isWindows = platformKind === "windows";
  const isSupported = isMac || isLinux || isWindows;
  const daemonLabel = isMac
    ? "LaunchAgent"
    : isLinux
      ? "systemd user service"
      : isWindows
        ? "Scheduled Task"
        : "daemon";

  const installToggle = isMac
    ? `
      <div class="setup__toggle" role="tablist" aria-label="Install method">
        <button class="setup__pill" type="button" data-install="npm" role="tab" aria-selected="false">NPM</button>
        <button class="setup__pill" type="button" data-install="brew" role="tab" aria-selected="false">Homebrew</button>
      </div>
    `
    : "";

  const installIntro = `
    <div class="setup__section">
      <div class="setup__headerRow">
        <p class="setup__title" data-install-title><strong>1) Install summarize</strong></p>
        ${installToggle}
      </div>
      <div class="setup__codeRow">
        <code data-install-code>${isMac ? brewCmd : npmCmd}</code>
        <button class="ghost icon setup__copy" type="button" data-copy="install" aria-label="Copy install command">
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M8 6a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2h-8a2 2 0 0 1-2-2V6Zm-4 4a2 2 0 0 1 2-2h1v2H6v8h8v1a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2v-9Z" />
          </svg>
        </button>
      </div>
      <p class="setup__hint" data-install-hint>${
        isMac
          ? "Homebrew installs summarize plus the local media dependencies."
          : "NPM installs the CLI (requires Node.js)."
      }</p>
    </div>
  `;

  const daemonIntro = isSupported
    ? `
      <div class="setup__section">
        <p class="setup__title"><strong>2) Register the daemon (${daemonLabel})</strong></p>
        <div class="setup__codeRow">
          <code data-daemon-code>${daemonCmd}</code>
          <button class="ghost icon setup__copy" type="button" data-copy="daemon" aria-label="Copy daemon command">
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="M8 6a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2h-8a2 2 0 0 1-2-2V6Zm-4 4a2 2 0 0 1 2-2h1v2H6v8h8v1a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2v-9Z" />
            </svg>
          </button>
        </div>
      </div>
    `
    : `
      <div class="setup__section">
        <p class="setup__title"><strong>2) Daemon auto-start</strong></p>
        <p class="setup__hint">Not supported on this OS yet.</p>
      </div>
    `;

  const troubleshooting =
    showTroubleshooting && isSupported
      ? `
      <div class="setup__section">
        <p class="setup__title"><strong>Troubleshooting</strong></p>
        <div class="setup__codeRow">
          <code>summarize daemon status</code>
          <button class="ghost icon setup__copy" type="button" data-copy="status" aria-label="Copy status command">
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="M8 6a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2h-8a2 2 0 0 1-2-2V6Zm-4 4a2 2 0 0 1 2-2h1v2H6v8h8v1a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2v-9Z" />
            </svg>
          </button>
        </div>
        <p class="setup__hint">Shows daemon health, version, and token auth status.</p>
        <div class="setup__codeRow">
          <code>summarize daemon restart</code>
          <button class="ghost icon setup__copy" type="button" data-copy="restart" aria-label="Copy restart command">
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="M8 6a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2h-8a2 2 0 0 1-2-2V6Zm-4 4a2 2 0 0 1 2-2h1v2H6v8h8v1a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2v-9Z" />
            </svg>
          </button>
        </div>
        <p class="setup__hint">Restarts the daemon if it’s stuck or not responding.</p>
      </div>
    `
      : "";

  return `
    <h2>${headline}</h2>
    ${message ? `<p>${message}</p>` : ""}
    ${installIntro}
    ${daemonIntro}
    <div class="setup__section setup__actions">
      <button id="regen" type="button" class="ghost">Regenerate Token</button>
    </div>
    ${troubleshooting}
  `;
}

export function wireSetupButtons({
  setupEl,
  token,
  platformKind,
  headerSetStatus,
  getStatusResetText,
  patchSettings,
  generateToken,
  renderSetup,
}: {
  setupEl: HTMLElement;
  token: string;
  platformKind: PlatformKind;
  headerSetStatus: (text: string) => void;
  getStatusResetText: () => string;
  patchSettings: (patch: Partial<Settings>) => Promise<Settings>;
  generateToken: () => string;
  renderSetup: (token: string) => void;
}) {
  const npmCmd = "npm i -g @steipete/summarize";
  const brewCmd = "brew install summarize";
  const daemonCmd = `summarize daemon install --token ${token}`;
  const isMac = platformKind === "mac";
  const installMethodKey = "summarize.installMethod";
  type InstallMethod = "npm" | "brew";

  const resolveInstallMethod = (): InstallMethod => {
    if (!isMac) return "npm";
    try {
      const stored = localStorage.getItem(installMethodKey);
      if (stored === "npm" || stored === "brew") return stored;
    } catch {
      // ignore
    }
    return "brew";
  };

  const persistInstallMethod = (method: InstallMethod) => {
    if (!isMac) return;
    try {
      localStorage.setItem(installMethodKey, method);
    } catch {
      // ignore
    }
  };

  const flashCopied = () => {
    headerSetStatus("Copied");
    setTimeout(() => headerSetStatus(getStatusResetText()), 800);
  };

  const installTitleEl = setupEl.querySelector<HTMLElement>("[data-install-title]");
  const installCodeEl = setupEl.querySelector<HTMLElement>("[data-install-code]");
  const installHintEl = setupEl.querySelector<HTMLElement>("[data-install-hint]");
  const installButtons = Array.from(setupEl.querySelectorAll<HTMLButtonElement>("[data-install]"));

  const applyInstallMethod = (method: InstallMethod) => {
    const label = method === "brew" ? "Homebrew" : "NPM";
    if (installTitleEl) {
      installTitleEl.innerHTML = `<strong>1) Install summarize (${label})</strong>`;
    }
    if (installCodeEl) {
      installCodeEl.textContent = method === "brew" ? brewCmd : npmCmd;
    }
    if (installHintEl) {
      if (!isMac) {
        installHintEl.textContent = "NPM installs the CLI (requires Node.js).";
      } else if (method === "brew") {
        installHintEl.textContent =
          "Homebrew installs summarize plus the local media dependencies.";
      } else {
        installHintEl.textContent = "NPM installs the CLI (requires Node.js).";
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
                ? "summarize daemon status"
                : copyType === "restart"
                  ? "summarize daemon restart"
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
