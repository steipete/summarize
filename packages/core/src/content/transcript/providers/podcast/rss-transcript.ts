import { lookup as dnsLookup } from "node:dns/promises";
import { createRequire } from "node:module";
import { isIP } from "node:net";
import type { TranscriptSegment } from "../../../link-preview/types.js";
import {
  jsonTranscriptToPlainText,
  jsonTranscriptToSegments,
  vttToPlainText,
  vttToSegments,
} from "../../parse.js";
import { TRANSCRIPTION_TIMEOUT_MS } from "./constants.js";
import {
  decodeXmlEntities,
  extractFeedItems,
  extractItemTitle,
  normalizeLooseTitle,
} from "./rss-feed.js";

type TranscriptCandidate = { url: string; type: string | null };
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

const MAX_TRANSCRIPT_REDIRECTS = 10;
const require = createRequire(import.meta.url);

export async function tryFetchTranscriptFromFeedXml({
  fetchImpl,
  feedXml,
  episodeTitle,
  notes,
  lookup,
}: {
  fetchImpl: typeof fetch;
  feedXml: string;
  episodeTitle: string | null;
  notes: string[];
  lookup?: LookupFn;
}): Promise<{
  text: string;
  transcriptUrl: string;
  transcriptType: string | null;
  segments: TranscriptSegment[] | null;
} | null> {
  const items = extractFeedItems(feedXml);
  const normalizedTarget = episodeTitle ? normalizeLooseTitle(episodeTitle) : null;

  for (const item of items) {
    if (normalizedTarget) {
      const title = extractItemTitle(item);
      if (!title || normalizeLooseTitle(title) !== normalizedTarget) continue;
    }

    const preferred = selectPreferredTranscriptCandidate(
      extractPodcastTranscriptCandidatesFromItem(item),
    );
    if (!preferred) {
      if (normalizedTarget) return null;
      continue;
    }

    const transcriptUrl = decodeXmlEntities(preferred.url);
    try {
      const res = await fetchTranscriptUrl(fetchImpl, transcriptUrl, {
        lookup,
        signal: AbortSignal.timeout(TRANSCRIPTION_TIMEOUT_MS),
        headers: { accept: "text/vtt,text/plain,application/json;q=0.9,*/*;q=0.8" },
      });
      if (!res.ok) throw new Error(`transcript fetch failed (${res.status})`);

      const contentType =
        res.headers.get("content-type")?.toLowerCase().split(";")[0]?.trim() ?? null;
      const effectiveType = preferred.type?.toLowerCase().split(";")[0]?.trim() ?? contentType;
      const body = await res.text();
      const parsed = parseTranscriptBody({
        body,
        transcriptUrl,
        effectiveType,
      });
      if (!parsed.text) {
        if (normalizedTarget) return null;
        continue;
      }

      notes.push("Used RSS <podcast:transcript> (skipped Whisper)");
      return {
        text: parsed.text,
        transcriptUrl,
        transcriptType: effectiveType,
        segments: parsed.segments,
      };
    } catch (error) {
      if (normalizedTarget) {
        notes.push(
          `RSS <podcast:transcript> fetch failed: ${error instanceof Error ? error.message : String(error)}`,
        );
        return null;
      }
    }
  }

  return null;
}

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
    (a === 192 && b === 0) ||
    (a === 198 && (b === 18 || b === 19)) ||
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
  const [first, second, , , , fifth, sixth, eighth] = parts;
  const allZero = parts.every((part) => part === 0);
  const loopback = parts.slice(0, 7).every((part) => part === 0) && eighth === 1;
  const mappedIpv4 = parts.slice(0, 5).every((part) => part === 0) && fifth === 0xffff;
  const compatibleIpv4 = parts.slice(0, 6).every((part) => part === 0) && !allZero && !loopback;
  if (mappedIpv4 || compatibleIpv4) {
    const ipv4 = `${((sixth ?? 0) >> 8) & 0xff}.${(sixth ?? 0) & 0xff}.${((eighth ?? 0) >> 8) & 0xff}.${(eighth ?? 0) & 0xff}`;
    return isBlockedIpv4(ipv4);
  }
  return (
    allZero ||
    loopback ||
    ((first ?? 0) & 0xfe00) === 0xfc00 ||
    ((first ?? 0) & 0xffc0) === 0xfe80 ||
    ((first ?? 0) & 0xff00) === 0xff00 ||
    (first === 0x2001 && second === 0xdb8)
  );
}

function isBlockedNetworkAddress(address: string): boolean {
  const normalized = address.trim().replace(/^\[|\]$/g, "");
  const family = isIP(normalized);
  if (family === 4) return isBlockedIpv4(normalized);
  if (family === 6) return isBlockedIpv6(normalized);
  return true;
}

function normalizeUrlHostname(hostname: string): string {
  return hostname.trim().replace(/^\[|\]$/g, "");
}

function isBlockedHostname(hostname: string): boolean {
  const host = normalizeUrlHostname(hostname).toLowerCase().replace(/\.$/, "");
  return host === "localhost" || host.endsWith(".localhost");
}

async function defaultLookup(hostname: string): Promise<LookupAddress[]> {
  return await dnsLookup(hostname, { all: true, verbatim: true });
}

async function resolveTranscriptFetchTarget(
  rawUrl: string,
  { lookup = defaultLookup }: { lookup?: LookupFn } = {},
): Promise<{ url: URL; addresses: LookupAddress[] }> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error("RSS transcript URL is invalid");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("RSS transcript URL must use http or https");
  }
  const hostname = normalizeUrlHostname(url.hostname);
  if (isBlockedHostname(hostname)) {
    throw new Error("RSS transcript URL resolves to a blocked local network host");
  }
  if (isIP(hostname)) {
    if (isBlockedNetworkAddress(hostname)) {
      throw new Error("RSS transcript URL resolves to a blocked local network address");
    }
    return { url, addresses: [] };
  }
  const addresses = await lookup(hostname);
  if (addresses.length === 0 || addresses.some((entry) => isBlockedNetworkAddress(entry.address))) {
    throw new Error("RSS transcript URL resolves to a blocked local network address");
  }
  return { url, addresses };
}

function isNativeFetchImpl(fetchImpl: typeof fetch): boolean {
  return fetchImpl === globalThis.fetch || fetchImpl.name === "bound fetch";
}

function loadUndici(): UndiciModule {
  return require("undici") as UndiciModule;
}

function createPinnedDispatcher(addresses: LookupAddress[]): unknown {
  const { Agent } = loadUndici();
  const pinnedAddresses = addresses.map((entry) => ({
    address: entry.address,
    family: entry.family ?? (isIP(entry.address) || 4),
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

async function fetchTranscriptUrl(
  fetchImpl: typeof fetch,
  rawUrl: string,
  options: {
    lookup?: LookupFn;
    signal?: AbortSignal;
    headers?: HeadersInit;
  },
  redirectCount = 0,
): Promise<Response> {
  const target = await resolveTranscriptFetchTarget(rawUrl, { lookup: options.lookup });
  const pinnedInit =
    target.addresses.length > 0
      ? ({
          headers: options.headers,
          signal: options.signal,
          redirect: "manual",
          dispatcher: createPinnedDispatcher(target.addresses),
        } as RequestInit & { dispatcher: unknown })
      : ({ headers: options.headers, signal: options.signal, redirect: "manual" } as RequestInit);
  const pinnedFetchImpl =
    target.addresses.length > 0 && isNativeFetchImpl(fetchImpl) ? loadUndici().fetch : fetchImpl;
  const response = await pinnedFetchImpl(target.url.href, pinnedInit);
  if (![301, 302, 303, 307, 308].includes(response.status)) return response;
  const location = response.headers.get("location");
  if (!location) return response;
  if (redirectCount >= MAX_TRANSCRIPT_REDIRECTS) {
    throw new Error("RSS transcript URL redirected too many times");
  }
  const nextUrl = new URL(location, target.url.href).href;
  return await fetchTranscriptUrl(fetchImpl, nextUrl, options, redirectCount + 1);
}

function extractPodcastTranscriptCandidatesFromItem(itemXml: string): TranscriptCandidate[] {
  const matches = itemXml.matchAll(
    /<podcast:transcript\b[^>]*\burl\s*=\s*(['"])([^'"]+)\1[^>]*>/gi,
  );
  const results: TranscriptCandidate[] = [];
  for (const match of matches) {
    const tag = match[0];
    const url = match[2]?.trim();
    if (!url) continue;
    const type = tag.match(/\btype\s*=\s*(['"])([^'"]+)\1/i)?.[2]?.trim() ?? null;
    results.push({ url, type });
  }
  return results;
}

function selectPreferredTranscriptCandidate(
  candidates: TranscriptCandidate[],
): TranscriptCandidate | null {
  if (candidates.length === 0) return null;
  const normalized = candidates.map((candidate) => ({
    ...candidate,
    type: candidate.type?.toLowerCase().split(";")[0]?.trim() ?? null,
  }));

  const json = normalized.find(
    (candidate) =>
      candidate.type === "application/json" || candidate.url.toLowerCase().endsWith(".json"),
  );
  if (json) return json;

  const vtt = normalized.find(
    (candidate) => candidate.type === "text/vtt" || candidate.url.toLowerCase().endsWith(".vtt"),
  );
  if (vtt) return vtt;

  return normalized[0] ?? null;
}

function parseTranscriptBody(args: {
  body: string;
  transcriptUrl: string;
  effectiveType: string | null;
}): { text: string | null; segments: TranscriptSegment[] | null } {
  const { body, transcriptUrl, effectiveType } = args;
  if (effectiveType === "application/json" || transcriptUrl.toLowerCase().endsWith(".json")) {
    try {
      const payload = JSON.parse(body);
      return {
        text: jsonTranscriptToPlainText(payload),
        segments: jsonTranscriptToSegments(payload),
      };
    } catch {
      return { text: null, segments: null };
    }
  }
  if (effectiveType === "text/vtt" || transcriptUrl.toLowerCase().endsWith(".vtt")) {
    const plain = vttToPlainText(body);
    return {
      text: plain.length > 0 ? plain : null,
      segments: vttToSegments(body),
    };
  }
  const plain = body.trim();
  return {
    text: plain.length > 0 ? plain : null,
    segments: null,
  };
}
