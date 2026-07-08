import { getLocalStorage } from "./local-storage";

const storageKey = "settings";
const fallbackStorageKey = "summarize.settings";

function getLocalStorageArea(): chrome.storage.StorageArea | null {
  return globalThis.chrome?.storage?.local ?? null;
}

function loadFallbackSettings(): Record<string, unknown> {
  try {
    const raw = getLocalStorage()?.getItem(fallbackStorageKey);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function saveFallbackSettings(settings: object): void {
  try {
    getLocalStorage()?.setItem(fallbackStorageKey, JSON.stringify(settings));
  } catch {
    // Best-effort fallback for non-extension previews.
  }
}

export async function readStoredSettings(): Promise<Record<string, unknown>> {
  const storage = getLocalStorageArea();
  if (!storage) return loadFallbackSettings();

  const result = await new Promise<Record<string, unknown>>((resolve, reject) => {
    let settled = false;
    const maybePromise = storage.get(storageKey, (value) => {
      settled = true;
      resolve(value as Record<string, unknown>);
    });
    if (maybePromise && typeof (maybePromise as Promise<unknown>).then === "function") {
      (maybePromise as Promise<Record<string, unknown>>)
        .then((value) => {
          if (!settled) resolve(value as Record<string, unknown>);
        })
        .catch(reject);
    }
  });
  const raw = result[storageKey];
  return raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
}

export async function writeStoredSettings(settings: object): Promise<void> {
  const storage = getLocalStorageArea();
  if (!storage) {
    saveFallbackSettings(settings);
    return;
  }
  await storage.set({ [storageKey]: settings });
}
