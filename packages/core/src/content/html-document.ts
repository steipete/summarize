import { parseHTML } from "linkedom";

const HEAD_CONTENT_TAGS = new Set([
  "base",
  "basefont",
  "bgsound",
  "link",
  "meta",
  "noframes",
  "script",
  "style",
  "template",
  "title",
]);

export function parseHtmlDocument(html: string, url?: string): Document {
  // LinkeDOM treats fragments as the document element; Readability requires normal body ancestry.
  const prolog = inspectProlog(html);
  const source = /^<html(?:\s|>)/i.test(html.slice(prolog.contentOffset))
    ? html
    : `<!doctype html><html>${removeDoctype(html, prolog.doctypeRange)}</html>`;
  const pageUrl = url ? new URL(url) : null;
  const document = parseHTML(source, pageUrl ? { location: pageUrl } : undefined)
    .document as unknown as Document;
  normalizeHtmlAttributeNames(document);
  normalizeDocumentStructure(document);

  if (pageUrl) {
    const base = document.querySelector("base[href]");
    if (base) {
      try {
        base.setAttribute("href", new URL(base.getAttribute("href") ?? "", pageUrl).href);
      } catch {
        base.remove();
      }
    }
    Object.defineProperties(document, {
      documentURI: { configurable: true, value: pageUrl.href },
      URL: { configurable: true, value: pageUrl.href },
    });
  }

  // Readability uses uppercase tag names; browsers normalize them, while LinkeDOM preserves case.
  const createElement = document.createElement.bind(document);
  document.createElement = ((tagName: string, options?: ElementCreationOptions) =>
    createElement(tagName.toLowerCase(), options)) as typeof document.createElement;

  return document;
}

function normalizeHtmlAttributeNames(document: Document): void {
  const mathMlElements = new WeakSet<Element>();
  for (const element of document.querySelectorAll("*")) {
    if (
      element.tagName.toLowerCase() === "math" ||
      (element.parentElement && mathMlElements.has(element.parentElement))
    ) {
      mathMlElements.add(element);
    }
    if (element.namespaceURI !== "http://www.w3.org/1999/xhtml") continue;
    // LinkeDOM reports MathML as XHTML even though adjusted MathML attributes are case-sensitive.
    if (mathMlElements.has(element)) continue;
    const attributes = Array.from(element.attributes);
    const normalized = new Map<string, string>();
    for (const attribute of attributes) {
      const name = attribute.name.replace(/[A-Z]/g, (character) => character.toLowerCase());
      if (!normalized.has(name)) normalized.set(name, attribute.value);
    }
    if (
      normalized.size === attributes.length &&
      attributes.every((attribute) => normalized.has(attribute.name))
    ) {
      continue;
    }
    for (const attribute of attributes) element.removeAttribute(attribute.name);
    for (const [name, value] of normalized) element.setAttribute(name, value);
  }
}

function normalizeDocumentStructure(document: Document): void {
  const root = document.documentElement;
  if (!root || root.tagName.toLowerCase() !== "html") return;

  const children = Array.from(root.childNodes);
  const existingHead = children.find(
    (node): node is HTMLHeadElement =>
      node.nodeType === 1 && (node as Element).tagName.toLowerCase() === "head",
  );
  const existingBody = children.find(
    (node): node is HTMLBodyElement =>
      node.nodeType === 1 && (node as Element).tagName.toLowerCase() === "body",
  );
  const head = existingHead ?? (document.createElement("head") as HTMLHeadElement);
  const body = existingBody ?? (document.createElement("body") as HTMLBodyElement);
  const bodyIndex = existingBody ? children.indexOf(existingBody) : -1;
  const originalBodyStart = body.firstChild;
  let bodyStarted = false;

  for (const [index, child] of children.entries()) {
    const tagName = child.nodeType === 1 ? (child as Element).tagName.toLowerCase() : null;
    if (tagName === "head") {
      if (child !== head) {
        head.append(...Array.from(child.childNodes));
        child.remove();
      }
      continue;
    }
    if (tagName === "body") {
      if (child !== body) {
        body.append(...Array.from(child.childNodes));
        child.remove();
      }
      bodyStarted = true;
      continue;
    }
    if (!existingHead && !bodyStarted && tagName && HEAD_CONTENT_TAGS.has(tagName)) {
      head.append(child);
      continue;
    }
    if (isSubstantiveRootNode(child)) bodyStarted = true;
    if (existingBody && index < bodyIndex && isSubstantiveRootNode(child)) {
      body.insertBefore(child, originalBodyStart);
    } else {
      body.append(child);
    }
  }

  root.replaceChildren(head, body);
}

function isSubstantiveRootNode(node: Node): boolean {
  if (node.nodeType === 1) return true;
  return node.nodeType === 3 && Boolean((node.textContent ?? "").trim());
}

function inspectProlog(html: string): {
  contentOffset: number;
  doctypeRange: { start: number; end: number } | null;
} {
  let offset = 0;
  let doctypeRange: { start: number; end: number } | null = null;

  while (offset < html.length) {
    const whitespace = html.slice(offset).match(/^\s+/)?.[0];
    if (whitespace) {
      offset += whitespace.length;
      continue;
    }
    if (html.startsWith("<!--", offset)) {
      const end = html.indexOf("-->", offset + 4);
      if (end < 0) break;
      offset = end + 3;
      continue;
    }
    if (html.startsWith("<?", offset)) {
      const end = html.indexOf("?>", offset + 2);
      if (end < 0) break;
      offset = end + 2;
      continue;
    }
    const doctype = html.slice(offset).match(/^<!doctype(?:\s+[^>]*)?>/i)?.[0];
    if (doctype && !doctypeRange) {
      doctypeRange = { start: offset, end: offset + doctype.length };
      offset += doctype.length;
      continue;
    }
    break;
  }

  return { contentOffset: offset, doctypeRange };
}

function removeDoctype(html: string, range: { start: number; end: number } | null): string {
  if (!range) return html;
  return `${html.slice(0, range.start)}${html.slice(range.end)}`;
}

export function serializeHtmlDocument(document: Document): string {
  const root = document.documentElement?.outerHTML ?? document.body?.innerHTML ?? "";
  if (!document.doctype) return root;
  return `<!DOCTYPE ${document.doctype.name}>${root}`;
}
