const DAEMON_STATUS_TIMEOUT_MS = 5000;
const DAEMON_STATUS_RETRY_DELAY_MS = 400;
const DAEMON_STATUS_MAX_ATTEMPTS = 2;

const sleep = (ms: number) => new Promise((resolve) => window.setTimeout(resolve, ms));

function shouldRetryDaemon(err: unknown) {
  if (err instanceof DOMException && err.name === "AbortError") return true;
  const message = err instanceof Error ? err.message : "";
  return message.toLowerCase() === "failed to fetch";
}

export function createDaemonStatusChecker({
  statusEl,
  fetchImpl = fetch,
  getExtensionVersion,
  isDaemonMode = () => true,
}: {
  statusEl: HTMLDivElement;
  fetchImpl?: typeof fetch;
  getExtensionVersion: () => string;
  isDaemonMode?: () => boolean;
}) {
  const setDaemonStatus = (text: string, state?: "ok" | "warn" | "error") => {
    const textEl = statusEl.querySelector<HTMLElement>(".daemonStatus__text");
    if (textEl) {
      textEl.textContent = text;
    } else {
      statusEl.textContent = text;
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
    setDaemonStatus("Daemon not selected", "ok");
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
    throw new Error("health failed");
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
      setDaemonStatus("Add token to verify daemon connection", "warn");
      return;
    }

    setDaemonStatus("Checking daemon…");

    try {
      const res = await fetchWithRetry("http://127.0.0.1:8787/health");
      if (checkId !== daemonCheckId) return;
      if (!res.ok) {
        setDaemonStatus(
          `Daemon error (${res.status} ${res.statusText}) — run \`summarize daemon status\``,
          "error",
        );
        return;
      }
      const json = (await res.json()) as { version?: unknown };
      const daemonVersion = typeof json.version === "string" ? json.version.trim() : "";
      const extVersion = getExtensionVersion();
      const versionNote = daemonVersion ? `v${daemonVersion}` : "version unknown";

      try {
        const ping = await fetchWithRetry("http://127.0.0.1:8787/v1/ping", {
          headers: { Authorization: `Bearer ${trimmedToken}` },
        });
        if (checkId !== daemonCheckId) return;
        if (!ping.ok) {
          setDaemonStatus(
            `Daemon ${versionNote} (token mismatch) — update token in side panel and Save`,
            "warn",
          );
          return;
        }
      } catch {
        if (checkId !== daemonCheckId) return;
        setDaemonStatus(
          `Daemon ${versionNote} (auth failed) — update token in side panel and Save`,
          "warn",
        );
        return;
      }

      if (daemonVersion && extVersion && daemonVersion !== extVersion) {
        setDaemonStatus(`Daemon ${versionNote} (extension v${extVersion})`, "warn");
        return;
      }

      setDaemonStatus(`Daemon ${versionNote} connected`, "ok");
    } catch {
      if (checkId !== daemonCheckId) return;
      setDaemonStatus(
        "Daemon unreachable — run `summarize daemon status` and check ~/.summarize/logs/daemon.err.log",
        "error",
      );
    }
  };

  return { checkDaemonStatus, setBrowserStatus, setDaemonStatus };
}
