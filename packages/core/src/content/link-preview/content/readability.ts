import { parseHtmlDocument } from "../../html-document.js";
import { stripHiddenHtml } from "./visibility.js";

export type ReadabilityResult = {
  text: string;
  html: string | null;
  title: string | null;
  excerpt: string | null;
};

export async function extractReadabilityFromHtml(
  html: string,
  url?: string,
): Promise<ReadabilityResult | null> {
  try {
    const cleanedHtml = stripCssFromHtml(stripHiddenHtml(html));
    const { Readability } = await import("@mozilla/readability");
    const document = parseHtmlDocument(cleanedHtml, url);
    const article = new Readability(document).parse();
    if (!article) return null;

    const text = (article.textContent ?? "").replace(/\s+/g, " ").trim();
    return {
      text,
      html: article.content ?? null,
      title: article.title ?? null,
      excerpt: article.excerpt ?? null,
    };
  } catch {
    return null;
  }
}

export function toReadabilityHtml(result: ReadabilityResult | null): string | null {
  if (!result) return null;
  if (result.html) return result.html;
  if (!result.text) return null;
  return `<article><p>${escapeHtml(result.text)}</p></article>`;
}

function escapeHtml(input: string): string {
  return input
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function stripCssFromHtml(html: string): string {
  // Readability doesn't need CSS; stylesheet parsing can be extremely slow on some pages.
  return html.replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, "");
}
