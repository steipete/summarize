import { describe, expect, it } from "vitest";
import {
  parseHtmlDocument,
  serializeHtmlDocument,
} from "../packages/core/src/content/html-document.js";
import { extractReadabilityFromHtml } from "../packages/core/src/content/link-preview/content/readability.js";

describe("HTML document adapter", () => {
  it("wraps fragments and keeps the doctype outside the body", () => {
    const document = parseHtmlDocument('<!doctype html><p id="content">Hello</p>');
    expect(document.documentElement?.tagName.toLowerCase()).toBe("html");
    expect(document.head).not.toBeNull();
    expect(document.body?.querySelector("#content")?.textContent).toBe("Hello");
    const serialized = serializeHtmlDocument(document);
    expect(serialized.match(/<!doctype/gi)).toHaveLength(1);
    expect(document.body?.innerHTML).not.toContain("doctype");
  });

  it("moves malformed document children into the body for Readability", async () => {
    const html = `<html><div><article><h1>Malformed article</h1>
      <p>This paragraph contains enough useful prose for article extraction to recognize it.</p>
      <p>A second substantial paragraph ensures that the document is considered readable.</p>
    </article></div></html>`;

    const result = await extractReadabilityFromHtml(html, "https://example.com/article");
    expect(result?.text).toContain("Malformed article");
    expect(result?.text).toContain("second substantial paragraph");
  });

  it("does not mistake raw html text for the document element", () => {
    const document = parseHtmlDocument(
      '<textarea><html></textarea><article id="content">Still present</article>',
    );
    expect(document.body?.querySelector("#content")?.textContent).toBe("Still present");
    expect(document.body?.querySelector("textarea")?.textContent).toBe("<html>");
  });

  it("normalizes documents with optional html tags", () => {
    const document = parseHtmlDocument(
      "<!doctype html><head><title>Optional tags</title></head><body><p>Body</p></body>",
    );
    expect(document.head?.querySelector("title")?.textContent).toBe("Optional tags");
    expect(document.body?.textContent).toBe("Body");
    expect(document.body?.querySelector("head, body")).toBeNull();
  });

  it("places leading document metadata in a synthesized head", () => {
    const document = parseHtmlDocument(
      '<title>Fragment title</title><meta name="description" content="Details"><article>Body</article>',
    );
    expect(document.title).toBe("Fragment title");
    expect(document.head?.querySelector('meta[name="description"]')).not.toBeNull();
    expect(document.body?.textContent).toBe("Body");
  });

  it("normalizes HTML attribute names without changing foreign content", () => {
    const document = parseHtmlDocument(
      '<META PROPERTY="og:title" CONTENT="Uppercase title"><video SRC="first.mp4" src="second.mp4"></video><svg viewBox="0 0 1 1"></svg><math><csymbol definitionURL="urn:example"></csymbol></math>',
    );
    expect(document.head?.querySelector('meta[property="og:title"]')?.getAttribute("content")).toBe(
      "Uppercase title",
    );
    expect(document.body?.querySelector("video")?.getAttribute("src")).toBe("first.mp4");
    expect(document.body?.querySelector("svg")?.hasAttribute("viewBox")).toBe(true);
    expect(document.body?.querySelector("csymbol")?.hasAttribute("definitionURL")).toBe(true);
  });

  it("recognizes full documents after an XML declaration", () => {
    const document = parseHtmlDocument(
      '<?xml version="1.0"?><!doctype html><html><head><title>XHTML</title></head><body><p>Body</p></body></html>',
    );
    expect(document.title).toBe("XHTML");
    expect(document.body?.textContent).toBe("Body");
  });

  it("preserves body content order around malformed head and body tags", () => {
    const document = parseHtmlDocument(
      "<html><div>Before</div><head><title>Title</title></head><body><p>Main</p></body><div>After</div></html>",
    );
    expect(document.body?.textContent).toBe("BeforeMainAfter");
    expect(document.head?.querySelector("title")?.textContent).toBe("Title");
  });

  it("resolves relative links against the page URL for Readability", async () => {
    const html = `<article><h1>Linked article</h1>
      <p>This paragraph contains enough useful prose and a <a href="/next">relative link</a>.</p>
      <p>A second substantial paragraph keeps the article extraction path deterministic.</p>
    </article>`;

    const result = await extractReadabilityFromHtml(html, "https://example.com/articles/current");
    expect(result?.html).toContain('href="https://example.com/next"');
  });

  it("does not execute scripts while parsing", () => {
    const marker = "__summarizeLinkedomExecutionMarker";
    delete (globalThis as Record<string, unknown>)[marker];
    const document = parseHtmlDocument(`<script>globalThis.${marker} = true</script><p>Safe</p>`);
    try {
      expect((globalThis as Record<string, unknown>)[marker]).toBeUndefined();
      expect(document.body?.textContent).toContain("Safe");
    } finally {
      delete (globalThis as Record<string, unknown>)[marker];
    }
  });
});
