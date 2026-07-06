import sanitizeHtml from "sanitize-html";
import { parseHtmlDocument } from "../../html-document.js";
import { decodeHtmlEntities, normalizeWhitespace } from "./cleaner.js";
import { stripHiddenHtml } from "./visibility.js";

const MIN_SEGMENT_LENGTH = 30;

export function sanitizeHtmlForMarkdownConversion(html: string): string {
  return sanitizeHtml(stripHiddenHtml(html), {
    allowedTags: [
      "article",
      "section",
      "div",
      "p",
      "h1",
      "h2",
      "h3",
      "h4",
      "h5",
      "h6",
      "ol",
      "ul",
      "li",
      "blockquote",
      "pre",
      "code",
      "span",
      "strong",
      "em",
      "br",
      "a",
    ],
    allowedAttributes: {
      a: ["href"],
    },
    nonTextTags: [
      "style",
      "script",
      "noscript",
      "template",
      "svg",
      "canvas",
      "iframe",
      "object",
      "embed",
    ],
    textFilter(text: string) {
      return decodeHtmlEntities(text);
    },
  });
}

export function extractArticleContent(
  html: string,
  options?: { preserveShortSegments?: boolean },
): string {
  const segments = collectSegmentsFromHtml(html, options);
  if (segments.length > 0) {
    return segments.join("\n");
  }
  const fallback = normalizeWhitespace(extractPlainText(html));
  return fallback ?? "";
}

export function collectSegmentsFromHtml(
  html: string,
  options?: { preserveShortSegments?: boolean },
): string[] {
  const minimumSegmentLength = options?.preserveShortSegments ? 1 : MIN_SEGMENT_LENGTH;
  const sanitized = sanitizeHtml(stripHiddenHtml(html), {
    allowedTags: [
      "article",
      "section",
      "div",
      "p",
      "h1",
      "h2",
      "h3",
      "h4",
      "h5",
      "h6",
      "ol",
      "ul",
      "li",
      "blockquote",
      "pre",
      "code",
      "span",
      "strong",
      "em",
      "br",
    ],
    allowedAttributes: {},
    nonTextTags: [
      "style",
      "script",
      "noscript",
      "template",
      "svg",
      "canvas",
      "iframe",
      "object",
      "embed",
    ],
    textFilter(text: string) {
      return decodeHtmlEntities(text);
    },
  });

  const parsed = parseHtmlDocument(sanitized);
  try {
    const segments: string[] = [];

    for (const element of parsed.document.querySelectorAll(
      "h1,h2,h3,h4,h5,h6,li,p,blockquote,pre",
    )) {
      const tag = element.tagName.toLowerCase();
      const text = normalizeWhitespace(element.textContent ?? "").replaceAll(/\n+/g, " ");
      if (!text) continue;

      if (tag.startsWith("h")) {
        if (text.length >= 10) segments.push(text);
        continue;
      }

      if (tag === "li") {
        if (text.length >= Math.min(20, minimumSegmentLength)) segments.push(`• ${text}`);
        continue;
      }

      if (text.length >= minimumSegmentLength) segments.push(text);
    }

    if (segments.length === 0) {
      const fallback = normalizeWhitespace(parsed.document.body?.textContent || sanitized);
      return fallback ? [fallback] : [];
    }

    return mergeConsecutiveSegments(segments);
  } finally {
    parsed.close();
  }
}

export function extractPlainText(html: string): string {
  const stripped = sanitizeHtml(stripHiddenHtml(html), {
    allowedTags: [],
    allowedAttributes: {},
    nonTextTags: [
      "style",
      "script",
      "noscript",
      "template",
      "svg",
      "canvas",
      "iframe",
      "object",
      "embed",
    ],
  });
  return decodeHtmlEntities(stripped);
}

function mergeConsecutiveSegments(segments: string[]): string[] {
  // Keep headings as separate segments; merging short segments mostly collapses headings into the
  // previous paragraph ("... Conclusion"), which reads worse than a standalone heading line.
  return segments.filter(Boolean);
}
