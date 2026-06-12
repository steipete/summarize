import { lookup as dnsLookup } from "node:dns/promises";
import { createRequire } from "node:module";
import { isIP } from "node:net";
import { fetchWithDnsPinnedAddresses } from "@steipete/summarize-core/content";
import {
  attachDnsPinnedAddresses,
  isNativeOrBoundGlobalFetch,
  markFetchAsDnsPinned,
  resolveDnsPinnedFetch,
  supportsDnsPinnedFetch,
} from "@steipete/summarize-core/content";

type LookupAddress = { address: string; family?: number };
type LookupFn = (hostname: string) => Promise<LookupAddress[]>;
type LookupCallback = (
  error: Error | null,
  address: string | LookupAddress[],
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

const MAX_REDIRECTS = 10;
const require = createRequire(import.meta.url);

function parseIpv4(address: string): number[] | null {
  const parts = address.split(".");
  if (parts.length !== 4) return null;
  const octets = parts.map((part) => {
    if (!/^\d{1,3}$/.test(part)) return null;
    const value = Number(part);
    return Number.isInteger(value) && value >= 0 && value <= 255 ? value : null;
  });
  return octets.every((value) => value != null) ? (octets as number[]) : null;
}

function isBlockedIpv4(address: string): boolean {
  const octets = parseIpv4(address);
  if (!octets) return true;
  const [a, b] = octets;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 192 && b === 0 && (octets[2] === 0 || octets[2] === 2)) ||
    (a === 198 && (b === 18 || b === 19)) ||
    (a === 198 && b === 51 && octets[2] === 100) ||
    (a === 203 && b === 0 && octets[2] === 113) ||
    a >= 224
  );
}

function expandIpv6(address: string): number[] | null {
  const normalized = address.split("%", 1)[0]?.toLowerCase() ?? "";
  if (!normalized) return null;
  const mapped = normalized.match(/^(.*:)(\d{1,3}(?:\.\d{1,3}){3})$/);
  const ipv4 = mapped ? parseIpv4(mapped[2] ?? "") : null;
  const head = mapped ? (mapped[1] ?? "") : normalized;
  const partsAroundGap = head.split("::");
  if (partsAroundGap.length > 2) return null;
  const [leftRaw, rightRaw] = partsAroundGap;
  const left = leftRaw ? leftRaw.split(":").filter(Boolean) : [];
  const right = typeof rightRaw === "string" && rightRaw ? rightRaw.split(":").filter(Boolean) : [];
  const ipv4Parts = ipv4
    ? [((ipv4[0] ?? 0) << 8) | (ipv4[1] ?? 0), ((ipv4[2] ?? 0) << 8) | (ipv4[3] ?? 0)]
    : [];
  const missing = 8 - left.length - right.length - ipv4Parts.length;
  if (missing < 0 || (partsAroundGap.length === 1 && missing !== 0)) return null;
  const parsePart = (part: string) => (/^[0-9a-f]{1,4}$/.test(part) ? parseInt(part, 16) : -1);
  const parts = [
    ...left.map(parsePart),
    ...Array.from({ length: missing }, () => 0),
    ...right.map(parsePart),
    ...ipv4Parts,
  ];
  return parts.length === 8 && parts.every((part) => part >= 0 && part <= 0xffff) ? parts : null;
}

function isBlockedIpv6(address: string): boolean {
  const parts = expandIpv6(address);
  if (!parts) return true;
  const [first, second, third, fourth, , fifth, sixth, eighth] = parts;
  const allZero = parts.every((part) => part === 0);
  const loopback = parts.slice(0, 7).every((part) => part === 0) && eighth === 1;
  const mappedIpv4 = parts.slice(0, 5).every((part) => part === 0) && fifth === 0xffff;
  const compatibleIpv4 = parts.slice(0, 6).every((part) => part === 0) && !allZero && !loopback;
  if (mappedIpv4 || compatibleIpv4) {
    const ipv4 = `${((sixth ?? 0) >> 8) & 0xff}.${(sixth ?? 0) & 0xff}.${((eighth ?? 0) >> 8) & 0xff}.${(eighth ?? 0) & 0xff}`;
    return isBlockedIpv4(ipv4);
  }
  const wellKnownNat64 =
    first === 0x64 && second === 0xff9b && parts.slice(2, 6).every((part) => part === 0);
  if (wellKnownNat64) {
    const ipv4 = `${((sixth ?? 0) >> 8) & 0xff}.${(sixth ?? 0) & 0xff}.${((eighth ?? 0) >> 8) & 0xff}.${(eighth ?? 0) & 0xff}`;
    return isBlockedIpv4(ipv4);
  }
  return (
    allZero ||
    loopback ||
    (first === 0x64 && second === 0xff9b && third === 1) ||
    (first === 0x100 && second === 0 && third === 0 && fourth === 0) ||
    ((first ?? 0) & 0xfe00) === 0xfc00 ||
    ((first ?? 0) & 0xffc0) === 0xfe80 ||
    ((first ?? 0) & 0xff00) === 0xff00 ||
    (first === 0x2001 && (second ?? 0) <= 0x01ff) ||
    (first === 0x2001 && second === 0xdb8) ||
    first === 0x2002 ||
    (first === 0x3fff && (second ?? 0) <= 0x0fff) ||
    first === 0x5f00
  );
}

export function isBlockedNetworkAddress(address: string): boolean {
  const normalized = address.trim().replace(/^\[|\]$/g, "");
  const family = isIP(normalized);
  if (family === 4) return isBlockedIpv4(normalized);
  if (family === 6) return isBlockedIpv6(normalized);
  return true;
}

function isBlockedHostname(hostname: string): boolean {
  const host = normalizeUrlHostname(hostname).toLowerCase().replace(/\.$/, "");
  return host === "localhost" || host.endsWith(".localhost");
}

async function defaultLookup(hostname: string): Promise<LookupAddress[]> {
  return await dnsLookup(hostname, { all: true, verbatim: true });
}

function normalizeUrlHostname(hostname: string): string {
  return hostname.trim().replace(/^\[|\]$/g, "");
}

async function resolveDaemonUrlFetchTarget(
  rawUrl: string,
  { lookup = defaultLookup }: { lookup?: LookupFn } = {},
): Promise<{ url: URL; addresses: LookupAddress[] }> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error("URL fetch target is invalid");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("URL fetch target must use http or https");
  }
  const hostname = normalizeUrlHostname(url.hostname);
  if (isBlockedHostname(hostname)) {
    throw new Error("URL fetch target resolves to a blocked local network host");
  }
  if (isIP(hostname)) {
    if (isBlockedNetworkAddress(hostname)) {
      throw new Error("URL fetch target resolves to a blocked local network address");
    }
    return { url, addresses: [] };
  }
  const addresses = await lookup(hostname);
  if (addresses.length === 0 || addresses.some((entry) => isBlockedNetworkAddress(entry.address))) {
    throw new Error("URL fetch target resolves to a blocked local network address");
  }
  return { url, addresses };
}

export async function assertDaemonUrlFetchAllowed(
  rawUrl: string,
  options?: { lookup?: LookupFn },
): Promise<void> {
  await resolveDaemonUrlFetchTarget(rawUrl, options);
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

function isNativeFetchImpl(fetchImpl: typeof fetch): boolean {
  return isNativeOrBoundGlobalFetch(fetchImpl);
}

function isBunRuntime(): boolean {
  return typeof (process.versions as { bun?: string }).bun === "string";
}

export function createDaemonUrlFetchGuard(
  fetchImpl: typeof fetch,
  {
    lookup = defaultLookup,
    pinnedFetchImpl,
  }: { lookup?: LookupFn; pinnedFetchImpl?: typeof fetch } = {},
): typeof fetch {
  const loadUndici = (): UndiciModule => require("undici") as UndiciModule;
  const createPinnedDispatcher = (addresses: LookupAddress[]) => {
    const { Agent } = loadUndici();
    const pinnedAddresses = addresses.map((address) => ({
      address: address.address,
      family: address.family ?? (isIP(address.address) || 4),
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
  };

  const guardedFetch = async (
    input: Parameters<typeof fetch>[0],
    init?: Parameters<typeof fetch>[1],
    redirectCount = 0,
  ): Promise<Response> => {
    const url = getInputUrl(input);
    const target = await resolveDaemonUrlFetchTarget(url, { lookup });
    const redirectMode = getRedirectMode(input, init);
    const requiresPinnedDns = target.addresses.length > 0;
    const isNativeFetch = isNativeFetchImpl(fetchImpl);
    if (requiresPinnedDns && !isNativeFetch && !supportsDnsPinnedFetch(fetchImpl)) {
      throw new Error("URL fetch target requires native fetch for DNS pinning");
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
    if (redirectCount >= MAX_REDIRECTS) {
      throw new Error("URL fetch redirected too many times");
    }
    const method = getMethod(input, init);
    if (method !== "GET" && method !== "HEAD") {
      throw new Error("URL fetch target redirected a non-GET request");
    }
    const nextUrl = new URL(location, response.url || url).href;
    return await guardedFetch(nextUrl, { ...init, body: null, method }, redirectCount + 1);
  };
  return markFetchAsDnsPinned(guardedFetch as typeof fetch);
}
