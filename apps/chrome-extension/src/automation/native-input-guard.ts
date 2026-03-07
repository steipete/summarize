export type NativeInputArmMessage = {
  type: "automation:native-input-arm";
  tabId: number;
  enabled: boolean;
};

export function updateNativeInputArmedTabs(args: {
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

export function getNativeInputGuardError(args: {
  armedTabs: Set<number>;
  senderTabId?: number;
}): string | null {
  const { armedTabs, senderTabId } = args;
  if (typeof senderTabId !== "number") return "Missing sender tab";
  if (!armedTabs.has(senderTabId)) return "Native input not armed for this tab";
  return null;
}

export async function withNativeInputArmedTab<T>(args: {
  enabled: boolean;
  tabId: number;
  sendMessage: (message: NativeInputArmMessage) => Promise<unknown>;
  run: () => Promise<T>;
}): Promise<T> {
  const { enabled, tabId, sendMessage, run } = args;
  if (!enabled) return run();
  await sendMessage({ type: "automation:native-input-arm", tabId, enabled: true });
  try {
    return await run();
  } finally {
    void sendMessage({ type: "automation:native-input-arm", tabId, enabled: false });
  }
}
