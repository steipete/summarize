import http from "node:http";
import https from "node:https";
import { Readable } from "node:stream";
import { readDnsPinnedAddresses, type DnsPinnedAddress } from "./fetch-capabilities.js";

// DNS pinning must connect directly; an environment proxy would resolve the hostname itself.
const directHttpAgent = new http.Agent({ proxyEnv: {} });
const directHttpsAgent = new https.Agent({ proxyEnv: {} });

type PinnedLookupAddress = { address: string; family: number };
type LookupCallback = (
  error: Error | null,
  address: string | PinnedLookupAddress[],
  family?: number,
) => void;

function getInputUrl(input: RequestInfo | URL): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

function createPinnedLookup(addresses: DnsPinnedAddress[]) {
  const pinnedAddresses: PinnedLookupAddress[] = addresses.map((entry) => ({
    address: entry.address,
    family: entry.family ?? 4,
  }));
  return (_hostname: string, options: unknown, callback: LookupCallback): void => {
    if ((options as { all?: boolean } | undefined)?.all) {
      callback(null, pinnedAddresses);
      return;
    }
    const first = pinnedAddresses[0];
    callback(null, first?.address ?? "0.0.0.0", first?.family ?? 4);
  };
}

function headersFrom(input: RequestInfo | URL, init?: RequestInit): Headers {
  if (init?.headers) return new Headers(init.headers);
  if (typeof input !== "string" && !(input instanceof URL)) return new Headers(input.headers);
  return new Headers();
}

function methodFrom(input: RequestInfo | URL, init?: RequestInit): string {
  if (init?.method) return init.method;
  if (typeof input !== "string" && !(input instanceof URL)) return input.method;
  return "GET";
}

function hasRequestBody(input: RequestInfo | URL, init?: RequestInit): boolean {
  if (init && "body" in init && init.body != null) return true;
  if (typeof input !== "string" && !(input instanceof URL)) return input.body != null;
  return false;
}

export async function fetchWithDnsPinnedAddresses(
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> {
  const addresses = readDnsPinnedAddresses(init);
  if (!addresses) throw new Error("Pinned DNS fetch missing validated addresses");
  if (hasRequestBody(input, init)) {
    throw new Error("Pinned DNS fetch does not support request bodies");
  }

  const url = new URL(getInputUrl(input));
  const method = methodFrom(input, init);
  const signal =
    init?.signal !== undefined
      ? init.signal
      : typeof input !== "string" && !(input instanceof URL)
        ? input.signal
        : undefined;
  const client = url.protocol === "https:" ? https : http;
  const headers: Record<string, string> = {};
  headersFrom(input, init).forEach((value, key) => {
    headers[key] = value;
  });

  return await new Promise<Response>((resolve, reject) => {
    const req = client.request(
      url,
      {
        agent: url.protocol === "https:" ? directHttpsAgent : directHttpAgent,
        headers,
        lookup: createPinnedLookup(addresses),
        method,
        ...(signal ? { signal } : {}),
      },
      (res) => {
        const responseHeaders = new Headers();
        for (const [key, value] of Object.entries(res.headers)) {
          if (Array.isArray(value)) {
            for (const entry of value) responseHeaders.append(key, entry);
          } else if (typeof value === "string") {
            responseHeaders.set(key, value);
          }
        }
        try {
          const status = res.statusCode ?? 200;
          const nullBody = method.toUpperCase() === "HEAD" || [204, 205, 304].includes(status);
          const response = new Response(
            nullBody ? null : (Readable.toWeb(res) as ReadableStream<Uint8Array>),
            { headers: responseHeaders, status, statusText: res.statusMessage },
          );
          if (nullBody) {
            res.on("error", reject);
            res.resume();
          }
          Object.defineProperty(response, "url", { configurable: true, value: url.href });
          resolve(response);
        } catch (error) {
          res.destroy();
          reject(error);
        }
      },
    );
    req.on("error", reject);
    req.end();
  });
}
