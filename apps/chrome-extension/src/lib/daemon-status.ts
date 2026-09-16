import type { MessageDescriptor } from "@steipete/summarize-core/localization";

export type DaemonUiState = {
  ok: boolean;
  authed: boolean;
  error?: string;
  localized?: MessageDescriptor;
};

type DaemonStatusTrackerOptions = {
  transientGraceMs?: number;
};

type ResolveOptions = {
  now?: number;
  keepReady?: boolean;
};

const DEFAULT_TRANSIENT_GRACE_MS = 90_000;

export function isTransientDaemonState(state: DaemonUiState): boolean {
  if (state.localized?.key === "error.daemonTimeout" || state.localized?.key === "error.fetch")
    return true;
  const message = state.error?.trim().toLowerCase() ?? "";
  if (!message) return false;
  // i18n-ignore: Transport health diagnostics, independent of rendered UI language.
  return message === "timed out" || message.includes("failed to fetch");
}

export function createDaemonStatusTracker(options: DaemonStatusTrackerOptions = {}) {
  const transientGraceMs = options.transientGraceMs ?? DEFAULT_TRANSIENT_GRACE_MS;
  let lastReadyAt = 0;
  let lastReadyState: DaemonUiState | null = null;

  const markReady = (now = Date.now()): DaemonUiState => {
    lastReadyAt = now;
    lastReadyState = { ok: true, authed: true };
    return { ok: true, authed: true };
  };

  return {
    markReady,
    resolve(next: DaemonUiState, opts: ResolveOptions = {}): DaemonUiState {
      const now = opts.now ?? Date.now();
      const isReady = next.ok && next.authed;
      if (isReady) {
        return markReady(now);
      }

      const shouldKeepReady =
        isTransientDaemonState(next) &&
        lastReadyState &&
        (opts.keepReady || now - lastReadyAt <= transientGraceMs);

      if (shouldKeepReady && lastReadyState) {
        return { ...lastReadyState };
      }

      return next;
    },
  };
}
