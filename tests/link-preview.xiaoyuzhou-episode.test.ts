import { readFile } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import { fetchLinkContent } from "../packages/core/src/content/link-preview/content/index.js";
import { extractXiaoyuzhouOgAudioUrl } from "../packages/core/src/content/transcript/providers/podcast/xiaoyuzhou.js";

const EPISODE_URL = "https://www.xiaoyuzhoufm.com/episode/6a55a96dca0de6c44ae6bb29";
const AUDIO_URL = "https://media.xyzcdn.net/fixture/episode.m4a";
const FIXTURE_HTML = await readFile(
  new URL("./fixtures/xiaoyuzhou-episode.html", import.meta.url),
  "utf8",
);

function deps(fetchImpl: typeof fetch, remoteMediaMaxBytes = "1024") {
  return {
    fetch: fetchImpl,
    env: {
      SUMMARIZE_DISABLE_LOCAL_WHISPER_CPP: "1",
      SUMMARIZE_REMOTE_MEDIA_MAX_BYTES: remoteMediaMaxBytes,
      ASSEMBLYAI_API_KEY: "",
      DEEPGRAM_API_KEY: "",
      FAL_KEY: "",
      GEMINI_API_KEY: "",
      GOOGLE_API_KEY: "",
      GOOGLE_GENERATIVE_AI_API_KEY: "",
      GROQ_API_KEY: "",
      OPENAI_API_KEY: "",
    },
    scrapeWithFirecrawl: null,
    apifyApiToken: null,
    ytDlpPath: null,
    groqApiKey: null,
    assemblyaiApiKey: null,
    deepgramApiKey: null,
    falApiKey: null,
    geminiApiKey: null,
    openaiApiKey: "OPENAI",
    convertHtmlToMarkdown: null,
    transcriptCache: null,
  };
}

function inputUrl(input: RequestInfo | URL): string {
  return typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
}

describe("Xiaoyuzhou episode resolver", () => {
  it("accepts only credential-free HTTPS media.xyzcdn.net metadata", () => {
    expect(extractXiaoyuzhouOgAudioUrl(FIXTURE_HTML)).toBe(AUDIO_URL);
    for (const candidate of [
      "http://media.xyzcdn.net/fixture/episode.m4a",
      "https://other.example/fixture/episode.m4a",
      "https://user@media.xyzcdn.net/fixture/episode.m4a",
      "https://media.xyzcdn.net:8443/fixture/episode.m4a",
      "not a URL",
      "",
    ]) {
      const html = `<meta property="og:audio" content="${candidate}">`;
      expect(extractXiaoyuzhouOgAudioUrl(html), candidate).toBeNull();
    }
    expect(extractXiaoyuzhouOgAudioUrl("<html><head></head></html>")).toBeNull();
  });

  it("extracts fixture og:audio and hands it to guarded media transcription", async () => {
    const mediaFetches: RequestInit[] = [];
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = inputUrl(input);
      const method = (init?.method ?? "GET").toUpperCase();
      if (url === EPISODE_URL) {
        return new Response(FIXTURE_HTML, {
          status: 200,
          headers: { "content-type": "text/html" },
        });
      }
      if (url === AUDIO_URL) {
        mediaFetches.push(init ?? {});
        if (method === "HEAD") {
          return new Response(null, {
            status: 200,
            headers: { "content-type": "audio/mp4", "content-length": "4" },
          });
        }
        return new Response(new Uint8Array([0, 1, 2, 3]), {
          status: 200,
          headers: { "content-type": "audio/mp4", "content-length": "4" },
        });
      }
      throw new Error(`Unexpected fetch: ${method} ${url}`);
    });
    const openaiFetch = vi.fn(async (input: RequestInfo | URL) => {
      expect(inputUrl(input)).toContain("api.openai.com/v1/audio/transcriptions");
      return new Response(JSON.stringify({ text: "hello from Xiaoyuzhou" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });

    try {
      vi.stubGlobal("fetch", openaiFetch as unknown as typeof fetch);
      const result = await fetchLinkContent(
        EPISODE_URL,
        { cacheMode: "bypass", timeoutMs: 60_000 },
        deps(fetchImpl as unknown as typeof fetch),
      );

      expect(result.transcriptSource).toBe("whisper");
      expect(result.content).toContain("hello from Xiaoyuzhou");
      expect(result.siteName).toBe("Xiaoyuzhou");
      expect(result.diagnostics.transcript.notes).toContain("validated og:audio");
      expect(mediaFetches).toHaveLength(3);
      expect(mediaFetches.every((init) => init.redirect === "manual")).toBe(true);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it.each([
    {
      name: "non-audio response",
      head: () =>
        new Response(null, {
          status: 200,
          headers: { "content-type": "text/html", "content-length": "4" },
        }),
      limit: "1024",
      message: /non-audio content/,
    },
    {
      name: "oversized response",
      head: () =>
        new Response(null, {
          status: 200,
          headers: { "content-type": "audio/mp4", "content-length": "5" },
        }),
      limit: "4",
      message: /Remote media too large/,
    },
    {
      name: "cross-host redirect",
      head: () =>
        new Response(null, {
          status: 302,
          headers: { location: "https://other.example/episode.m4a" },
        }),
      limit: "1024",
      message: /redirected to another host/,
    },
  ])("rejects $name", async ({ head, limit, message }) => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = inputUrl(input);
      const method = (init?.method ?? "GET").toUpperCase();
      if (url === EPISODE_URL) {
        return new Response(FIXTURE_HTML, {
          status: 200,
          headers: { "content-type": "text/html" },
        });
      }
      if (url === AUDIO_URL && method === "HEAD") return head();
      throw new Error(`Unexpected fetch: ${method} ${url}`);
    });

    await expect(
      fetchLinkContent(
        EPISODE_URL,
        { cacheMode: "bypass", timeoutMs: 60_000 },
        deps(fetchImpl as unknown as typeof fetch, limit),
      ),
    ).rejects.toThrow(message);
  });

  it("rejects a cross-host redirect that appears only during download", async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = inputUrl(input);
      const method = (init?.method ?? "GET").toUpperCase();
      if (url === EPISODE_URL) {
        return new Response(FIXTURE_HTML, {
          status: 200,
          headers: { "content-type": "text/html" },
        });
      }
      if (url === AUDIO_URL && method === "HEAD") {
        return new Response(null, {
          status: 200,
          headers: { "content-type": "audio/mp4", "content-length": "4" },
        });
      }
      if (url === AUDIO_URL) {
        return new Response(null, {
          status: 302,
          headers: { location: "https://other.example/episode.m4a" },
        });
      }
      throw new Error(`Unexpected fetch: ${method} ${url}`);
    });

    await expect(
      fetchLinkContent(
        EPISODE_URL,
        { cacheMode: "bypass", timeoutMs: 60_000 },
        deps(fetchImpl as unknown as typeof fetch),
      ),
    ).rejects.toThrow(/redirected to another host/);
  });
});
