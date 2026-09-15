import { lookup as dnsLookup } from "node:dns/promises";
import { createRequire } from "node:module";
import { fetchWithDnsPinnedAddresses } from "./dns-pinned-fetch.js";
import {
  attachDnsPinnedAddresses,
  isNativeOrBoundGlobalFetch,
  markFetchAsDnsPinned,
  resolveDnsPinnedFetch,
  supportsDnsPinnedFetch,
} from "./fetch-capabilities.js";
import {
  getNetworkAddressFamily,
  isBlockedNetworkAddress,
  isBlockedNetworkHostname,
  normalizeNetworkHostname,
} from "./network-safety.js";

export type NetworkLookupAddress = { address: string; family?: number };
export type NetworkLookup = (hostname: string) => Promise<NetworkLookupAddress[]>;

type LookupCallback = (
  error: Error | null,
  address: string | NetworkLookupAddress[],
  family?: number,
) => void;
type UndiciAgentConstructor = new (options: {
  autoSelectFamily?: boolean;
  autoSelectFamilyAttemptTimeout?: number;
  connect: {
    lookup: (hostname: string, options: unknown, callback: LookupCallback) => void;
  };
}) => unknown;
type UndiciModule = { Agent: UndiciAgentConstructor; fetch: typeof fetch };

export type NetworkGuardOptions = {
  targetLabel: string;
  lookup?: NetworkLookup;
  maxRedirects?: number;
  pinnedFetchImpl?: typeof fetch;
};

const DEFAULT_MAX_REDIRECTS = 10;
const require = createRequire(import.meta.url);

async function defaultLookup(hostname: string): Promise<NetworkLookupAddress[]> {
  return await dnsLookup(hostname, { all: true, verbatim: true });
}

function loadUndici(): UndiciModule {
  return require("undici") as UndiciModule;
}

function createPinnedDispatcher(addresses: NetworkLookupAddress[]): unknown {
  const { Agent } = loadUndici();
  const pinnedAddresses = addresses.map((entry) => ({
    address: entry.address,
    family: entry.family || getNetworkAddressFamily(entry.address) || 4,
  }));
  return new Agent({
    autoSelectFamily: true,
    autoSelectFamilyAttemptTimeout: 250,
    connect: {
      lookup: (_hostname, options, callback) => {
        if ((options as { all?: boolean } | undefined)?.all) {
          callback(null, pinnedAddresses);
          return;
        }
        const first = pinnedAddresses[0];
        callback(null, first?.address ?? "0.0.0.0", first?.family ?? 4);
      },
    },
  });
}

function isBunRuntime(): boolean {
  return typeof (process.versions as { bun?: string }).bun === "string";
}

function getInputUrl(input: Parameters<typeof fetch>[0]): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

function getMethod(input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]): string {
  return (
    init?.method ?? (typeof input !== "string" && !(input instanceof URL) ? input.method : "GET")
  ).toUpperCase();
}

function getRedirectMode(
  input: Parameters<typeof fetch>[0],
  init?: Parameters<typeof fetch>[1],
): RequestRedirect {
  return (
    init?.redirect ??
    (typeof input !== "string" && !(input instanceof URL) ? input.redirect : "follow") ??
    "follow"
  );
}

async function resolveNetworkTarget(
  rawUrl: string,
  {
    lookup = defaultLookup,
    targetLabel,
  }: {
    lookup?: NetworkLookup;
    targetLabel: string;
  },
): Promise<{ url: URL; addresses: NetworkLookupAddress[] }> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error(`${targetLabel} is invalid`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`${targetLabel} must use http or https`);
  }
  const hostname = normalizeNetworkHostname(url.hostname);
  if (isBlockedNetworkHostname(hostname)) {
    throw new Error(`${targetLabel} resolves to a blocked local network host`);
  }
  if (getNetworkAddressFamily(hostname) !== 0) {
    if (isBlockedNetworkAddress(hostname)) {
      throw new Error(`${targetLabel} resolves to a blocked local network address`);
    }
    return { url, addresses: [] };
  }
  const addresses = await lookup(hostname);
  if (addresses.length === 0 || addresses.some((entry) => isBlockedNetworkAddress(entry.address))) {
    throw new Error(`${targetLabel} resolves to a blocked local network address`);
  }
  return { url, addresses };
}

export async function assertNetworkTargetAllowed(
  rawUrl: string,
  options: Pick<NetworkGuardOptions, "targetLabel" | "lookup">,
): Promise<void> {
  await resolveNetworkTarget(rawUrl, options);
}

export function createNetworkGuardedFetch(
  fetchImpl: typeof fetch,
  {
    targetLabel,
    lookup = defaultLookup,
    maxRedirects = DEFAULT_MAX_REDIRECTS,
    pinnedFetchImpl,
  }: NetworkGuardOptions,
): typeof fetch {
  const guardedFetch = async (
    input: Parameters<typeof fetch>[0],
    init?: Parameters<typeof fetch>[1],
    redirectCount = 0,
  ): Promise<Response> => {
    const rawUrl = getInputUrl(input);
    const target = await resolveNetworkTarget(rawUrl, { lookup, targetLabel });
    const redirectMode = getRedirectMode(input, init);
    const requiresPinnedDns = target.addresses.length > 0;
    const isNativeFetch = isNativeOrBoundGlobalFetch(fetchImpl);
    if (requiresPinnedDns && !isNativeFetch && !supportsDnsPinnedFetch(fetchImpl)) {
      throw new Error(`${targetLabel} requires native fetch for DNS pinning`);
    }
    const pinnedInit = requiresPinnedDns
      ? attachDnsPinnedAddresses(
          {
            ...init,
            dispatcher: createPinnedDispatcher(target.addresses),
          } as Parameters<typeof fetch>[1] & { dispatcher: unknown },
          target.addresses,
        )
      : init;
    const fetchForPinnedDns = requiresPinnedDns
      ? isNativeFetch
        ? (pinnedFetchImpl ?? (isBunRuntime() ? fetchWithDnsPinnedAddresses : loadUndici().fetch))
        : (resolveDnsPinnedFetch(fetchImpl) ?? fetchImpl)
      : fetchImpl;
    if (redirectMode !== "follow") {
      return await fetchForPinnedDns(input, pinnedInit);
    }
    const response = await fetchForPinnedDns(input, { ...pinnedInit, redirect: "manual" });
    if (![301, 302, 303, 307, 308].includes(response.status)) {
      return response;
    }
    const location = response.headers.get("location");
    if (!location) return response;
    await response.body?.cancel().catch(() => {});
    if (redirectCount >= maxRedirects) {
      throw new Error(`${targetLabel} redirected too many times`);
    }
    const method = getMethod(input, init);
    if (method !== "GET" && method !== "HEAD") {
      throw new Error(`${targetLabel} redirected a non-GET request`);
    }
    const nextUrl = new URL(location, response.url || target.url.href).href;
    const request = typeof input !== "string" && !(input instanceof URL) ? input : null;
    const headers = new Headers(init?.headers ?? request?.headers);
    if (new URL(nextUrl).origin !== target.url.origin) {
      for (const name of ["authorization", "proxy-authorization", "cookie", "cookie2"]) {
        headers.delete(name);
      }
    }
    return await guardedFetch(
      request ? new Request(nextUrl, request) : nextUrl,
      { ...init, body: null, method, headers },
      redirectCount + 1,
    );
  };
  return markFetchAsDnsPinned(guardedFetch as typeof fetch);
}
