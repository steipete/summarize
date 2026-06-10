import { describe, expect, it, vi } from "vitest";
import { createLinkPreviewClient } from "../src/content/index.js";

const jsonResponse = (payload: unknown, status = 200) =>
  Response.json(payload, {
    status,
    headers: { "Content-Type": "application/json" },
  });

const htmlResponse = (html: string, status = 200) =>
  new Response(html, {
    status,
    headers: { "Content-Type": "text/html" },
  });

describe("link preview extraction (YouTube)", () => {
  it("uses transcript text when available", async () => {
    const html =
      '<!doctype html><html><head><title>Sample</title><meta name="description" content="Desc" />' +
      '<script>ytcfg.set({"INNERTUBE_API_KEY":"TEST_KEY","INNERTUBE_CONTEXT":{"client":{"clientName":"WEB","clientVersion":"1.0"}},"INNERTUBE_CONTEXT_CLIENT_NAME":1});</script>' +
      '<script>var ytInitialPlayerResponse = {"captions":{"playerCaptionsTracklistRenderer":{"captionTracks":[{"baseUrl":"https://example.com"}]}},"getTranscriptEndpoint":{"params":"TEST_PARAMS"}};</script>' +
      "</head><body><main><p>Fallback paragraph</p></main></body></html>";

    const fetchMock = vi.fn<[RequestInfo | URL, RequestInit?], Promise<Response>>((input, init) => {
      const url = typeof input === "string" ? input : (input?.url ?? "");
      if (url.includes("youtubei/v1/get_transcript")) {
        expect(JSON.parse((init?.body as string) ?? "{}").params).toBe("TEST_PARAMS");
        return Promise.resolve(
          jsonResponse({
            actions: [
              {
                updateEngagementPanelAction: {
                  content: {
                    transcriptRenderer: {
                      content: {
                        transcriptSearchPanelRenderer: {
                          body: {
                            transcriptSegmentListRenderer: {
                              initialSegments: [
                                {
                                  transcriptSegmentRenderer: {
                                    snippet: { runs: [{ text: "Hello & welcome" }] },
                                  },
                                },
                                {
                                  transcriptSegmentRenderer: {
                                    snippet: { runs: [{ text: "Transcript line 2" }] },
                                  },
                                },
                              ],
                            },
                          },
                        },
                      },
                    },
                  },
                },
              },
            ],
          }),
        );
      }
      if (url.includes("youtube.com/watch") || url.includes("youtu.be/")) {
        return Promise.resolve(htmlResponse(html));
      }
      return Promise.reject(new Error(`Unexpected fetch call: ${String(url)}`));
    });

    const client = createLinkPreviewClient({ fetch: fetchMock as unknown as typeof fetch });
    const result = await client.fetchLinkContent("https://www.youtube.com/watch?v=abcdefghijk");

    expect(result.content).toBe("Transcript:\nHello & welcome\nTranscript line 2");
    expect(result.totalCharacters).toBe(result.content.length);
    expect(result.wordCount).toBe(7);
    expect(result.transcriptSource).toBe("youtubei");
  });

  it("falls back to extracted HTML when transcripts are unavailable", async () => {
    const html =
      "<!doctype html><html><head><title>Sample</title>" +
      '<script>var ytcfg = {"INNERTUBE_API_KEY":"TEST_KEY","INNERTUBE_CONTEXT":{"client":{"clientName":"WEB","clientVersion":"1.0"}}};</script>' +
      '<script>var ytInitialPlayerResponse = {"getTranscriptEndpoint":{"params":"TEST_PARAMS"}};</script>' +
      "</head><body><article><p>Only HTML content</p></article></body></html>";

    const fetchMock = vi.fn<[RequestInfo | URL, RequestInit?], Promise<Response>>((input) => {
      const url = typeof input === "string" ? input : (input?.url ?? "");
      if (url.includes("youtubei/v1/get_transcript")) {
        return Promise.resolve(jsonResponse({ actions: [] }));
      }
      if (url.includes("youtube.com/watch") || url.includes("youtu.be/")) {
        return Promise.resolve(htmlResponse(html));
      }
      return Promise.reject(new Error(`Unexpected fetch call: ${String(url)}`));
    });

    const client = createLinkPreviewClient({ fetch: fetchMock as unknown as typeof fetch });
    const result = await client.fetchLinkContent("https://youtu.be/klmnopqrst0");

    expect(result.content).toBe("Only HTML content");
    expect(result.transcriptCharacters).toBeNull();
    expect(result.transcriptSource).toBe("unavailable");
  });

  it("falls back to Android player captionTracks when bootstrap config is missing", async () => {
    const html =
      "<!doctype html><html><head><title>Sample</title>" +
      '<script>window.__data = {"INNERTUBE_API_KEY":"TEST_KEY"}</script>' +
      "</head><body><article><p>Only HTML content</p></article></body></html>";

    const fetchMock = vi.fn<[RequestInfo | URL, RequestInit?], Promise<Response>>((input) => {
      const url = typeof input === "string" ? input : (input?.url ?? "");
      if (url.includes("youtubei/v1/player")) {
        return Promise.resolve(
          jsonResponse({
            captions: {
              playerCaptionsTracklistRenderer: {
                captionTracks: [{ baseUrl: "https://example.com/captions", languageCode: "en" }],
              },
            },
          }),
        );
      }
      if (url.startsWith("https://example.com/captions")) {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              events: [
                {
                  tStartMs: 0,
                  dDurationMs: 1000,
                  segs: [{ utf8: "Hello from captions" }],
                },
              ],
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          ),
        );
      }
      if (url.includes("youtube.com/watch") || url.includes("youtu.be/")) {
        return Promise.resolve(htmlResponse(html));
      }
      return Promise.reject(new Error(`Unexpected fetch call: ${String(url)}`));
    });

    const client = createLinkPreviewClient({ fetch: fetchMock as unknown as typeof fetch });
    const result = await client.fetchLinkContent("https://www.youtube.com/watch?v=abcdefghijk", {
      youtubeTranscript: "web",
      transcriptTimestamps: true,
    });

    expect(result.content).toBe("Transcript:\n[0:00] Hello from captions");
    expect(result.transcriptSource).toBe("captionTracks");
  });

  it("uses ytInitialPlayerResponse shortDescription when transcripts are unavailable", async () => {
    const html =
      "<!doctype html><html><head><title>Sample</title>" +
      '<script>ytcfg.set({"INNERTUBE_API_KEY":"TEST_KEY","INNERTUBE_CONTEXT":{"client":{"clientName":"WEB","clientVersion":"1.0"}}});</script>' +
      '<script>var ytInitialPlayerResponse = {"videoDetails":{"shortDescription":"Line one\\n\\nLine two"}};</script>' +
      "</head><body><main><p>Fallback paragraph</p></main></body></html>";

    const fetchMock = vi.fn<[RequestInfo | URL, RequestInit?], Promise<Response>>((input) => {
      const url = typeof input === "string" ? input : (input?.url ?? "");
      if (url.includes("youtubei/v1/get_transcript")) {
        return Promise.resolve(jsonResponse({ actions: [] }));
      }
      if (url.includes("youtubei/v1/player")) {
        return Promise.resolve(jsonResponse({}));
      }
      if (url.includes("api.apify.com")) {
        return Promise.resolve(jsonResponse([], 201));
      }
      if (url.includes("youtube.com/watch") || url.includes("youtu.be/")) {
        return Promise.resolve(htmlResponse(html));
      }
      return Promise.reject(new Error(`Unexpected fetch call: ${String(url)}`));
    });

    const client = createLinkPreviewClient({
      fetch: fetchMock as unknown as typeof fetch,
      apifyApiToken: "TEST_TOKEN",
    });
    const result = await client.fetchLinkContent("https://www.youtube.com/watch?v=abcdefghijk");

    expect(result.content).toBe("Line one\nLine two");
    expect(result.transcriptSource).toBe("unavailable");
  });

  it("errors on invalid YouTube video ids", async () => {
    const html = "<!doctype html><html><head><title>Home</title></head><body>Home</body></html>";
    const fetchMock = vi.fn<[RequestInfo | URL, RequestInit?], Promise<Response>>((input) => {
      const url = typeof input === "string" ? input : (input?.url ?? "");
      if (url.includes("youtube.com/watch") || url.includes("youtu.be/")) {
        return Promise.resolve(htmlResponse(html));
      }
      return Promise.reject(new Error(`Unexpected fetch call: ${String(url)}`));
    });

    const client = createLinkPreviewClient({ fetch: fetchMock as unknown as typeof fetch });

    await expect(
      client.fetchLinkContent("https://www.youtube.com/watch?v=invalid_video_id"),
    ).rejects.toThrow(/Invalid YouTube video id/i);
  });
});
