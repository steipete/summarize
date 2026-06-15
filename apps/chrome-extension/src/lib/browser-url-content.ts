import { extractBrowserHtmlContent } from "@steipete/summarize-core/content/browser-html";
import {
  getNetworkAddressFamily,
  isBlockedNetworkAddress,
  isBlockedNetworkHostname,
} from "@steipete/summarize-core/content/network-safety";

const MAX_HTML_BYTES = 8_000_000;
const MAX_REDIRECTS = 10;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

type PublicAddressRequestInit = RequestInit & {
  targetAddressSpace: "public";
};

async function readResponseText(response: Response): Promise<string> {
  if (!response.body) {
    const text = await response.text();
    if (new TextEncoder().encode(text).byteLength > MAX_HTML_BYTES) {
      throw new Error("Linked page is too large to summarize in the browser.");
    }
    return text;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const chunks: string[] = [];
  let byteLength = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      byteLength += value.byteLength;
      if (byteLength > MAX_HTML_BYTES) {
        await reader.cancel().catch(() => {});
        throw new Error("Linked page is too large to summarize in the browser.");
      }
      chunks.push(decoder.decode(value, { stream: true }));
    }
    chunks.push(decoder.decode());
    return chunks.join("");
  } finally {
    reader.releaseLock();
  }
}

export function isPublicBrowserUrl(rawUrl: string): boolean {
  try {
    const url = new URL(rawUrl);
    if (url.protocol !== "http:" && url.protocol !== "https:") return false;
    const hostname = url.hostname.toLowerCase();
    if (!hostname || isBlockedNetworkHostname(hostname)) return false;
    if (getNetworkAddressFamily(hostname) !== 0 && isBlockedNetworkAddress(hostname)) return false;
    return true;
  } catch {
    return false;
  }
}

export async function fetchBrowserUrlContent(options: {
  url: string;
  maxCharacters: number;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
}) {
  if (!isPublicBrowserUrl(options.url)) {
    throw new Error("Browser extraction only supports public HTTP(S) URLs.");
  }
  const fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
  let currentUrl = options.url;
  let response: Response | undefined;
  for (let redirectCount = 0; redirectCount <= MAX_REDIRECTS; redirectCount += 1) {
    const requestInit: PublicAddressRequestInit = {
      headers: {
        Accept: "text/html,application/xhtml+xml;q=0.9,text/plain;q=0.8",
      },
      redirect: "manual",
      signal: options.signal,
      // Chrome rejects the request if DNS resolves this hostname into a private address space.
      targetAddressSpace: "public",
    };
    response = await fetchImpl(currentUrl, requestInit);
    const responseUrl = response.url || currentUrl;
    if (!isPublicBrowserUrl(responseUrl)) {
      throw new Error("Browser extraction redirected to a non-public HTTP(S) URL.");
    }
    if (!REDIRECT_STATUSES.has(response.status)) {
      currentUrl = responseUrl;
      break;
    }
    if (redirectCount >= MAX_REDIRECTS) {
      throw new Error("Browser extraction redirected too many times.");
    }
    const location = response.headers.get("location");
    if (!location) {
      throw new Error("Browser extraction received a redirect without a location.");
    }
    const nextUrl = new URL(location, responseUrl).href;
    if (!isPublicBrowserUrl(nextUrl)) {
      throw new Error("Browser extraction redirected to a non-public HTTP(S) URL.");
    }
    currentUrl = nextUrl;
  }
  if (!response) throw new Error("Browser extraction failed before receiving a response.");
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}`.trim());
  const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
  if (
    contentType &&
    !contentType.includes("text/html") &&
    !contentType.includes("application/xhtml+xml") &&
    !contentType.includes("text/plain")
  ) {
    throw new Error(`Unsupported linked content type: ${contentType.split(";")[0]}`);
  }
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_HTML_BYTES) {
    throw new Error("Linked page is too large to summarize in the browser.");
  }
  const html = await readResponseText(response);
  const content = await extractBrowserHtmlContent({
    html,
    url: currentUrl,
    maxCharacters: options.maxCharacters,
  });
  if (!content.text.trim()) throw new Error("No readable text found on the linked page.");
  return content;
}
