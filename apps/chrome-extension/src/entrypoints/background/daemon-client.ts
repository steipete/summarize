import { daemonFetch } from "../../lib/daemon-fetch";
import { getDaemonOrigin } from "../../lib/daemon-url";
import {
  LocalizedError,
  message as uiMessage,
  resolveText,
  type LocalizedDescriptor,
} from "../../lib/i18n";

export type FetchErrorContext =
  | "daemonSlides"
  | "directProvider"
  | "daemonRequest"
  | "directChat"
  | "daemonChat"
  | "chatHistory"
  | "directHover"
  | "daemonHover"
  | "health"
  | "ping";
export type DaemonCheck = { ok: boolean; error?: string; localized?: LocalizedDescriptor };

function failure(localized: LocalizedDescriptor): DaemonCheck {
  return { ok: false, error: resolveText(localized, "en"), localized };
}

const DAEMON_STATUS_TIMEOUT_MS = 5000;
const DAEMON_STATUS_RETRY_DELAY_MS = 400;
const DAEMON_STATUS_MAX_ATTEMPTS = 2;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const shouldRetryDaemon = (err: unknown) => {
  if (err instanceof DOMException && err.name === "AbortError") return true;
  const message = err instanceof Error ? err.message : "";
  // i18n-ignore: Native fetch diagnostic used to select recovery behavior.
  return message.toLowerCase() === "failed to fetch";
};

async function withDaemonRetry(
  run: (signal: AbortSignal) => Promise<Response>,
  context: "health" | "ping",
): Promise<DaemonCheck> {
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
        return failure(uiMessage("error.daemonTimeout"));
      }
      return failure(friendlyFetchError(err, context).localized);
    } finally {
      clearTimeout(timeout);
    }
  }
  return failure(uiMessage("error.daemonTimeout"));
}

export async function daemonHealth(): Promise<DaemonCheck> {
  const origin = await getDaemonOrigin();

  return await withDaemonRetry(async (signal) => {
    return await daemonFetch(`${origin}/health`, { signal });
  }, "health");
}

export async function daemonPing(token: string): Promise<DaemonCheck> {
  const origin = await getDaemonOrigin();

  return await withDaemonRetry(async (signal) => {
    return await daemonFetch(`${origin}/v1/ping`, {
      headers: { Authorization: `Bearer ${token}` },
      signal,
    });
  }, "ping");
}

export function friendlyFetchError(err: unknown, context: FetchErrorContext) {
  const text = err instanceof Error ? err.message : String(err);
  const label = uiMessage("error.requestContext", { kind: context });
  const daemon = !["directProvider", "directChat", "directHover"].includes(context);
  const localized =
    text.toLowerCase() === /* i18n-ignore: Native fetch diagnostic. */ "failed to fetch"
      ? uiMessage(daemon ? "error.fetch" : "error.network", { context: label })
      : uiMessage("error.context", {
          context: label,
          error: err instanceof LocalizedError ? err.localized : text,
        });
  return { message: resolveText(localized, "en"), localized };
}
