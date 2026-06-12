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

function embeddedIpv4(parts: number[]): string {
  const sixth = parts[6] ?? 0;
  const eighth = parts[7] ?? 0;
  return `${(sixth >> 8) & 0xff}.${sixth & 0xff}.${(eighth >> 8) & 0xff}.${eighth & 0xff}`;
}

function isBlockedIpv6(address: string): boolean {
  const parts = expandIpv6(address);
  if (!parts) return true;
  const [first, second, third, fourth, , sixth, , eighth] = parts;
  const allZero = parts.every((part) => part === 0);
  const loopback = parts.slice(0, 7).every((part) => part === 0) && eighth === 1;
  const mappedIpv4 = parts.slice(0, 5).every((part) => part === 0) && sixth === 0xffff;
  const translatedIpv4 =
    parts.slice(0, 4).every((part) => part === 0) && parts[4] === 0xffff && parts[5] === 0;
  const compatibleIpv4 = parts.slice(0, 6).every((part) => part === 0) && !allZero && !loopback;
  if (mappedIpv4 || translatedIpv4 || compatibleIpv4) {
    return isBlockedIpv4(embeddedIpv4(parts));
  }
  const wellKnownNat64 =
    first === 0x64 && second === 0xff9b && parts.slice(2, 6).every((part) => part === 0);
  if (wellKnownNat64) {
    return isBlockedIpv4(embeddedIpv4(parts));
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

export function normalizeNetworkHostname(hostname: string): string {
  return hostname.trim().replace(/^\[|\]$/g, "");
}

export function isBlockedNetworkHostname(hostname: string): boolean {
  const host = normalizeNetworkHostname(hostname).toLowerCase().replace(/\.$/, "");
  return host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local");
}

export function getNetworkAddressFamily(address: string): 0 | 4 | 6 {
  const normalized = normalizeNetworkHostname(address);
  if (parseIpv4(normalized)) return 4;
  if (normalized.includes(":") && expandIpv6(normalized)) return 6;
  return 0;
}

export function isBlockedNetworkAddress(address: string): boolean {
  const normalized = normalizeNetworkHostname(address);
  const family = getNetworkAddressFamily(normalized);
  if (family === 4) return isBlockedIpv4(normalized);
  if (family === 6) return isBlockedIpv6(normalized);
  return true;
}
