type RecoveryCheck = {
  isReady: boolean;
  currentUrlMatches: boolean;
  isIdle: boolean;
};

export function createDaemonRecovery() {
  let lastReady: boolean | null = null;
  let pendingUrl: string | null = null;

  return {
    recordFailure(url: string) {
      lastReady = false;
      pendingUrl = url;
    },
    getPendingUrl() {
      return pendingUrl;
    },
    clearPending() {
      pendingUrl = null;
    },
    updateStatus(isReady: boolean) {
      lastReady = isReady;
    },
    maybeRecover({ isReady, currentUrlMatches, isIdle }: RecoveryCheck) {
      const prev = lastReady;
      lastReady = isReady;

      if (!pendingUrl) return false;

      if (!currentUrlMatches) {
        pendingUrl = null;
        return false;
      }

      if (prev === false && isReady && isIdle) {
        pendingUrl = null;
        return true;
      }

      return false;
    },
  };
}

export function isDaemonUnreachableError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  const normalized = message.toLowerCase();
  // i18n-ignore: Untranslated fetch/network diagnostics from the browser API.
  return (
    normalized.includes("failed to fetch") ||
    normalized.includes("networkerror") ||
    normalized.includes("econnrefused")
  );
}
