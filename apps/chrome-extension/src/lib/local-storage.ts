export type LocalStorageLike = Pick<Storage, "getItem" | "setItem">;

function isLocalStorageLike(value: unknown): value is LocalStorageLike {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as Partial<LocalStorageLike>).getItem === "function" &&
    typeof (value as Partial<LocalStorageLike>).setItem === "function"
  );
}

function isNodeRuntime(): boolean {
  return (
    typeof process === "object" &&
    process !== null &&
    typeof (process as { versions?: { node?: unknown } }).versions?.node === "string"
  );
}

export function getLocalStorage(): LocalStorageLike | null {
  if (!isNodeRuntime() && typeof window !== "undefined") {
    try {
      return isLocalStorageLike(window.localStorage) ? window.localStorage : null;
    } catch {
      return null;
    }
  }

  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  if (!descriptor || !("value" in descriptor)) return null;
  return isLocalStorageLike(descriptor.value) ? descriptor.value : null;
}
