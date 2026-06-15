import { describe, expect, it } from "vitest";
import { extractBrowserHtmlContent } from "../packages/core/src/content/browser-html.js";

describe("browser HTML content extraction", () => {
  it("extracts preferred metadata and readable text within a budget", async () => {
    const result = await extractBrowserHtmlContent({
      url: "https://example.com/article",
      maxCharacters: 70,
      html: `
        <html>
          <head>
            <title>Fallback title</title>
            <meta name="twitter:title" content="Twitter title">
            <meta property="og:title" content="Open Graph title">
            <meta name="description" content="Description &amp; details">
            <meta property="og:site_name" content="Example Site">
            <script>hidden script text</script>
            <style>hidden style text</style>
          </head>
          <body>
            <article>
              <h1>Heading</h1>
              <p>${"Useful readable text. ".repeat(20)}</p>
            </article>
          </body>
        </html>`,
    });

    expect(result).toMatchObject({
      url: "https://example.com/article",
      title: "Open Graph title",
      description: "Description & details",
      siteName: "Example Site",
      truncated: true,
    });
    expect(result.text).toContain("Useful readable text");
    expect(result.text).not.toContain("hidden script text");
    expect(result.text.length).toBeLessThanOrEqual(70);
  });

  it("uses fallback metadata and preserves complete content without a budget", async () => {
    const result = await extractBrowserHtmlContent({
      url: "https://news.example.org/story",
      html: `
        <title>Title &amp; more</title>
        <meta name='twitter:description' content='Social description'>
        <main><p>First paragraph.</p><p>Second paragraph.</p></main>`,
    });

    expect(result).toEqual({
      url: "https://news.example.org/story",
      title: "Title & more",
      description: "Social description",
      siteName: "news.example.org",
      text: "Title & more\nFirst paragraph.\nSecond paragraph.",
      truncated: false,
    });
  });

  it("handles unquoted metadata and invalid URLs", async () => {
    const result = await extractBrowserHtmlContent({
      url: "not a url",
      maxCharacters: null,
      html: `<meta property=og:title content=Plain><div>Body<br>line</div>`,
    });

    expect(result.title).toBe("Plain");
    expect(result.siteName).toBeNull();
    expect(result.text).toBe("Body\nline");
    expect(result.truncated).toBe(false);
  });

  it("returns null metadata for empty documents", async () => {
    await expect(
      extractBrowserHtmlContent({
        url: "https://example.com",
        html: "<!-- empty --><template>ignored</template>",
      }),
    ).resolves.toEqual({
      url: "https://example.com",
      title: null,
      description: null,
      siteName: "example.com",
      text: "",
      truncated: false,
    });
  });
});
