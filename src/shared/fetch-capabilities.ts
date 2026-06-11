const DNS_PINNED_FETCH = Symbol.for("@steipete/summarize.dnsPinnedFetch");
const DNS_PINNED_ADDRESSES = Symbol.for("@steipete/summarize.dnsPinnedAddresses");

export type DnsPinnedAddress = { address: string; family?: number };

export function markFetchAsDnsPinned<T extends typeof fetch>(
  fetchImpl: T,
  pinnedFetchImpl: typeof fetch = fetchImpl,
): T {
  Object.defineProperty(fetchImpl, DNS_PINNED_FETCH, {
    configurable: false,
    enumerable: false,
    value: pinnedFetchImpl,
  });
  return fetchImpl;
}

export function resolveDnsPinnedFetch(fetchImpl: typeof fetch): typeof fetch | null {
  const pinnedFetchImpl = (fetchImpl as { [DNS_PINNED_FETCH]?: typeof fetch })[DNS_PINNED_FETCH];
  return pinnedFetchImpl ?? null;
}

export function supportsDnsPinnedFetch(fetchImpl: typeof fetch): boolean {
  return resolveDnsPinnedFetch(fetchImpl) !== null;
}

export function isNativeOrBoundGlobalFetch(fetchImpl: typeof fetch): boolean {
  if (fetchImpl === globalThis.fetch) return true;

  const expectedBoundName = `bound ${globalThis.fetch.name || "fetch"}`;
  return (
    fetchImpl.name === expectedBoundName &&
    Function.prototype.toString.call(fetchImpl).includes("[native code]")
  );
}

export function attachDnsPinnedAddresses<T extends RequestInit>(
  init: T,
  addresses: DnsPinnedAddress[],
): T {
  Object.defineProperty(init, DNS_PINNED_ADDRESSES, {
    configurable: true,
    enumerable: true,
    value: addresses,
  });
  return init;
}

export function readDnsPinnedAddresses(init: RequestInit | undefined): DnsPinnedAddress[] | null {
  const addresses = (init as { [DNS_PINNED_ADDRESSES]?: DnsPinnedAddress[] } | undefined)?.[
    DNS_PINNED_ADDRESSES
  ];
  return Array.isArray(addresses) && addresses.length > 0 ? addresses : null;
}
