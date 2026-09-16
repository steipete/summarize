import { daemonFetch } from "../../lib/daemon-fetch";
import { getDaemonOrigin } from "../../lib/daemon-url";
import { extensionMessage } from "../../lib/i18n";
import { setText as setUiText, message as uiMessage, type LocalizedText } from "../../lib/i18n";

const DAEMON_STATUS_TIMEOUT_MS = 5000;
const DAEMON_STATUS_RETRY_DELAY_MS = 400;
const DAEMON_STATUS_MAX_ATTEMPTS = 2;

const sleep = (ms: number) => new Promise((resolve) => window.setTimeout(resolve, ms));

function shouldRetryDaemon(err: unknown) {
  if (err instanceof DOMException && err.name === "AbortError") return true;
  const message = err instanceof Error ? err.message : "";
  // i18n-ignore: Native fetch diagnostic; displayed recovery text is keyed separately.
  return message.toLowerCase() === "failed to fetch";
}

function formatDaemonConnectionError(err: unknown) {
  const message = err instanceof Error ? err.message.trim() : "";
  const lower = message.toLowerCase();
  if (
    lower.includes(
      /* i18n-ignore: Chrome extension messaging diagnostic. */ "receiving end does not exist",
    ) ||
    lower.includes(
      /* i18n-ignore: Chrome extension messaging diagnostic. */ "extension context invalidated",
    ) ||
    lower.includes(/* i18n-ignore: Chrome extension messaging diagnostic. */ "message port closed")
  ) {
    return uiMessage("extension.context.stale.reload.the.extension.then.reopen.the.side.panel");
  }
  if (
    lower.includes(/* i18n-ignore: Chrome native-messaging diagnostic. */ "host exited") ||
    lower.includes(/* i18n-ignore: Chrome native-messaging diagnostic. */ "host has exited") ||
    lower.includes(
      /* i18n-ignore: Chrome native-messaging diagnostic. */ "connection closed unexpectedly",
    )
  ) {
    return uiMessage(
      "native.host.exited.run.summarize.daemon.status.and.check.summarize.logs.daemon.err.log",
    );
  }
  if (
    lower.includes(
      /* i18n-ignore: Chrome native-messaging diagnostic. */ "failed to start native messaging host",
    )
  ) {
    return uiMessage(
      "native.host.failed.to.start.rerun.the.install.command.and.verify.launcher.permissions",
    );
  }
  if (
    lower.includes(
      /* i18n-ignore: Chrome native-messaging diagnostic. */ "error when communicating with the native messaging host",
    )
  ) {
    return uiMessage(
      "native.host.communication.failed.run.summarize.daemon.status.and.check.summarize.logs.daemon.err.log",
    );
  }
  if (
    lower.includes(
      /* i18n-ignore: Chrome native-messaging diagnostic. */ "specified native messaging host not found",
    ) ||
    lower.includes(
      /* i18n-ignore: Chrome native-messaging diagnostic. */ "native messaging host not found",
    ) ||
    lower.includes(
      /* i18n-ignore: Chrome native-messaging diagnostic. */ "no such native application",
    ) ||
    lower.includes(
      /* i18n-ignore: Chrome native-messaging diagnostic. */ "specified native messaging host is forbidden",
    )
  ) {
    return uiMessage("native.host.unavailable.rerun.the.install.command.then.reload.the.extension");
  }
  if (lower.includes("permission")) {
    return uiMessage("local.companion.permission.missing.enable.it.in.runtime.settings");
  }
  return uiMessage(
    "daemon.unreachable.run.summarize.daemon.status.verify.the.port.then.reload.the.extension",
  );
}

export function createDaemonStatusChecker({
  statusEl,
  fetchImpl = daemonFetch,
  getExtensionVersion,
  isDaemonMode = () => true,
}: {
  statusEl: HTMLDivElement;
  fetchImpl?: typeof fetch;
  getExtensionVersion: () => string;
  isDaemonMode?: () => boolean;
}) {
  const setDaemonStatus = (text: LocalizedText, state?: "ok" | "warn" | "error") => {
    const textEl = statusEl.querySelector<HTMLElement>(".daemonStatus__text");
    if (textEl) {
      setUiText(textEl, text);
    } else {
      setUiText(statusEl, text);
    }
    if (state) {
      statusEl.dataset.state = state;
    } else {
      delete statusEl.dataset.state;
    }
  };

  let daemonCheckId = 0;

  const setBrowserStatus = () => {
    daemonCheckId += 1;
    setDaemonStatus(
      uiMessage("daemon.runtime.off.choose.daemon.for.ai.or.media.to.connect"),
      "warn",
    );
  };

  const fetchWithRetry = async (url: string, options: RequestInit = {}) => {
    for (let attempt = 0; attempt < DAEMON_STATUS_MAX_ATTEMPTS; attempt += 1) {
      const controller = new AbortController();
      const timeout = window.setTimeout(() => controller.abort(), DAEMON_STATUS_TIMEOUT_MS);
      try {
        return await fetchImpl(url, { ...options, signal: controller.signal });
      } catch (error) {
        if (attempt < DAEMON_STATUS_MAX_ATTEMPTS - 1 && shouldRetryDaemon(error)) {
          window.clearTimeout(timeout);
          await sleep(DAEMON_STATUS_RETRY_DELAY_MS * (attempt + 1));
          continue;
        }
        throw error;
      } finally {
        window.clearTimeout(timeout);
      }
    }
    throw new Error(extensionMessage("error.healthFailed"));
  };

  const checkDaemonStatus = async (token: string) => {
    if (!isDaemonMode()) {
      setBrowserStatus();
      return;
    }
    daemonCheckId += 1;
    const checkId = daemonCheckId;
    const trimmedToken = token.trim();
    if (!trimmedToken) {
      setDaemonStatus(uiMessage("daemon.addToken"), "warn");
      return;
    }

    setDaemonStatus(uiMessage("checking.daemon"));

    try {
      const origin = await getDaemonOrigin();
      const res = await fetchWithRetry(`${origin}/health`);
      if (checkId !== daemonCheckId) return;
      if (!res.ok) {
        setDaemonStatus(
          uiMessage("daemon.httpError", { code: String(res.status), status: res.statusText }),
          "error",
        );
        return;
      }
      const json = (await res.json()) as { version?: unknown };
      const daemonVersion = typeof json.version === "string" ? json.version.trim() : "";
      const extVersion = getExtensionVersion();

      try {
        const ping = await fetchWithRetry(`${origin}/v1/ping`, {
          headers: { Authorization: `Bearer ${trimmedToken}` },
        });
        if (checkId !== daemonCheckId) return;
        if (!ping.ok) {
          setDaemonStatus(
            uiMessage("daemon.authProblem", {
              version: daemonVersion,
              hasVersion: Boolean(daemonVersion),
              kind: "token",
            }),
            "warn",
          );
          return;
        }
      } catch {
        if (checkId !== daemonCheckId) return;
        setDaemonStatus(
          uiMessage("daemon.authProblem", {
            version: daemonVersion,
            hasVersion: Boolean(daemonVersion),
            kind: "auth",
          }),
          "warn",
        );
        return;
      }

      if (daemonVersion && extVersion && daemonVersion !== extVersion) {
        setDaemonStatus(
          uiMessage("daemon.versionMismatch", { version: daemonVersion, extension: extVersion }),
          "warn",
        );
        return;
      }

      setDaemonStatus(
        uiMessage("daemon.connected", {
          version: daemonVersion,
          hasVersion: Boolean(daemonVersion),
        }),
        "ok",
      );
    } catch (error) {
      if (checkId !== daemonCheckId) return;
      setDaemonStatus(formatDaemonConnectionError(error), "error");
    }
  };

  return { checkDaemonStatus, setBrowserStatus, setDaemonStatus };
}
