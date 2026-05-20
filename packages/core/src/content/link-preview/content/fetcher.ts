import {
  isBunCompressedResponseError,
  withBunCompressionHeaders,
  withBunIdentityEncoding,
} from "../../bun.js";
import { isYouTubeUrl } from "../../url.js";
import type {
  FirecrawlScrapeResult,
  LinkPreviewProgressEvent,
  ScrapeWithFirecrawl,
} from "../deps.js";
import type { CacheMode, FirecrawlDiagnostics } from "../types.js";
import { appendNote } from "./utils.js";

const REQUEST_HEADERS: Record<string, string> = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36",
  Accept:
    "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9",
  "Cache-Control": "no-cache",
  Pragma: "no-cache",
};

const DEFAULT_REQUEST_TIMEOUT_MS = 5000;
const PAYLOAD_SNIFF_BYTES = 4096;
const TEXT_DECODER = new TextDecoder();

export interface FirecrawlFetchResult {
  payload: FirecrawlScrapeResult | null;
  diagnostics: FirecrawlDiagnostics;
}

export interface HtmlDocumentFetchResult {
  html: string;
  finalUrl: string;
}

function looksLikeBinaryDocument(bytes: Uint8Array): boolean {
  if (bytes.length === 0) return false;

  const startsWithAt = (signature: number[], offset: number) =>
    signature.every((byte, index) => bytes[offset + index] === byte);
  const hasOnlyIgnorablePrefix = (offset: number) => {
    for (let index = 0; index < offset; index += 1) {
      const byte = bytes[index];
      if (byte === 0xef && bytes[index + 1] === 0xbb && bytes[index + 2] === 0xbf) {
        index += 2;
        continue;
      }
      if (byte !== 0x09 && byte !== 0x0a && byte !== 0x0d && byte !== 0x20) return false;
    }
    return true;
  };
  const hasSignatureNearStart = (signature: number[]) => {
    const maxOffset = Math.min(64, bytes.length - signature.length);
    for (let offset = 0; offset <= maxOffset; offset += 1) {
      if (startsWithAt(signature, offset) && hasOnlyIgnorablePrefix(offset)) return true;
    }
    return false;
  };

  if (
    hasSignatureNearStart([0x25, 0x50, 0x44, 0x46]) || // %PDF
    hasSignatureNearStart([0x89, 0x50, 0x4e, 0x47]) || // PNG
    hasSignatureNearStart([0xff, 0xd8, 0xff]) || // JPEG
    hasSignatureNearStart([0x47, 0x49, 0x46, 0x38]) || // GIF
    hasSignatureNearStart([0x50, 0x4b, 0x03, 0x04]) || // ZIP/docx/xlsx/pptx
    hasSignatureNearStart([0x1f, 0x8b]) // gzip
  ) {
    return true;
  }

  const sample = bytes.slice(0, PAYLOAD_SNIFF_BYTES);
  let suspicious = 0;
  for (const byte of sample) {
    if (byte === 0) return true;
    if (byte < 0x08 || (byte > 0x0d && byte < 0x20)) suspicious += 1;
  }
  return suspicious / sample.length > 0.1;
}

function isHtmlLikeContentType(contentType: string | null): boolean {
  return Boolean(
    contentType &&
    (contentType.includes("text/html") ||
      contentType.includes("application/xhtml+xml") ||
      contentType.includes("application/xml") ||
      contentType.includes("text/xml") ||
      contentType.includes("application/rss+xml") ||
      contentType.includes("application/atom+xml")),
  );
}

function isTextAssetContentType(contentType: string | null): boolean {
  return Boolean(
    contentType &&
    contentType.startsWith("text/") &&
    !contentType.includes("text/html") &&
    !contentType.includes("text/xml"),
  );
}

function isAttachmentContentDisposition(contentDisposition: string | null): boolean {
  return Boolean(contentDisposition && contentDisposition.includes("attachment"));
}

function looksLikeHtmlText(bytes: Uint8Array): boolean {
  let head = TEXT_DECODER.decode(bytes.slice(0, PAYLOAD_SNIFF_BYTES)).trimStart().toLowerCase();
  for (;;) {
    if (head.startsWith("\ufeff")) {
      head = head.slice(1).trimStart();
      continue;
    }
    if (head.startsWith("<!--")) {
      const end = head.indexOf("-->");
      if (end === -1) return true;
      head = head.slice(end + 3).trimStart();
      continue;
    }
    if (head.startsWith("<?")) {
      const end = head.indexOf("?>");
      if (end === -1) return true;
      head = head.slice(end + 2).trimStart();
      continue;
    }
    break;
  }
  return (
    head.startsWith("<!doctype html") ||
    head.startsWith("<html") ||
    head.startsWith("<head") ||
    head.startsWith("<body") ||
    head.startsWith("<main") ||
    head.startsWith("<article") ||
    head.startsWith("<rss") ||
    head.startsWith("<feed")
  );
}

function assertHtmlPayload(
  bytes: Uint8Array,
  {
    contentType,
    contentDisposition,
    rejectNonHtmlText,
  }: {
    contentType: string | null;
    contentDisposition: string | null;
    rejectNonHtmlText?: boolean;
  },
) {
  if (looksLikeBinaryDocument(bytes)) {
    throw new Error("Unsupported binary payload for HTML document fetch");
  }
  if (rejectNonHtmlText && !contentType && !looksLikeHtmlText(bytes)) {
    throw new Error("Unsupported content-type for HTML document fetch: missing");
  }
  if (
    rejectNonHtmlText &&
    isAttachmentContentDisposition(contentDisposition) &&
    !looksLikeHtmlText(bytes)
  ) {
    throw new Error(
      `Unsupported content-disposition for HTML document fetch: ${contentDisposition}`,
    );
  }
  if (rejectNonHtmlText && isTextAssetContentType(contentType) && !looksLikeHtmlText(bytes)) {
    throw new Error(`Unsupported content-type for HTML document fetch: ${contentType}`);
  }
}

function appendSniffBytes(existing: Uint8Array, chunk: Uint8Array): Uint8Array {
  const needed = PAYLOAD_SNIFF_BYTES - existing.byteLength;
  if (needed <= 0) return existing;
  const next = chunk.byteLength > needed ? chunk.slice(0, needed) : chunk;
  const merged = new Uint8Array(existing.byteLength + next.byteLength);
  merged.set(existing);
  merged.set(next, existing.byteLength);
  return merged;
}

async function assertHtmlPayloadOrCancel(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  controller: AbortController,
  bytes: Uint8Array,
  options: {
    contentType: string | null;
    contentDisposition: string | null;
    rejectNonHtmlText?: boolean;
  },
) {
  try {
    assertHtmlPayload(bytes, options);
  } catch (error) {
    controller.abort();
    try {
      await reader.cancel();
    } catch {
      // The abort above may already have closed the reader.
    }
    throw error;
  }
}

async function fetchHtmlOnce(
  fetchImpl: typeof fetch,
  url: string,
  headers: Record<string, string>,
  {
    timeoutMs,
    onProgress,
    rejectNonHtmlText,
  }: {
    timeoutMs?: number;
    onProgress?: ((event: LinkPreviewProgressEvent) => void) | null;
    rejectNonHtmlText?: boolean;
  } = {},
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
    const contentDisposition = response.headers.get("content-disposition")?.toLowerCase() ?? null;
    if (contentType && !isHtmlLikeContentType(contentType) && !contentType.startsWith("text/")) {
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
      const bytes = new TextEncoder().encode(text);
      assertHtmlPayload(bytes, { contentType, contentDisposition, rejectNonHtmlText });
      onProgress?.({ kind: "fetch-html-done", url, downloadedBytes: bytes.byteLength, totalBytes });
      return { html: text, finalUrl };
    }

    const reader = body.getReader();
    const decoder = new TextDecoder();
    let downloadedBytes = 0;
    let text = "";
    let sniffBytes: Uint8Array<ArrayBufferLike> = new Uint8Array();
    let sniffChecked = false;

    onProgress?.({ kind: "fetch-html-progress", url, downloadedBytes: 0, totalBytes });

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (!value) continue;
      if (!sniffChecked) {
        sniffBytes = appendSniffBytes(sniffBytes, value);
        if (sniffBytes.byteLength >= PAYLOAD_SNIFF_BYTES) {
          await assertHtmlPayloadOrCancel(reader, controller, sniffBytes, {
            contentType,
            contentDisposition,
            rejectNonHtmlText,
          });
          sniffChecked = true;
        }
      }
      downloadedBytes += value.byteLength;
      text += decoder.decode(value, { stream: true });
      onProgress?.({ kind: "fetch-html-progress", url, downloadedBytes, totalBytes });
    }

    if (!sniffChecked) {
      assertHtmlPayload(sniffBytes, { contentType, contentDisposition, rejectNonHtmlText });
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
  options: {
    timeoutMs?: number;
    onProgress?: ((event: LinkPreviewProgressEvent) => void) | null;
    rejectNonHtmlText?: boolean;
  } = {},
): Promise<HtmlDocumentFetchResult> {
  try {
    return await fetchHtmlOnce(fetchImpl, url, withBunCompressionHeaders(REQUEST_HEADERS), options);
  } catch (error) {
    // Bun's fetch has known bugs where its streaming zlib decompression throws
    // ZlibError / ShortRead on certain chunked+compressed responses. Retry the
    // request asking the server to skip compression entirely.
    // https://github.com/oven-sh/bun/issues/23149
    if (isBunCompressedResponseError(error)) {
      const uncompressedHeaders = withBunIdentityEncoding(REQUEST_HEADERS);
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
