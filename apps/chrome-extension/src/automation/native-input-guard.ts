export type NativeInputArmMessage = {
  type: "automation:native-input-arm";
  tabId: number;
  enabled: boolean;
  capability?: string | null;
};

export type ArtifactsArmMessage = {
  type: "automation:artifacts-arm";
  tabId: number;
  enabled: boolean;
};

export function updateArmedTabs(args: {
  armedTabs: Set<number> | Map<number, string>;
  senderHasTab: boolean;
  tabId?: number;
  enabled?: boolean;
  capability?: string | null;
}): boolean {
  const { armedTabs, senderHasTab, tabId, enabled, capability } = args;
  if (senderHasTab || typeof tabId !== "number") return false;
  if (enabled) {
    if (armedTabs instanceof Map) {
      if (typeof capability !== "string" || capability.length < 32) return false;
      armedTabs.set(tabId, capability);
    } else {
      armedTabs.add(tabId);
    }
  } else {
    armedTabs.delete(tabId);
  }
  return true;
}

export function updateNativeInputArmedTabs(args: {
  armedTabs: Set<number> | Map<number, string>;
  senderHasTab: boolean;
  tabId?: number;
  enabled?: boolean;
  capability?: string | null;
}): boolean {
  return updateArmedTabs(args);
}

export function getArmedTabGuardError(args: {
  armedTabs: Set<number> | Map<number, string>;
  senderTabId?: number;
  feature: string;
  capability?: string | null;
}): string | null {
  const { armedTabs, senderTabId, feature, capability } = args;
  if (typeof senderTabId !== "number") return "Missing sender tab";
  if (!armedTabs.has(senderTabId)) return `${feature} not armed for this tab`;
  if (armedTabs instanceof Map && armedTabs.get(senderTabId) !== capability) {
    return `${feature} capability mismatch`;
  }
  return null;
}

export function getNativeInputGuardError(args: {
  armedTabs: Set<number> | Map<number, string>;
  senderTabId?: number;
  capability?: string | null;
}): string | null {
  return getArmedTabGuardError({ ...args, feature: "Native input" });
}

export function getArtifactsGuardError(args: {
  armedTabs: Set<number>;
  senderTabId?: number;
}): string | null {
  return getArmedTabGuardError({ ...args, feature: "Artifacts bridge" });
}

export async function withArmedTab<T, TMessage extends { tabId: number; enabled: boolean }>(args: {
  enabled: boolean;
  tabId: number;
  armMessage: (input: { tabId: number; enabled: boolean }) => TMessage;
  sendMessage: (message: TMessage) => Promise<unknown>;
  run: () => Promise<T>;
}): Promise<T> {
  const { enabled, tabId, armMessage, sendMessage, run } = args;
  if (!enabled) return run();
  await sendMessage(armMessage({ tabId, enabled: true }));
  try {
    return await run();
  } finally {
    await sendMessage(armMessage({ tabId, enabled: false }));
  }
}

export async function withNativeInputArmedTab<T>(args: {
  enabled: boolean;
  tabId: number;
  sendMessage: (message: NativeInputArmMessage) => Promise<unknown>;
  capability: string;
  run: () => Promise<T>;
}): Promise<T> {
  const { capability, ...rest } = args;
  return withArmedTab({
    ...rest,
    armMessage: ({ tabId, enabled }) => ({
      type: "automation:native-input-arm" as const,
      tabId,
      enabled,
      capability: enabled ? capability : null,
    }),
  });
}

export async function withArtifactsArmedTab<T>(args: {
  enabled: boolean;
  tabId: number;
  sendMessage: (message: ArtifactsArmMessage) => Promise<unknown>;
  run: () => Promise<T>;
}): Promise<T> {
  return withArmedTab({
    ...args,
    armMessage: ({ tabId, enabled }) => ({
      type: "automation:artifacts-arm" as const,
      tabId,
      enabled,
    }),
  });
}
