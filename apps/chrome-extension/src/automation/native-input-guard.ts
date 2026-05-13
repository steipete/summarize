export type NativeInputArmMessage = {
  type: "automation:native-input-arm";
  tabId: number;
  enabled: boolean;
};

export type ArtifactsArmMessage = {
  type: "automation:artifacts-arm";
  tabId: number;
  enabled: boolean;
};

export function updateArmedTabs(args: {
  armedTabs: Set<number>;
  senderHasTab: boolean;
  tabId?: number;
  enabled?: boolean;
}): boolean {
  const { armedTabs, senderHasTab, tabId, enabled } = args;
  if (senderHasTab || typeof tabId !== "number") return false;
  if (enabled) armedTabs.add(tabId);
  else armedTabs.delete(tabId);
  return true;
}

export function updateNativeInputArmedTabs(args: {
  armedTabs: Set<number>;
  senderHasTab: boolean;
  tabId?: number;
  enabled?: boolean;
}): boolean {
  return updateArmedTabs(args);
}

export function getArmedTabGuardError(args: {
  armedTabs: Set<number>;
  senderTabId?: number;
  feature: string;
}): string | null {
  const { armedTabs, senderTabId, feature } = args;
  if (typeof senderTabId !== "number") return "Missing sender tab";
  if (!armedTabs.has(senderTabId)) return `${feature} not armed for this tab`;
  return null;
}

export function getNativeInputGuardError(args: {
  armedTabs: Set<number>;
  senderTabId?: number;
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
  run: () => Promise<T>;
}): Promise<T> {
  return withArmedTab({
    ...args,
    armMessage: ({ tabId, enabled }) => ({
      type: "automation:native-input-arm" as const,
      tabId,
      enabled,
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
