import { mkdtemp, rm, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

describe("transcription/whisper gemini", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it("uses Gemini inline transcription before OpenAI", async () => {
    vi.stubEnv("SUMMARIZE_DISABLE_LOCAL_WHISPER_CPP", "1");
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      expect(url).toContain("/models/gemini-2.5-flash:generateContent");
      const body = JSON.parse(String(init?.body)) as {
        contents?: Array<{
          parts?: Array<{ inline_data?: { mime_type?: string; data?: string } }>;
        }>;
      };
      expect(body.contents?.[0]?.parts?.[1]?.inline_data?.mime_type).toBe("audio/mpeg");
      expect(body.contents?.[0]?.parts?.[1]?.inline_data?.data).toBeTypeOf("string");
      return new Response(
        JSON.stringify({
          candidates: [
            {
              content: {
                parts: [{ text: "gemini transcript" }],
              },
            },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });

    vi.stubGlobal("fetch", fetchMock);
    const { transcribeMediaWithWhisper } =
      await import("../packages/core/src/transcription/whisper.js");
    const result = await transcribeMediaWithWhisper({
      bytes: new Uint8Array([1, 2, 3]),
      mediaType: "audio/mpeg",
      filename: "clip.mp3",
      groqApiKey: null,
      geminiApiKey: "GEMINI",
      openaiApiKey: "OPENAI",
      falApiKey: null,
      env: { SUMMARIZE_DISABLE_LOCAL_WHISPER_CPP: "1" },
    });

    expect(result.text).toBe("gemini transcript");
    expect(result.provider).toBe("gemini");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("falls back from Gemini to OpenAI when Gemini fails", async () => {
    vi.stubEnv("SUMMARIZE_DISABLE_LOCAL_WHISPER_CPP", "1");
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("generativelanguage.googleapis.com")) {
        return new Response(JSON.stringify({ error: { message: "boom" } }), { status: 500 });
      }
      if (url.includes("/audio/transcriptions")) {
        return new Response(JSON.stringify({ text: "openai fallback" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });

    vi.stubGlobal("fetch", fetchMock);
    const { transcribeMediaWithWhisper } =
      await import("../packages/core/src/transcription/whisper.js");
    const result = await transcribeMediaWithWhisper({
      bytes: new Uint8Array([1, 2, 3]),
      mediaType: "audio/mpeg",
      filename: "clip.mp3",
      groqApiKey: null,
      geminiApiKey: "GEMINI",
      openaiApiKey: "OPENAI",
      falApiKey: null,
      env: { SUMMARIZE_DISABLE_LOCAL_WHISPER_CPP: "1" },
    });

    expect(result.text).toBe("openai fallback");
    expect(result.provider).toBe("openai");
    expect(result.notes.join(" ")).toContain("Gemini transcription failed");
  });

  it.each([3, 20 * 1024 * 1024])("uses inline data for a %i-byte local file", async (size) => {
    const root = await mkdtemp(join(tmpdir(), "summarize-gemini-inline-"));
    const filePath = join(root, "audio.mp3");
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe(
        "https://gemini.example/proxy/v1beta/models/custom:generateContent",
      );
      expect(new Headers(init?.headers).get("x-goog-api-key")).toBe("GEMINI");
      const body = JSON.parse(String(init?.body));
      const data = body.contents[0].parts[1].inline_data;
      expect(data.mime_type).toBe("audio/mpeg");
      expect(Buffer.from(data.data, "base64").byteLength).toBe(size);
      return Response.json({
        candidates: [{ content: { parts: [{ text: "inline transcript" }] } }],
      });
    });
    try {
      await writeFile(filePath, new Uint8Array([1, 2, 3]));
      await truncate(filePath, size);
      vi.stubGlobal("fetch", fetchMock);
      const { transcribeFileWithGemini } =
        await import("../packages/core/src/transcription/whisper/gemini.js");
      await expect(
        transcribeFileWithGemini({
          filePath,
          mediaType: "audio/mpeg",
          filename: "audio.mp3",
          apiKey: "GEMINI",
          env: { GOOGLE_BASE_URL: "https://gemini.example/proxy/" },
          model: "custom",
        }),
      ).resolves.toBe("inline transcript");
      expect(fetchMock).toHaveBeenCalledTimes(1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it.each([false, true])(
    "cleans up oversized local files with generation failure=%s",
    async (failGeneration) => {
      vi.stubEnv("SUMMARIZE_DISABLE_LOCAL_WHISPER_CPP", "1");
      const root = await mkdtemp(join(tmpdir(), "summarize-gemini-file-"));
      const audioPath = join(root, "audio.mp3");
      await writeFile(audioPath, new Uint8Array([1, 2, 3]));
      await truncate(audioPath, 20 * 1024 * 1024 + 1);

      const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === "string" ? input : input.toString();
        if (url.endsWith("/upload/v1beta/files")) {
          return new Response(JSON.stringify({}), {
            status: 200,
            headers: {
              "x-goog-upload-url": "https://upload.example/files/123",
            },
          });
        }
        if (url === "https://upload.example/files/123") {
          return new Response(
            JSON.stringify({
              file: {
                name: "files/123",
                uri: "https://files.example/audio",
                state: "ACTIVE",
                mimeType: "audio/mpeg",
              },
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }
        if (url.includes("/models/gemini-2.5-flash:generateContent")) {
          if (failGeneration) return new Response("unavailable", { status: 503 });
          const body = JSON.parse(String(init?.body)) as {
            contents?: Array<{ parts?: Array<{ file_data?: { file_uri?: string } }> }>;
          };
          expect(body.contents?.[0]?.parts?.[1]?.file_data?.file_uri).toBe(
            "https://files.example/audio",
          );
          return new Response(
            JSON.stringify({
              candidates: [
                {
                  content: {
                    parts: [{ text: "uploaded transcript" }],
                  },
                },
              ],
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }
        if (url.endsWith("/v1beta/files/123")) {
          expect(init?.method).toBe("DELETE");
          return new Response(null, { status: 204 });
        }
        throw new Error(`Unexpected fetch: ${url}`);
      });

      try {
        vi.stubGlobal("fetch", fetchMock);
        const { transcribeMediaFileWithWhisper } =
          await import("../packages/core/src/transcription/whisper.js");
        const result = await transcribeMediaFileWithWhisper({
          filePath: audioPath,
          mediaType: "audio/mpeg",
          filename: "audio.mp3",
          groqApiKey: null,
          geminiApiKey: "GEMINI",
          openaiApiKey: null,
          falApiKey: null,
          env: { SUMMARIZE_DISABLE_LOCAL_WHISPER_CPP: "1" },
        });

        if (failGeneration) {
          expect(result.text).toBeNull();
          expect(result.error?.message).toContain("Gemini request failed (503)");
        } else {
          expect(result.text).toBe("uploaded transcript");
          expect(result.provider).toBe("gemini");
        }
        expect(
          fetchMock.mock.calls.some(([input]) => String(input).includes("/upload/v1beta/files")),
        ).toBe(true);
        expect(fetchMock).toHaveBeenCalledWith(
          new URL("https://generativelanguage.googleapis.com/v1beta/files/123"),
          expect.objectContaining({ method: "DELETE" }),
        );
      } finally {
        await rm(root, { recursive: true, force: true }).catch(() => {});
      }
    },
  );
});
