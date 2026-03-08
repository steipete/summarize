export type DaemonUiState = {
  ok: boolean;
  authed: boolean;
  error?: string;
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
  const message = state.error?.trim().toLowerCase() ?? "";
  if (!message) return false;
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

      if (shouldKeepReady) {
        return { ...lastReadyState };
      }

      return next;
    },
  };
}
