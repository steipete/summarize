export type DaemonPolicy = {
  daemonAllowed: boolean;
  managed: boolean;
};

export const defaultDaemonPolicy: DaemonPolicy = {
  daemonAllowed: true,
  managed: false,
};

export function normalizeDaemonPolicy(value: unknown): DaemonPolicy {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return defaultDaemonPolicy;
  }
  const daemonAllowed = (value as Record<string, unknown>).daemonAllowed;
  if (typeof daemonAllowed !== "boolean") return defaultDaemonPolicy;
  return { daemonAllowed, managed: true };
}

export async function readDaemonPolicy(): Promise<DaemonPolicy> {
  const storage = globalThis.chrome?.storage?.managed;
  if (!storage) return defaultDaemonPolicy;
  try {
    const result = (await storage.get("daemonAllowed")) as Record<string, unknown>;
    return normalizeDaemonPolicy(result);
  } catch {
    // An unmanaged profile can reject managed-storage reads. That is equivalent
    // to the administrator not setting this policy.
    return defaultDaemonPolicy;
  }
}

export function enforceDaemonPolicy<
  T extends {
    token: string;
    summaryRuntime: "direct" | "daemon";
    slideRuntime: "browser" | "daemon";
    autoCliFallback: boolean;
  },
>(settings: T, policy: DaemonPolicy): T {
  if (policy.daemonAllowed) return settings;
  return {
    ...settings,
    token: "",
    summaryRuntime: "direct",
    slideRuntime: "browser",
    autoCliFallback: false,
  };
}
