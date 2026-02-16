import type {
  FirecrawlScrapeResult,
  LinkPreviewProgressEvent,
  ScrapeWithFirecrawl,
} from "../deps.js";
import type { CacheMode, FirecrawlDiagnostics } from "../types.js";
import { isYouTubeUrl } from "../../url.js";
import { appendNote } from "./utils.js";

const REQUEST_HEADERS: Record<string, string> = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36",
  Accept:
    "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8",
  "Accept-Encoding": "gzip, deflate",
  "Accept-Language": "en-US,en;q=0.9",
  "Cache-Control": "no-cache",
  Pragma: "no-cache",
};

/** Detect Bun's streaming decompression errors (ZlibError / ShortRead). */
function isZlibError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const msg = error.message;
  return msg.includes("ZlibError") || msg.includes("ShortRead") || msg.includes("Decompression error");
}

const DEFAULT_REQUEST_TIMEOUT_MS = 5000;

export interface FirecrawlFetchResult {
  payload: FirecrawlScrapeResult | null;
  diagnostics: FirecrawlDiagnostics;
}

export interface HtmlDocumentFetchResult {
  html: string;
  finalUrl: string;
}

async function fetchHtmlOnce(
  fetchImpl: typeof fetch,
  url: string,
  headers: Record<string, string>,
  {
    timeoutMs,
    onProgress,
  }: { timeoutMs?: number; onProgress?: ((event: LinkPreviewProgressEvent) => void) | null } = {},
): Promise<HtmlDocumentFetchResult> {
  onProgress?.({ kind: "fetch-html-start", url });

  const controller = new AbortController();
  const effectiveTimeoutMs =
    typeof timeoutMs === "number" && Number.isFinite(timeoutMs)
      ? timeoutMs
      : DEFAULT_REQUEST_TIMEOUT_MS;
  const timeout = setTimeout(() => {
    controller.abort();
  }, effectiveTimeoutMs);

  try {
    const response = await fetchImpl(url, {
      headers,
      redirect: "follow",
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new Error(`Failed to fetch HTML document (status ${response.status})`);
    }

    const finalUrl = response.url?.trim() || url;

    const contentType = response.headers.get("content-type")?.toLowerCase() ?? null;
    if (
      contentType &&
      !contentType.includes("text/html") &&
      !contentType.includes("application/xhtml+xml") &&
      !contentType.includes("application/xml") &&
      !contentType.includes("text/xml") &&
      !contentType.includes("application/rss+xml") &&
      !contentType.includes("application/atom+xml") &&
      !contentType.startsWith("text/")
    ) {
      throw new Error(`Unsupported content-type for HTML document fetch: ${contentType}`);
    }

    const totalBytes = (() => {
      const raw = response.headers.get("content-length");
      if (!raw) return null;
      const parsed = Number(raw);
      return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : null;
    })();

    const body = response.body;
    if (!body) {
      const text = await response.text();
      const bytes = new TextEncoder().encode(text).byteLength;
      onProgress?.({ kind: "fetch-html-done", url, downloadedBytes: bytes, totalBytes });
      return { html: text, finalUrl };
    }

    const reader = body.getReader();
    const decoder = new TextDecoder();
    let downloadedBytes = 0;
    let text = "";

    onProgress?.({ kind: "fetch-html-progress", url, downloadedBytes: 0, totalBytes });

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (!value) continue;
      downloadedBytes += value.byteLength;
      text += decoder.decode(value, { stream: true });
      onProgress?.({ kind: "fetch-html-progress", url, downloadedBytes, totalBytes });
    }

    text += decoder.decode();
    onProgress?.({ kind: "fetch-html-done", url, downloadedBytes, totalBytes });
    return { html: text, finalUrl };
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      throw new Error("Fetching HTML document timed out");
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

export async function fetchHtmlDocument(
  fetchImpl: typeof fetch,
  url: string,
  options: { timeoutMs?: number; onProgress?: ((event: LinkPreviewProgressEvent) => void) | null } = {},
): Promise<HtmlDocumentFetchResult> {
  try {
    return await fetchHtmlOnce(fetchImpl, url, REQUEST_HEADERS, options);
  } catch (error) {
    // Bun's fetch has known bugs where its streaming zlib decompression throws
    // ZlibError / ShortRead on certain chunked+compressed responses. Retry the
    // request asking the server to skip compression entirely.
    // https://github.com/oven-sh/bun/issues/23149
    if (isZlibError(error)) {
      const uncompressedHeaders = { ...REQUEST_HEADERS, "Accept-Encoding": "identity" };
      return await fetchHtmlOnce(fetchImpl, url, uncompressedHeaders, options);
    }
    throw error;
  }
}

export async function fetchWithFirecrawl(
  url: string,
  scrapeWithFirecrawl: ScrapeWithFirecrawl | null,
  options: {
    timeoutMs?: number;
    cacheMode?: CacheMode;
    onProgress?: ((event: LinkPreviewProgressEvent) => void) | null;
    reason?: string | null;
  } = {},
): Promise<FirecrawlFetchResult> {
  const timeoutMs = options.timeoutMs;
  const cacheMode: CacheMode = options.cacheMode ?? "default";
  const onProgress = typeof options.onProgress === "function" ? options.onProgress : null;
  const reason = typeof options.reason === "string" ? options.reason : null;
  const diagnostics: FirecrawlDiagnostics = {
    attempted: false,
    used: false,
    cacheMode,
    cacheStatus: cacheMode === "bypass" ? "bypassed" : "unknown",
    notes: null,
  };

  if (isYouTubeUrl(url)) {
    diagnostics.notes = appendNote(diagnostics.notes, "Skipped Firecrawl for YouTube URL");
    return { payload: null, diagnostics };
  }

  if (!scrapeWithFirecrawl) {
    diagnostics.notes = appendNote(diagnostics.notes, "Firecrawl is not configured");
    return { payload: null, diagnostics };
  }

  diagnostics.attempted = true;
  onProgress?.({ kind: "firecrawl-start", url, reason: reason ?? "firecrawl" });

  try {
    const payload = await scrapeWithFirecrawl(url, { timeoutMs, cacheMode });
    if (!payload) {
      diagnostics.notes = appendNote(diagnostics.notes, "Firecrawl returned no content payload");
      onProgress?.({
        kind: "firecrawl-done",
        url,
        ok: false,
        markdownBytes: null,
        htmlBytes: null,
      });
      return { payload: null, diagnostics };
    }

    const encoder = new TextEncoder();
    const markdownBytes =
      typeof payload.markdown === "string" ? encoder.encode(payload.markdown).byteLength : null;
    const htmlBytes =
      typeof payload.html === "string" ? encoder.encode(payload.html).byteLength : null;
    onProgress?.({ kind: "firecrawl-done", url, ok: true, markdownBytes, htmlBytes });

    return { payload, diagnostics };
  } catch (error) {
    diagnostics.notes = appendNote(
      diagnostics.notes,
      `Firecrawl error: ${error instanceof Error ? error.message : "unknown error"}`,
    );
    onProgress?.({ kind: "firecrawl-done", url, ok: false, markdownBytes: null, htmlBytes: null });
    return { payload: null, diagnostics };
  }
}
