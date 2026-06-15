import { expect, test } from "@playwright/test";
import { friendlyFetchError } from "../src/entrypoints/background/daemon-client";
import { fetchBrowserUrlContent, isPublicBrowserUrl } from "../src/lib/browser-url-content";

test("browser URL extraction rejects local and non-HTTP targets before fetch", async () => {
  const blocked = [
    "http://localhost:8787/private",
    "http://127.0.0.1/private",
    "http://10.0.0.1/private",
    "http://[::1]/private",
    "file:///tmp/private",
    "chrome://extensions",
  ];
  for (const url of blocked) expect(isPublicBrowserUrl(url)).toBe(false);
  expect(isPublicBrowserUrl("https://example.com/article")).toBe(true);

  let fetched = false;
  await expect(
    fetchBrowserUrlContent({
      url: "http://localhost/private",
      maxCharacters: 100,
      fetchImpl: async () => {
        fetched = true;
        return new Response();
      },
    }),
  ).rejects.toThrow("public HTTP(S)");
  expect(fetched).toBe(false);
});

test("browser URL extraction removes page noise and applies the content budget", async () => {
  const content = await fetchBrowserUrlContent({
    url: "https://example.com/article",
    maxCharacters: 80,
    fetchImpl: async () =>
      new Response(
        `<!doctype html>
        <html>
          <head>
            <title>Readable title</title>
            <meta name="description" content="Readable description">
            <script>secretScriptText()</script>
            <style>.hidden { display: none }</style>
          </head>
          <body>
            <article><h1>Heading</h1><p>${"Useful article text. ".repeat(20)}</p></article>
          </body>
        </html>`,
        {
          headers: { "content-type": "text/html" },
        },
      ),
  });

  expect(content.title).toBe("Readable title");
  expect(content.description).toBe("Readable description");
  expect(content.text).toContain("Useful article text");
  expect(content.text).not.toContain("secretScriptText");
  expect(content.text.length).toBeLessThanOrEqual(80);
  expect(content.truncated).toBe(true);
});

test("browser URL extraction rejects redirects to private targets before reading content", async () => {
  let bodyRead = false;
  const fetchCalls: string[] = [];

  await expect(
    fetchBrowserUrlContent({
      url: "https://example.com/redirect",
      maxCharacters: 100,
      fetchImpl: async (input, init) => {
        fetchCalls.push(String(input));
        expect(init?.redirect).toBe("manual");
        expect((init as RequestInit & { targetAddressSpace?: string }).targetAddressSpace).toBe(
          "public",
        );
        const response = new Response("<article>Private content</article>", {
          status: 302,
          headers: { location: "http://127.0.0.1/private" },
        });
        Object.defineProperty(response, "text", {
          value: async () => {
            bodyRead = true;
            return "<article>Private content</article>";
          },
        });
        return response;
      },
    }),
  ).rejects.toThrow("redirected to a non-public");
  expect(fetchCalls).toEqual(["https://example.com/redirect"]);
  expect(bodyRead).toBe(false);
});

test("browser URL extraction follows validated public redirects", async () => {
  const fetchCalls: string[] = [];
  const content = await fetchBrowserUrlContent({
    url: "https://example.com/redirect",
    maxCharacters: 100,
    fetchImpl: async (input, init) => {
      fetchCalls.push(String(input));
      expect(init?.redirect).toBe("manual");
      expect((init as RequestInit & { targetAddressSpace?: string }).targetAddressSpace).toBe(
        "public",
      );
      if (fetchCalls.length === 1) {
        return new Response(null, {
          status: 302,
          headers: { location: "/article" },
        });
      }
      return new Response("<article>Public article content</article>", {
        headers: { "content-type": "text/html" },
      });
    },
  });

  expect(fetchCalls).toEqual(["https://example.com/redirect", "https://example.com/article"]);
  expect(content.url).toBe("https://example.com/article");
  expect(content.text).toContain("Public article content");
});

test("browser URL extraction stops streaming responses at the byte limit", async () => {
  let cancelled = false;
  const oversizedChunk = new Uint8Array(4_100_000);
  const response = new Response(
    new ReadableStream({
      start(controller) {
        controller.enqueue(oversizedChunk);
        controller.enqueue(oversizedChunk);
      },
      cancel() {
        cancelled = true;
      },
    }),
    { headers: { "content-type": "text/html" } },
  );

  await expect(
    fetchBrowserUrlContent({
      url: "https://example.com/large",
      maxCharacters: 100,
      fetchImpl: async () => response,
    }),
  ).rejects.toThrow("too large");
  expect(cancelled).toBe(true);
});

test("fetch errors only include daemon recovery guidance for daemon operations", () => {
  expect(
    friendlyFetchError(new TypeError("Failed to fetch"), "Direct provider request failed"),
  ).toContain("provider unavailable");
  expect(
    friendlyFetchError(new TypeError("Failed to fetch"), "Direct provider request failed"),
  ).not.toContain("daemon status");
  expect(friendlyFetchError(new TypeError("Failed to fetch"), "Daemon request failed")).toContain(
    "summarize daemon status",
  );
});
