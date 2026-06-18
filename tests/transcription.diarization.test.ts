import { access, mkdtemp, open, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MAX_OPENAI_UPLOAD_BYTES } from "../packages/core/src/transcription/whisper/constants.js";
import { transcribeOpenAiMediaFileInChunks } from "../packages/core/src/transcription/whisper/diarization-openai-chunks.js";
import {
  buildDiarizationModelChain,
  isRetryableOpenAiError,
  resolveOpenAiDiarizationChunkSeconds,
  resolveOpenAiDiarizationBitrateKbps,
  resolveDiarizationProviderOrder,
  transcribeMediaFileWithDiarization,
} from "../packages/core/src/transcription/whisper/diarization.js";
import {
  parseElevenLabsDiarizedSegments,
  transcribeFileWithElevenLabsDiarization,
} from "../packages/core/src/transcription/whisper/elevenlabs.js";
import {
  OpenAiTranscriptionHttpError,
  parseOpenAiDiarizedSegments,
  transcribeFileWithOpenAiDiarization,
} from "../packages/core/src/transcription/whisper/openai.js";

const ffmpegMocks = vi.hoisted(() => ({
  isFfmpegAvailable: vi.fn(async () => true),
  probeMediaDurationSecondsWithFfprobe: vi.fn(async () => null),
  runFfmpegSegment: vi.fn(),
  runFfmpegTranscodeToMp3: vi.fn(),
}));

vi.mock("../packages/core/src/transcription/whisper/ffmpeg.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../packages/core/src/transcription/whisper/ffmpeg.js")>();
  return { ...actual, ...ffmpegMocks };
});

describe("transcription diarization", () => {
  it("selects a duration-aware OpenAI upload bitrate", () => {
    expect(resolveOpenAiDiarizationBitrateKbps(null)).toBe(24);
    expect(resolveOpenAiDiarizationBitrateKbps(2 * 60 * 60)).toBe(24);
    expect(resolveOpenAiDiarizationBitrateKbps(3 * 60 * 60)).toBe(16);
    expect(resolveOpenAiDiarizationBitrateKbps(5 * 60 * 60)).toBe(8);
  });

  it("balances long OpenAI chunks to avoid a tiny trailing request", () => {
    expect(resolveOpenAiDiarizationChunkSeconds(481)).toBe(241);
    expect(resolveOpenAiDiarizationChunkSeconds(600)).toBe(300);
    expect(resolveOpenAiDiarizationChunkSeconds(961)).toBe(321);
  });

  it("retries only transient OpenAI chunk failures", () => {
    expect(isRetryableOpenAiError(new OpenAiTranscriptionHttpError(429, 1_000, null))).toBe(true);
    expect(isRetryableOpenAiError(new OpenAiTranscriptionHttpError(400, null, null))).toBe(false);
    expect(isRetryableOpenAiError(new DOMException("timed out", "TimeoutError"))).toBe(true);
    expect(isRetryableOpenAiError(new TypeError("fetch failed"))).toBe(true);
    expect(
      isRetryableOpenAiError(
        Object.assign(new TypeError("terminated"), { cause: { code: "UND_ERR_SOCKET" } }),
      ),
    ).toBe(true);
    expect(isRetryableOpenAiError(new Error("invalid diarized segment payload"))).toBe(false);
    expect(isRetryableOpenAiError(new OpenAiTranscriptionHttpError(408, null, null))).toBe(true);
    expect(isRetryableOpenAiError(new OpenAiTranscriptionHttpError(409, null, null))).toBe(true);
    expect(isRetryableOpenAiError(new OpenAiTranscriptionHttpError(500, null, null))).toBe(true);
    expect(isRetryableOpenAiError(new DOMException("aborted", "AbortError"))).toBe(true);
    expect(isRetryableOpenAiError(new DOMException("bad", "SyntaxError"))).toBe(false);
    expect(isRetryableOpenAiError(new TypeError("invalid payload"))).toBe(false);
    expect(
      isRetryableOpenAiError(Object.assign(new TypeError("request failed"), { cause: null })),
    ).toBe(false);
  });

  beforeEach(() => {
    vi.clearAllMocks();
    ffmpegMocks.isFfmpegAvailable.mockReset();
    ffmpegMocks.isFfmpegAvailable.mockResolvedValue(true);
    ffmpegMocks.probeMediaDurationSecondsWithFfprobe.mockReset();
    ffmpegMocks.probeMediaDurationSecondsWithFfprobe.mockResolvedValue(null);
    ffmpegMocks.runFfmpegSegment.mockReset();
    ffmpegMocks.runFfmpegTranscodeToMp3.mockReset();
    ffmpegMocks.runFfmpegTranscodeToMp3.mockImplementation(async ({ outputPath }) => {
      await writeFile(outputPath, new Uint8Array([4, 5, 6]));
    });
  });

  it("executes and cleans up OpenAI diarization chunks", async () => {
    ffmpegMocks.runFfmpegSegment.mockImplementation(async ({ outputPattern }) => {
      await writeFile(outputPattern.replace("%05d", "00000"), new Uint8Array([1, 2, 3]));
    });
    const progress = vi.fn();
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              segments: [
                { start: 0, end: 1, speaker: "A", text: "First." },
                { start: 1, end: 2, speaker: "B", text: "Second." },
                { start: 2, speaker: "A", text: "Again." },
              ],
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          ),
      ),
    );

    try {
      const result = await transcribeOpenAiMediaFileInChunks({
        filePath: "/unused/input.mp3",
        apiKey: "OPENAI",
        env: {},
        totalDurationSeconds: 600,
        onProgress: progress,
      });

      expect(result.text).toBe("Speaker 1: First.\nSpeaker 2: Second.\nSpeaker 1: Again.");
      expect(result.segments).toEqual([
        { startMs: 0, endMs: 1_000, speaker: "Speaker 1", text: "First." },
        { startMs: 1_000, endMs: 2_000, speaker: "Speaker 2", text: "Second." },
        { startMs: 2_000, endMs: null, speaker: "Speaker 1", text: "Again." },
      ]);
      expect(progress).toHaveBeenCalledWith({
        partIndex: 1,
        parts: 1,
        processedDurationSeconds: 300,
        totalDurationSeconds: 600,
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("rejects chunked OpenAI diarization without ffmpeg", async () => {
    ffmpegMocks.isFfmpegAvailable.mockResolvedValue(false);
    await expect(
      transcribeOpenAiMediaFileInChunks({
        filePath: "/unused/input.mp3",
        apiKey: "OPENAI",
        env: {},
        totalDurationSeconds: null,
      }),
    ).rejects.toThrow("requires ffmpeg");
  });

  it("rejects when ffmpeg produces no diarization chunks", async () => {
    ffmpegMocks.runFfmpegSegment.mockResolvedValue(undefined);
    await expect(
      transcribeOpenAiMediaFileInChunks({
        filePath: "/unused/input.mp3",
        apiKey: "OPENAI",
        env: {},
        totalDurationSeconds: null,
      }),
    ).rejects.toThrow("produced no OpenAI diarization chunks");
  });

  it("propagates non-retryable OpenAI chunk failures", async () => {
    ffmpegMocks.runFfmpegSegment.mockImplementation(async ({ outputPattern }) => {
      await writeFile(outputPattern.replace("%05d", "00000"), new Uint8Array([1]));
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("bad request", { status: 400 })),
    );

    try {
      await expect(
        transcribeOpenAiMediaFileInChunks({
          filePath: "/unused/input.mp3",
          apiKey: "OPENAI",
          env: {},
          totalDurationSeconds: null,
        }),
      ).rejects.toMatchObject({ status: 400 });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("retries transient OpenAI chunk failures", async () => {
    ffmpegMocks.runFfmpegSegment.mockImplementation(async ({ outputPattern }) => {
      await writeFile(outputPattern.replace("%05d", "00000"), new Uint8Array([1]));
    });
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response("temporary", { status: 500 }))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            segments: [{ start: 0, end: 1, speaker: "A", text: "Recovered." }],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      );
    vi.stubGlobal("fetch", fetchMock);
    const timeoutSpy = vi.spyOn(globalThis, "setTimeout").mockImplementation((callback) => {
      queueMicrotask(() => callback());
      return undefined as unknown as ReturnType<typeof setTimeout>;
    });

    try {
      await expect(
        transcribeOpenAiMediaFileInChunks({
          filePath: "/unused/input.mp3",
          apiKey: "OPENAI",
          env: {},
          totalDurationSeconds: null,
        }),
      ).resolves.toMatchObject({ text: "Speaker 1: Recovered." });
      expect(fetchMock).toHaveBeenCalledTimes(2);
    } finally {
      timeoutSpy.mockRestore();
      vi.unstubAllGlobals();
    }
  });

  it("prefers ElevenLabs and falls back to OpenAI in auto mode", () => {
    const providers = resolveDiarizationProviderOrder({
      preference: "auto",
      elevenlabsApiKey: "ELEVEN",
      openaiApiKey: "OPENAI",
    });
    expect(providers).toEqual(["elevenlabs", "openai"]);
    expect(buildDiarizationModelChain(providers)).toBe(
      "elevenlabs/scribe_v2->gpt-4o-transcribe-diarize",
    );
  });

  it("groups ElevenLabs words into speaker-labelled segments", () => {
    expect(
      parseElevenLabsDiarizedSegments([
        { text: "Hello", start: 0, end: 0.4, speaker_id: "speaker_1" },
        { text: ",", start: 0.4, end: 0.5, speaker_id: "speaker_1" },
        { text: "world", start: 0.5, end: 0.9, speaker_id: "speaker_1" },
        { text: "Hi", start: 1.1, end: 1.4, speaker_id: "speaker_2" },
      ]),
    ).toEqual([
      { startMs: 0, endMs: 900, text: "Hello, world", speaker: "Speaker 1" },
      { startMs: 1100, endMs: 1400, text: "Hi", speaker: "Speaker 2" },
    ]);
  });

  it("parses OpenAI diarized JSON segments", () => {
    expect(
      parseOpenAiDiarizedSegments([
        { start: 0.25, end: 1.5, speaker: "A", text: "Welcome." },
        { start: 1.6, end: 2.2, speaker: "B", text: "Thanks." },
      ]),
    ).toEqual([
      { startMs: 250, endMs: 1500, speaker: "Speaker A", text: "Welcome." },
      { startMs: 1600, endMs: 2200, speaker: "Speaker B", text: "Thanks." },
    ]);
  });

  it("sends ElevenLabs Scribe v2 diarization fields and formats output", async () => {
    const root = await mkdtemp(join(tmpdir(), "summarize-elevenlabs-diarize-"));
    const filePath = join(root, "audio.mp3");
    await writeFile(filePath, new Uint8Array([1, 2, 3]));
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const form = init?.body as FormData;
      expect(form.get("model_id")).toBe("scribe_v2");
      expect(form.get("diarize")).toBe("true");
      expect(form.get("timestamps_granularity")).toBe("word");
      expect(init?.headers).toEqual({ "xi-api-key": "ELEVEN" });
      expect(Object.hasOwn(init ?? {}, "dispatcher")).toBe(false);
      return new Response(
        JSON.stringify({
          words: [
            { text: "Hello", start: 0, end: 0.5, speaker_id: "speaker_1" },
            { text: "Hi", start: 0.7, end: 1, speaker_id: "speaker_2" },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });

    try {
      const result = await transcribeFileWithElevenLabsDiarization({
        filePath,
        mediaType: "audio/mpeg",
        filename: "audio.mp3",
        apiKey: "ELEVEN",
        fetchImpl: fetchMock,
      });
      expect(result.provider).toBe("elevenlabs");
      expect(result.text).toBe("Speaker 1: Hello\nSpeaker 2: Hi");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("extends native fetch timeouts through the configured dispatcher", async () => {
    const root = await mkdtemp(join(tmpdir(), "summarize-elevenlabs-timeout-"));
    const filePath = join(root, "audio.mp3");
    await writeFile(filePath, new Uint8Array([1, 2, 3]));
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => {
      return new Response(
        JSON.stringify({
          words: [{ text: "Hello", start: 0, end: 0.5, speaker_id: "speaker_1" }],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });
    const dispatcherV1Symbol = Symbol.for("undici.globalDispatcher.1");
    const dispatcherV2Symbol = Symbol.for("undici.globalDispatcher.2");
    const originalV1 = Object.getOwnPropertyDescriptor(globalThis, dispatcherV1Symbol);
    const originalV2 = Object.getOwnPropertyDescriptor(globalThis, dispatcherV2Symbol);
    const dispatchV1 = vi.fn(() => true);
    const dispatchV2 = vi.fn(() => true);
    const configuredV1 = { dispatch: dispatchV1 };
    const configuredV2 = { dispatch: dispatchV2 };
    Reflect.set(globalThis, dispatcherV1Symbol, configuredV1);
    Reflect.set(globalThis, dispatcherV2Symbol, configuredV2);
    vi.stubGlobal("fetch", fetchMock);

    try {
      const result = await transcribeFileWithElevenLabsDiarization({
        filePath,
        mediaType: "audio/mpeg",
        filename: "audio.mp3",
        apiKey: "ELEVEN",
      });

      expect(result.provider).toBe("elevenlabs");
      const requestInit = fetchMock.mock.calls[0]?.[1] as
        | (RequestInit & {
            dispatcher?: {
              dispatch: (options: Record<string, unknown>, handler: unknown) => boolean;
            };
          })
        | undefined;
      const dispatcher = requestInit?.dispatcher;
      expect(dispatcher).toBeDefined();
      expect(requestInit?.signal).toBeInstanceOf(AbortSignal);

      const handlerV1 = { onConnect: vi.fn() };
      const handlerV2 = { onRequestStart: vi.fn() };
      expect(dispatcher?.dispatch({ path: "/v1", headersTimeout: 300_000 }, handlerV1)).toBe(true);
      expect(dispatcher?.dispatch({ path: "/v2", bodyTimeout: 300_000 }, handlerV2)).toBe(true);
      expect(dispatchV1).toHaveBeenCalledWith(
        { path: "/v1", headersTimeout: 0, bodyTimeout: 0 },
        handlerV1,
      );
      expect(dispatchV2).toHaveBeenCalledWith(
        { path: "/v2", headersTimeout: 0, bodyTimeout: 0 },
        handlerV2,
      );
      expect(Reflect.get(globalThis, dispatcherV1Symbol)).toBe(configuredV1);
      expect(Reflect.get(globalThis, dispatcherV2Symbol)).toBe(configuredV2);
    } finally {
      vi.unstubAllGlobals();
      restoreGlobalProperty(dispatcherV1Symbol, originalV1);
      restoreGlobalProperty(dispatcherV2Symbol, originalV2);
      await rm(root, { recursive: true, force: true });
    }
  });

  it("uses the Node native dispatcher contract for default ElevenLabs requests", async () => {
    const root = await mkdtemp(join(tmpdir(), "summarize-elevenlabs-native-fetch-"));
    const filePath = join(root, "audio.mp3");
    await writeFile(filePath, new Uint8Array([1, 2, 3]));
    const server = createServer((request, response) => {
      request.resume();
      request.once("end", () => {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            words: [{ text: "Hello", start: 0, end: 0.5, speaker_id: "speaker_1" }],
          }),
        );
      });
    });

    try {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", resolve);
      });
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("test server has no TCP port");

      const result = await transcribeFileWithElevenLabsDiarization({
        filePath,
        mediaType: "audio/mpeg",
        filename: "audio.mp3",
        apiKey: "ELEVEN",
        baseUrl: `http://127.0.0.1:${address.port}/speech-to-text`,
      });

      expect(result.provider).toBe("elevenlabs");
      expect(result.text).toBe("Speaker 1: Hello");
    } finally {
      server.closeAllConnections();
      if (server.listening) {
        await new Promise<void>((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()));
        });
      }
      await rm(root, { recursive: true, force: true });
    }
  });

  it("uses OpenAI's diarization model and response format", async () => {
    const root = await mkdtemp(join(tmpdir(), "summarize-openai-diarize-"));
    const filePath = join(root, "audio.mp3");
    await writeFile(filePath, new Uint8Array([1, 2, 3]));
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const form = init?.body as FormData;
      expect(form.get("model")).toBe("gpt-4o-transcribe-diarize");
      expect(form.get("response_format")).toBe("diarized_json");
      expect(form.get("chunking_strategy")).toBe("auto");
      return new Response(
        JSON.stringify({
          segments: [{ start: 0, end: 1, speaker: "A", text: "Hello." }],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });

    try {
      vi.stubGlobal("fetch", fetchMock);
      const result = await transcribeFileWithOpenAiDiarization({
        filePath,
        mediaType: "audio/mpeg",
        filename: "audio.mp3",
        apiKey: "OPENAI",
      });
      expect(result.provider).toBe("openai");
      expect(result.text).toBe("Speaker A: Hello.");
    } finally {
      vi.unstubAllGlobals();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("extracts video audio once and reuses it across diarization fallbacks", async () => {
    const root = await mkdtemp(join(tmpdir(), "summarize-video-diarize-"));
    const filePath = join(root, "interview.mp4");
    await writeFile(filePath, new Uint8Array([1, 2, 3, 4, 5, 6]));
    const uploads: Array<{ name: string; size: number; type: string }> = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const form = init?.body as FormData;
      const file = form.get("file") as File;
      uploads.push({ name: file.name, size: file.size, type: file.type });
      if (input.toString().includes("elevenlabs")) {
        return new Response("temporary failure", { status: 500 });
      }
      return new Response(
        JSON.stringify({
          segments: [{ start: 0, end: 1, speaker: "A", text: "Hello." }],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });
    let preparedPath: string | null = null;
    ffmpegMocks.runFfmpegTranscodeToMp3.mockImplementationOnce(
      async ({ outputPath, bitrateKbps }) => {
        expect(bitrateKbps).toBe(24);
        preparedPath = outputPath;
        await writeFile(outputPath, new Uint8Array([4, 5, 6]));
      },
    );

    try {
      vi.stubGlobal("fetch", fetchMock);
      const result = await transcribeMediaFileWithDiarization({
        filePath,
        mediaType: "video/mp4",
        filename: "interview.mp4",
        preference: "auto",
        elevenlabsApiKey: "ELEVEN",
        openaiApiKey: "OPENAI",
        env: {},
        totalDurationSeconds: 60,
      });
      expect(result.provider).toBe("openai");
      expect(result.notes).toContain(
        "Diarization: extracted audio from video as mono 16 kHz 24 kbps MP3",
      );
      expect(ffmpegMocks.runFfmpegTranscodeToMp3).toHaveBeenCalledTimes(1);
      expect(uploads).toEqual([
        { name: "audio.mp3", size: 3, type: "audio/mpeg" },
        { name: "audio.mp3", size: 3, type: "audio/mpeg" },
      ]);
      expect(preparedPath).not.toBeNull();
      await expect(access(preparedPath!)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      vi.unstubAllGlobals();
      if (preparedPath) await rm(preparedPath, { force: true });
      await rm(root, { recursive: true, force: true });
    }
  });

  it("uses a higher bitrate for ElevenLabs-only video diarization", async () => {
    const root = await mkdtemp(join(tmpdir(), "summarize-elevenlabs-video-diarize-"));
    const filePath = join(root, "interview.mp4");
    await writeFile(filePath, new Uint8Array([1, 2, 3]));
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const form = init?.body as FormData;
      const file = form.get("file") as File;
      expect(file.name).toBe("audio.mp3");
      expect(file.type).toBe("audio/mpeg");
      return new Response(
        JSON.stringify({
          words: [{ text: "Hello", start: 0, end: 1, speaker_id: "speaker_1" }],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });

    try {
      vi.stubGlobal("fetch", fetchMock);
      const result = await transcribeMediaFileWithDiarization({
        filePath,
        mediaType: "video/mp4",
        filename: "interview.mp4",
        preference: "elevenlabs",
        elevenlabsApiKey: "ELEVEN",
        openaiApiKey: null,
        env: {},
        totalDurationSeconds: 60,
      });
      expect(result.provider).toBe("elevenlabs");
      expect(ffmpegMocks.runFfmpegTranscodeToMp3).toHaveBeenCalledWith({
        inputPath: filePath,
        outputPath: expect.stringMatching(/summarize-diarize-audio-.*\.mp3$/),
        bitrateKbps: 32,
      });
    } finally {
      vi.unstubAllGlobals();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("preserves the original video when local audio extraction is unavailable", async () => {
    const root = await mkdtemp(join(tmpdir(), "summarize-video-diarize-no-ffmpeg-"));
    const filePath = join(root, "interview.mp4");
    await writeFile(filePath, new Uint8Array([1, 2, 3]));
    ffmpegMocks.isFfmpegAvailable.mockResolvedValueOnce(false);
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const form = init?.body as FormData;
      const file = form.get("file") as File;
      expect(file.name).toBe("interview.mp4");
      expect(file.type).toBe("video/mp4");
      return new Response(
        JSON.stringify({
          words: [{ text: "Hello", start: 0, end: 1, speaker_id: "speaker_1" }],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });

    try {
      vi.stubGlobal("fetch", fetchMock);
      const result = await transcribeMediaFileWithDiarization({
        filePath,
        mediaType: "video/mp4",
        filename: "interview.mp4",
        preference: "elevenlabs",
        elevenlabsApiKey: "ELEVEN",
        openaiApiKey: null,
        env: {},
        totalDurationSeconds: 60,
      });
      expect(result.provider).toBe("elevenlabs");
      expect(result.notes).toContain(
        "Diarization: local audio extraction unavailable; uploading the original video",
      );
      expect(ffmpegMocks.runFfmpegTranscodeToMp3).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("uses a smaller original video when extracted audio exceeds OpenAI's limit", async () => {
    const root = await mkdtemp(join(tmpdir(), "summarize-video-diarize-smaller-original-"));
    const filePath = join(root, "interview.mp4");
    await writeFile(filePath, new Uint8Array([1, 2, 3]));
    ffmpegMocks.runFfmpegTranscodeToMp3.mockImplementationOnce(async ({ outputPath }) => {
      const handle = await open(outputPath, "w");
      await handle.truncate(MAX_OPENAI_UPLOAD_BYTES + 1);
      await handle.close();
    });
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const form = init?.body as FormData;
      const file = form.get("file") as File;
      expect(file.name).toBe("interview.mp4");
      expect(file.type).toBe("video/mp4");
      expect(file.size).toBe(3);
      return new Response(
        JSON.stringify({
          segments: [{ start: 0, end: 1, speaker: "A", text: "Hello." }],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });

    try {
      vi.stubGlobal("fetch", fetchMock);
      const result = await transcribeMediaFileWithDiarization({
        filePath,
        mediaType: "video/mp4",
        filename: "interview.mp4",
        preference: "openai",
        elevenlabsApiKey: null,
        openaiApiKey: "OPENAI",
        env: {},
        totalDurationSeconds: 60,
      });
      expect(result.provider).toBe("openai");
      expect(result.notes).toContain(
        "OpenAI diarization: extracted audio exceeded the upload limit; using the smaller original video",
      );
      expect(ffmpegMocks.runFfmpegTranscodeToMp3).toHaveBeenCalledTimes(1);
    } finally {
      vi.unstubAllGlobals();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("allows a speechless OpenAI chunk without accepting an empty full recording", async () => {
    const root = await mkdtemp(join(tmpdir(), "summarize-openai-diarize-empty-"));
    const filePath = join(root, "audio.mp3");
    await writeFile(filePath, new Uint8Array([1, 2, 3]));
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ segments: [] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );

    try {
      vi.stubGlobal("fetch", fetchMock);
      await expect(
        transcribeFileWithOpenAiDiarization({
          filePath,
          mediaType: "audio/mpeg",
          filename: "audio.mp3",
          apiKey: "OPENAI",
        }),
      ).rejects.toThrow(/no speaker-labelled segments/);
      const chunk = await transcribeFileWithOpenAiDiarization({
        filePath,
        mediaType: "audio/mpeg",
        filename: "audio.mp3",
        apiKey: "OPENAI",
        options: { allowEmpty: true },
      });
      expect(chunk).toMatchObject({ text: null, error: null, segments: [] });

      fetchMock.mockResolvedValueOnce(
        new Response(JSON.stringify({ segments: [{ start: 0, end: 1, speaker: "A", text: "" }] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
      const silenceMarker = await transcribeFileWithOpenAiDiarization({
        filePath,
        mediaType: "audio/mpeg",
        filename: "audio.mp3",
        apiKey: "OPENAI",
        options: { allowEmpty: true },
      });
      expect(silenceMarker).toMatchObject({ text: null, error: null, segments: [] });

      fetchMock.mockResolvedValueOnce(
        new Response(JSON.stringify({ text: "Spoken content", segments: [] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
      await expect(
        transcribeFileWithOpenAiDiarization({
          filePath,
          mediaType: "audio/mpeg",
          filename: "audio.mp3",
          apiKey: "OPENAI",
          options: { allowEmpty: true },
        }),
      ).rejects.toThrow(/transcript text without diarized segments/);

      fetchMock.mockResolvedValueOnce(
        new Response(JSON.stringify({ nope: [] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
      await expect(
        transcribeFileWithOpenAiDiarization({
          filePath,
          mediaType: "audio/mpeg",
          filename: "audio.mp3",
          apiKey: "OPENAI",
          options: { allowEmpty: true },
        }),
      ).rejects.toThrow(/invalid diarized segment payload/);
    } finally {
      vi.unstubAllGlobals();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("preserves OpenAI rate-limit reset timing on HTTP errors", async () => {
    const root = await mkdtemp(join(tmpdir(), "summarize-openai-diarize-rate-limit-"));
    const filePath = join(root, "audio.mp3");
    await writeFile(filePath, new Uint8Array([1, 2, 3]));
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response("rate limited", {
            status: 429,
            headers: {
              "x-ratelimit-remaining-tokens": "0",
              "x-ratelimit-reset-tokens": "1m2.5s",
            },
          }),
      ),
    );

    try {
      const error = await transcribeFileWithOpenAiDiarization({
        filePath,
        mediaType: "audio/mpeg",
        filename: "audio.mp3",
        apiKey: "OPENAI",
      }).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(OpenAiTranscriptionHttpError);
      expect(error).toMatchObject({ status: 429, retryAfterMs: 62_500 });

      vi.mocked(globalThis.fetch).mockResolvedValueOnce(
        new Response("Rate limit reached on tokens per min (TPM)", {
          status: 429,
          headers: {
            "x-ratelimit-remaining-tokens": "100",
            "x-ratelimit-reset-requests": "100ms",
            "x-ratelimit-reset-tokens": "45s",
          },
        }),
      );
      const tokenBucketError = await transcribeFileWithOpenAiDiarization({
        filePath,
        mediaType: "audio/mpeg",
        filename: "audio.mp3",
        apiKey: "OPENAI",
      }).catch((caught: unknown) => caught);
      expect(tokenBucketError).toMatchObject({ status: 429, retryAfterMs: 45_000 });

      vi.mocked(globalThis.fetch).mockResolvedValueOnce(
        new Response("rate limited", {
          status: 429,
          headers: { "retry-after-ms": "60000" },
        }),
      );
      const preciseError = await transcribeFileWithOpenAiDiarization({
        filePath,
        mediaType: "audio/mpeg",
        filename: "audio.mp3",
        apiKey: "OPENAI",
      }).catch((caught: unknown) => caught);
      expect(preciseError).toMatchObject({ status: 429, retryAfterMs: 60_000 });

      vi.mocked(globalThis.fetch).mockResolvedValueOnce(
        new Response("rate limited", {
          status: 429,
          headers: {
            "x-ratelimit-remaining-requests": "0",
            "x-ratelimit-reset-requests": "300",
          },
        }),
      );
      const unitlessResetError = await transcribeFileWithOpenAiDiarization({
        filePath,
        mediaType: "audio/mpeg",
        filename: "audio.mp3",
        apiKey: "OPENAI",
      }).catch((caught: unknown) => caught);
      expect(unitlessResetError).toMatchObject({ status: 429, retryAfterMs: 300_000 });
    } finally {
      vi.unstubAllGlobals();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("chunks long OpenAI diarization and keeps chunk-local labels distinct", async () => {
    const root = await mkdtemp(join(tmpdir(), "summarize-openai-diarize-long-"));
    const filePath = join(root, "audio.mp3");
    await writeFile(filePath, new Uint8Array([1, 2, 3]));
    ffmpegMocks.runFfmpegSegment.mockImplementationOnce(async ({ outputPattern }) => {
      await writeFile(outputPattern.replace("%05d", "00000"), new Uint8Array([1]));
      await writeFile(outputPattern.replace("%05d", "00001"), new Uint8Array([2]));
    });
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            segments: [{ start: 1, end: 2, speaker: "A", text: "Hello." }],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    );

    try {
      vi.stubGlobal("fetch", fetchMock);
      const result = await transcribeMediaFileWithDiarization({
        filePath,
        mediaType: "audio/mpeg",
        filename: "audio.mp3",
        preference: "openai",
        elevenlabsApiKey: null,
        openaiApiKey: "OPENAI",
        env: {},
        totalDurationSeconds: 600,
      });
      expect(ffmpegMocks.runFfmpegSegment).toHaveBeenCalledWith(
        expect.objectContaining({ segmentSeconds: 300 }),
      );
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(result.segments).toEqual([
        { startMs: 1_000, endMs: 2_000, speaker: "Speaker 1", text: "Hello." },
        { startMs: 301_000, endMs: 302_000, speaker: "Speaker 1001", text: "Hello." },
      ]);
      expect(result.text).toBe("Speaker 1: Hello.\nSpeaker 1001: Hello.");
    } finally {
      vi.unstubAllGlobals();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("chunks OpenAI media when duration probing is unavailable", async () => {
    const root = await mkdtemp(join(tmpdir(), "summarize-openai-diarize-unknown-duration-"));
    const filePath = join(root, "audio.webm");
    await writeFile(filePath, new Uint8Array([1, 2, 3]));
    ffmpegMocks.runFfmpegSegment.mockImplementationOnce(async ({ outputPattern }) => {
      await writeFile(outputPattern.replace("%05d", "00000"), new Uint8Array([1]));
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              segments: [{ start: 1, end: 2, speaker: "A", text: "Hello." }],
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          ),
      ),
    );

    const progress: Array<{
      processedDurationSeconds: number | null;
      totalDurationSeconds: number | null;
    }> = [];
    try {
      const result = await transcribeMediaFileWithDiarization({
        filePath,
        mediaType: "audio/webm",
        filename: "audio.webm",
        preference: "openai",
        elevenlabsApiKey: null,
        openaiApiKey: "OPENAI",
        env: {},
        totalDurationSeconds: null,
        onProgress: (event) => progress.push(event),
      });
      expect(ffmpegMocks.runFfmpegSegment).toHaveBeenCalledWith(
        expect.objectContaining({ segmentSeconds: 480 }),
      );
      expect(result.text).toBe("Speaker 1: Hello.");
      expect(progress.at(-1)).toMatchObject({
        processedDurationSeconds: null,
        totalDurationSeconds: null,
      });
    } finally {
      vi.unstubAllGlobals();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("removes partial OpenAI compression output after ffmpeg failure", async () => {
    const root = await mkdtemp(join(tmpdir(), "summarize-openai-diarize-cleanup-"));
    const filePath = join(root, "large-audio.wav");
    const handle = await open(filePath, "w");
    await handle.truncate(MAX_OPENAI_UPLOAD_BYTES + 1);
    await handle.close();
    let partialPath: string | null = null;
    ffmpegMocks.runFfmpegTranscodeToMp3.mockImplementationOnce(async ({ outputPath }) => {
      partialPath = outputPath;
      await writeFile(outputPath, new Uint8Array([1, 2, 3]));
      throw new Error("ffmpeg failed");
    });

    try {
      const result = await transcribeMediaFileWithDiarization({
        filePath,
        mediaType: "audio/wav",
        filename: "large-audio.wav",
        preference: "openai",
        elevenlabsApiKey: null,
        openaiApiKey: "OPENAI",
        env: {},
        totalDurationSeconds: 60,
      });
      expect(result.error?.message).toContain("ffmpeg failed");
      expect(partialPath).not.toBeNull();
      await expect(access(partialPath!)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      if (partialPath) await rm(partialPath, { force: true });
      await rm(root, { recursive: true, force: true });
    }
  });
});

function restoreGlobalProperty(symbol: symbol, descriptor: PropertyDescriptor | undefined): void {
  if (descriptor) {
    Object.defineProperty(globalThis, symbol, descriptor);
  } else {
    Reflect.deleteProperty(globalThis, symbol);
  }
}
