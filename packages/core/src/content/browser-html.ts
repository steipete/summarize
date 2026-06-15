import {
  applyContentBudget,
  decodeHtmlEntities,
  normalizeForPrompt,
} from "./link-preview/content/cleaner.js";

export type BrowserHtmlContent = {
  url: string;
  title: string | null;
  description: string | null;
  siteName: string | null;
  text: string;
  truncated: boolean;
};

export async function extractBrowserHtmlContent(options: {
  html: string;
  url: string;
  maxCharacters?: number | null;
}): Promise<BrowserHtmlContent> {
  const title =
    readMeta(options.html, "property", "og:title") ??
    readMeta(options.html, "name", "twitter:title") ??
    readTag(options.html, "title");
  const description =
    readMeta(options.html, "property", "og:description") ??
    readMeta(options.html, "name", "description") ??
    readMeta(options.html, "name", "twitter:description");
  const siteName = readMeta(options.html, "property", "og:site_name") ?? safeHostname(options.url);
  const sourceText = extractText(options.html);
  const budgeted =
    typeof options.maxCharacters === "number"
      ? applyContentBudget(sourceText, options.maxCharacters)
      : {
          content: sourceText,
          truncated: false,
          totalCharacters: sourceText.length,
          wordCount: sourceText ? sourceText.split(/\s+/).length : 0,
        };
  return {
    url: options.url,
    title,
    description,
    siteName,
    text: budgeted.content,
    truncated: budgeted.truncated,
  };
}

function extractText(html: string): string {
  const withoutNoise = html
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(script|style|noscript|template|svg|canvas)\b[^>]*>[\s\S]*?<\/\1>/gi, " ");
  const withBreaks = withoutNoise
    .replace(/<(br|hr)\b[^>]*\/?>/gi, "\n")
    .replace(
      /<\/(p|div|section|article|main|aside|header|footer|li|h[1-6]|blockquote|pre)>/gi,
      "\n",
    );
  return normalizeForPrompt(
    decodeHtmlEntities(withBreaks.replace(/<[^>]+>/g, " ").replace(/\r/g, "")),
  );
}

function readTag(html: string, tag: string): string | null {
  const match = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`, "i").exec(html);
  return normalizeMetadata(match?.[1]);
}

function readMeta(html: string, attribute: "name" | "property", value: string): string | null {
  const tags = html.match(/<meta\b[^>]*>/gi) ?? [];
  for (const tag of tags) {
    const key = readAttribute(tag, attribute);
    if (key?.toLowerCase() !== value.toLowerCase()) continue;
    return normalizeMetadata(readAttribute(tag, "content"));
  }
  return null;
}

function readAttribute(tag: string, name: string): string | null {
  const pattern = new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'=<>]+))`, "i");
  const match = pattern.exec(tag);
  return match ? (match[1] ?? match[2] ?? match[3] ?? null) : null;
}

function normalizeMetadata(value: string | null | undefined): string | null {
  if (!value) return null;
  const normalized = decodeHtmlEntities(value.replace(/<[^>]+>/g, " "))
    .replace(/\s+/g, " ")
    .trim();
  return normalized || null;
}

function safeHostname(url: string): string | null {
  try {
    return new URL(url).hostname || null;
  } catch {
    return null;
  }
}
