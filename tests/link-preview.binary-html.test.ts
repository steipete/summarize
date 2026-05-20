import { describe, expect, it } from "vitest";
import { createLinkPreviewClient } from "../src/content/index.js";

describe("link preview binary payload guard", () => {
  it("rejects binary downloads mislabeled as HTML", async () => {
    const payload = Buffer.from("%PDF-1.4\n%\xe2\xe3\xcf\xd3\n1 0 obj", "binary");
    const client = createLinkPreviewClient({
      fetch: async () =>
        new Response(payload, {
          status: 200,
          headers: { "content-type": "text/html; charset=utf-8" },
        }),
    });

    await expect(client.fetchLinkContent("https://example.com/download")).rejects.toThrow(
      /binary payload/i,
    );
  });

  it("rejects binary signatures after leading bytes", async () => {
    const payload = Buffer.from("\n\n%PDF-1.4\n1 0 obj", "binary");
    const client = createLinkPreviewClient({
      fetch: async () =>
        new Response(payload, {
          status: 200,
          headers: { "content-type": "text/html; charset=utf-8" },
        }),
    });

    await expect(client.fetchLinkContent("https://example.com/download")).rejects.toThrow(
      /binary payload/i,
    );
  });

  it("accepts HTML documents that mention binary signatures", async () => {
    const client = createLinkPreviewClient({
      fetch: async () =>
        new Response("<!doctype html><html><body><pre>%PDF-1.7 example</pre></body></html>", {
          status: 200,
          headers: { "content-type": "text/html; charset=utf-8" },
        }),
    });

    await expect(client.fetchLinkContent("https://example.com/page")).resolves.toMatchObject({
      content: "%PDF-1.7 example",
    });
  });

  it("rejects binary signatures split across response chunks", async () => {
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode("%"));
        controller.enqueue(encoder.encode("PDF-1.4\n1 0 obj"));
        controller.close();
      },
    });
    const client = createLinkPreviewClient({
      fetch: async () =>
        new Response(stream, {
          status: 200,
          headers: { "content-type": "text/html; charset=utf-8" },
        }),
    });

    await expect(client.fetchLinkContent("https://example.com/download")).rejects.toThrow(
      /binary payload/i,
    );
  });

  it("cancels the response stream when sniffing rejects a large binary payload", async () => {
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(Buffer.from(`%PDF-1.4\n${"x".repeat(5000)}`, "utf8"));
      },
      cancel() {
        cancelled = true;
      },
    });
    const client = createLinkPreviewClient({
      fetch: async () =>
        new Response(stream, {
          status: 200,
          headers: { "content-type": "text/html; charset=utf-8" },
        }),
    });

    await expect(client.fetchLinkContent("https://example.com/download")).rejects.toThrow(
      /binary payload/i,
    );
    expect(cancelled).toBe(true);
  });

  it("still accepts normal HTML documents", async () => {
    const client = createLinkPreviewClient({
      fetch: async () =>
        new Response("<!doctype html><html><body><article>Hello world</article></body></html>", {
          status: 200,
          headers: { "content-type": "text/html; charset=utf-8" },
        }),
    });

    await expect(client.fetchLinkContent("https://example.com/page")).resolves.toMatchObject({
      content: "Hello world",
    });
  });

  it("accepts HTML served as text/plain when asset retry mode is on", async () => {
    const client = createLinkPreviewClient({
      fetch: async () =>
        new Response("<!doctype html><html><body><article>Hello world</article></body></html>", {
          status: 200,
          headers: { "content-type": "text/plain;charset=utf-8" },
        }),
    });

    await expect(
      client.fetchLinkContent("https://example.com/page", {
        throwOnAssetLikeHtmlError: true,
      }),
    ).resolves.toMatchObject({
      content: "Hello world",
    });
  });

  it("accepts text/plain HTML that starts with a comment and body tag", async () => {
    const client = createLinkPreviewClient({
      fetch: async () =>
        new Response("<!-- generated --><body><article>Hello body</article></body>", {
          status: 200,
          headers: { "content-type": "text/plain;charset=utf-8" },
        }),
    });

    await expect(
      client.fetchLinkContent("https://example.com/page", {
        throwOnAssetLikeHtmlError: true,
      }),
    ).resolves.toMatchObject({
      content: "Hello body",
    });
  });

  it("accepts text/plain HTML after a long preamble", async () => {
    const client = createLinkPreviewClient({
      fetch: async () =>
        new Response(`${" ".repeat(600)}<main><article>Hello preamble</article></main>`, {
          status: 200,
          headers: { "content-type": "text/plain;charset=utf-8" },
        }),
    });

    await expect(
      client.fetchLinkContent("https://example.com/page", {
        throwOnAssetLikeHtmlError: true,
      }),
    ).resolves.toMatchObject({
      content: "Hello preamble",
    });
  });

  it("rejects extensionless CSV downloads when asset retry mode is on", async () => {
    const client = createLinkPreviewClient({
      fetch: async () =>
        new Response("name,count\nalpha,1\n", {
          status: 200,
          headers: { "content-type": "text/csv;charset=utf-8" },
        }),
    });

    await expect(
      client.fetchLinkContent("https://example.com/download", {
        throwOnAssetLikeHtmlError: true,
      }),
    ).rejects.toThrow(/unsupported content-type/i);
  });

  it("rejects extensionless plain-text downloads when asset retry mode is on", async () => {
    const client = createLinkPreviewClient({
      fetch: async () =>
        new Response("hello download", {
          status: 200,
          headers: { "content-type": "text/plain;charset=utf-8" },
        }),
    });

    await expect(
      client.fetchLinkContent("https://example.com/download", {
        throwOnAssetLikeHtmlError: true,
      }),
    ).rejects.toThrow(/unsupported content-type/i);
  });

  it("rejects headerless extensionless plain-text downloads when asset retry mode is on", async () => {
    const client = createLinkPreviewClient({
      fetch: async () => new Response("hello download", { status: 200 }),
    });

    await expect(
      client.fetchLinkContent("https://example.com/download", {
        throwOnAssetLikeHtmlError: true,
      }),
    ).rejects.toThrow(/unsupported content-type/i);
  });

  it("rejects attachment downloads when asset retry mode is on", async () => {
    const client = createLinkPreviewClient({
      fetch: async () =>
        new Response("hello attachment", {
          status: 200,
          headers: {
            "content-type": "text/plain;charset=utf-8",
            "content-disposition": 'attachment; filename="note.txt"',
          },
        }),
    });

    await expect(
      client.fetchLinkContent("https://example.com/download", {
        throwOnAssetLikeHtmlError: true,
      }),
    ).rejects.toThrow(/unsupported content-disposition/i);
  });
});
