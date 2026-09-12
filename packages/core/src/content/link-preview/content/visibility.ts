import { parseHtmlDocument, serializeHtmlDocument } from "../../html-document.js";

const COMMENT_PATTERN = /<!--[\s\S]*?-->/g;
const CSS_COMMENT_PATTERN = /\/\*[\s\S]*?\*\//g;
const STYLE_SPLIT_PATTERN = /;/;

type AttributeMap = Record<string, string>;
type StyleDeclaration = { value: string; important: boolean };
type StyleMap = Record<string, StyleDeclaration>;

function parseStyle(style: string): StyleMap {
  const map: StyleMap = {};
  for (const part of style.split(STYLE_SPLIT_PATTERN)) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const colon = trimmed.indexOf(":");
    if (colon === -1) continue;
    const key = trimmed.slice(0, colon).trim().toLowerCase();
    const rawValue = trimmed
      .slice(colon + 1)
      .trim()
      .toLowerCase();
    const important = /!\s*important\b/.test(rawValue);
    const value = rawValue.replace(/!\s*important\b/g, "").trim();
    if (!key) continue;
    if (!value) continue;
    const current = map[key];
    if (!current || important || !current.important) {
      map[key] = { value, important };
    }
  }
  return map;
}

function parseCssNumber(value: string | undefined): number | null {
  if (!value) return null;
  const match = value.trim().match(/^(-?\d*\.?\d+)/);
  if (!match) return null;
  const parsed = Number.parseFloat(match[1] ?? "");
  return Number.isFinite(parsed) ? parsed : null;
}

function cssKeyword(declaration: StyleDeclaration | undefined): string {
  return (declaration?.value ?? "").trim().split(/\s+/)[0];
}

function isHiddenByStyle(style: string): boolean {
  const normalized = style.toLowerCase().replace(CSS_COMMENT_PATTERN, "");
  const styles = parseStyle(normalized);
  if (cssKeyword(styles.display) === "none") return true;
  if (cssKeyword(styles.visibility) === "hidden") return true;
  if (parseCssNumber(styles.opacity?.value) === 0) return true;
  if (parseCssNumber(styles["font-size"]?.value) === 0) return true;
  if (/clip-path\s*:\s*inset\(\s*100%/i.test(normalized)) return true;
  if (
    /clip\s*:\s*rect\(\s*0(?:px)?\s*,\s*0(?:px)?\s*,\s*0(?:px)?\s*,\s*0(?:px)?\s*\)/i.test(
      normalized,
    )
  ) {
    return true;
  }
  if (/transform\s*:\s*scale\(\s*0(?:\s*,\s*0)?\s*\)/i.test(normalized)) return true;

  const width = parseCssNumber(styles.width?.value);
  const height = parseCssNumber(styles.height?.value);
  const overflow = styles.overflow?.value ?? "";
  if (width === 0 && height === 0 && overflow.startsWith("hidden")) return true;

  const textIndent = parseCssNumber(styles["text-indent"]?.value);
  if (textIndent !== null && textIndent <= -999) return true;

  const position = cssKeyword(styles.position);
  if (position === "absolute" || position === "fixed") {
    const left = parseCssNumber(styles.left?.value);
    const top = parseCssNumber(styles.top?.value);
    if (left !== null && left <= -999) return true;
    if (top !== null && top <= -999) return true;
  }

  return false;
}

function shouldStripElement(
  tagName: string,
  style: string | undefined,
  attributes: AttributeMap,
): boolean {
  if (tagName === "template") return true;
  if (tagName === "script") return true;
  if (tagName === "style") return true;
  if (tagName === "noscript") return true;
  if (tagName === "svg") return true;
  if (tagName === "canvas") return true;
  if (tagName === "iframe") return true;
  if (tagName === "object") return true;
  if (tagName === "embed") return true;

  if ("hidden" in attributes) return true;

  const ariaHidden = attributes["aria-hidden"];
  if (ariaHidden === "true" || ariaHidden === "1") return true;

  if (tagName === "input" && attributes.type === "hidden") return true;

  if (style && isHiddenByStyle(style)) return true;

  return false;
}

export function stripHiddenHtml(html: string): string {
  if (!html) return html;
  const withoutComments = html.replace(COMMENT_PATTERN, "");
  const document = parseHtmlDocument(withoutComments);

  for (const element of document.querySelectorAll("*")) {
    const tagName = element.tagName.toLowerCase();
    const attributes: AttributeMap = {};
    for (const attribute of element.attributes) {
      attributes[attribute.name.toLowerCase()] = attribute.value.toLowerCase();
    }
    if (shouldStripElement(tagName, attributes.style, attributes)) {
      element.remove();
    }
  }

  return serializeHtmlDocument(document);
}
