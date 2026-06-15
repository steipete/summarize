const DAEMON_STATUS_TIMEOUT_MS = 5000;
const DAEMON_STATUS_RETRY_DELAY_MS = 400;
const DAEMON_STATUS_MAX_ATTEMPTS = 2;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const shouldRetryDaemon = (err: unknown) => {
  if (err instanceof DOMException && err.name === "AbortError") return true;
  const message = err instanceof Error ? err.message : "";
  return message.toLowerCase() === "failed to fetch";
};

async function withDaemonRetry(
  run: (signal: AbortSignal) => Promise<Response>,
  labels: {
    timeout: string;
    fetchFailed: string;
    fallback: string;
  },
): Promise<{ ok: boolean; error?: string }> {
  for (let attempt = 0; attempt < DAEMON_STATUS_MAX_ATTEMPTS; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), DAEMON_STATUS_TIMEOUT_MS);
    try {
      const res = await run(controller.signal);
      if (!res.ok) return { ok: false, error: `${res.status} ${res.statusText}` };
      return { ok: true };
    } catch (err) {
      const shouldRetry = attempt < DAEMON_STATUS_MAX_ATTEMPTS - 1 && shouldRetryDaemon(err);
      if (shouldRetry) {
        await sleep(DAEMON_STATUS_RETRY_DELAY_MS * (attempt + 1));
        continue;
      }
      if (err instanceof DOMException && err.name === "AbortError") {
        return { ok: false, error: labels.timeout };
      }
      const message = err instanceof Error ? err.message : labels.fallback;
      if (message.toLowerCase() === "failed to fetch") {
        return { ok: false, error: labels.fetchFailed };
      }
      return { ok: false, error: message };
    } finally {
      clearTimeout(timeout);
    }
  }
  return { ok: false, error: labels.timeout };
}

export async function daemonHealth(): Promise<{ ok: boolean; error?: string }> {
  return await withDaemonRetry(
    async (signal) => {
      return await fetch("http://127.0.0.1:8787/health", { signal });
    },
    {
      timeout: "Timed out",
      fetchFailed:
        "Failed to fetch (daemon unreachable or blocked by Chrome; try `summarize daemon status` and check ~/.summarize/logs/daemon.err.log)",
      fallback: "health failed",
    },
  );
}

export async function daemonPing(token: string): Promise<{ ok: boolean; error?: string }> {
  return await withDaemonRetry(
    async (signal) => {
      return await fetch("http://127.0.0.1:8787/v1/ping", {
        headers: { Authorization: `Bearer ${token}` },
        signal,
      });
    },
    {
      timeout: "Timed out",
      fetchFailed:
        "Failed to fetch (daemon unreachable or blocked by Chrome; try `summarize daemon status`)",
      fallback: "ping failed",
    },
  );
}

export function friendlyFetchError(err: unknown, context: string): string {
  const message = err instanceof Error ? err.message : String(err);
  if (message.toLowerCase() === "failed to fetch") {
    if (context.toLowerCase().includes("daemon")) {
      return `${context}: Failed to fetch (daemon unreachable or blocked by Chrome; try \`summarize daemon status\` and check ~/.summarize/logs/daemon.err.log)`;
    }
    return `${context}: Failed to fetch (network request blocked, offline, or provider unavailable)`;
  }
  return `${context}: ${message}`;
}
