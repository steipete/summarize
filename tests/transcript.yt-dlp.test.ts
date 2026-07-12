import { EventEmitter } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const spawnMock = vi.hoisted(() => vi.fn());
const fsMock = vi.hoisted(() => ({
  stat: vi.fn(),
  readFile: vi.fn(),
  unlink: vi.fn(),
  openAsBlob: vi.fn(),
}));
const falMock = vi.hoisted(() => ({
  createFalClient: vi.fn(),
}));

vi.mock("node:child_process", () => ({ spawn: spawnMock }));
vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
  return {
    ...actual,
    promises: fsMock,
    openAsBlob: fsMock.openAsBlob,
  };
});
vi.mock("../packages/core/src/transcription/whisper/fal-client.js", () => falMock);
vi.mock("../packages/core/src/transcription/whisper/ffmpeg.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../packages/core/src/transcription/whisper/ffmpeg.js")>();
  return {
    ...actual,
    probeMediaDurationSecondsWithFfprobe: vi.fn(async () => 2),
  };
});

import {
  buildYtDlpDownloadArgs,
  fetchTranscriptWithYtDlp,
} from "../packages/core/src/content/transcript/providers/youtube/yt-dlp.js";

const mockSpawnSuccess = () => {
  spawnMock.mockImplementation(() => {
    const proc = new EventEmitter() as unknown as {
      stdout?: PassThrough;
      stderr?: PassThrough;
      kill?: (signal?: string) => void;
      on: (event: string, listener: (...args: unknown[]) => void) => void;
      emit: (event: string, ...args: unknown[]) => void;
    };
    proc.stdout = new PassThrough();
    proc.stderr = new PassThrough();
    proc.kill = vi.fn();
    process.nextTick(() => proc.emit("close", 0, null));
    return proc;
  });
};

describe("yt-dlp transcript helper", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("SUMMARIZE_DISABLE_LOCAL_WHISPER_CPP", "1");
    vi.stubEnv("SUMMARIZE_ONNX_PARAKEET_CMD", "");
    vi.stubEnv("SUMMARIZE_ONNX_CANARY_CMD", "");
    vi.stubEnv("GROQ_API_KEY", "");
    vi.stubEnv("ASSEMBLYAI_API_KEY", "");
    vi.stubEnv("OPENAI_API_KEY", "");
    vi.stubEnv("FAL_KEY", "");
    vi.stubEnv("DEEPGRAM_API_KEY", "");
    vi.stubEnv("SUMMARIZE_DEEPGRAM_TRANSCRIPTION_MODEL", "");
    vi.stubEnv("GEMINI_API_KEY", "");
    vi.stubEnv("GOOGLE_GENERATIVE_AI_API_KEY", "");
    vi.stubEnv("GOOGLE_API_KEY", "");
    mockSpawnSuccess();
    fsMock.stat.mockResolvedValue({ size: 5 });
    fsMock.readFile.mockResolvedValue(Buffer.from("audio"));
    fsMock.unlink.mockResolvedValue(undefined);
    fsMock.openAsBlob.mockResolvedValue(
      new Blob([new Uint8Array([1, 2, 3])], { type: "audio/mpeg" }),
    );
    globalThis.fetch = vi.fn() as unknown as typeof fetch;
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    globalThis.fetch = originalFetch;
  });

  it("skips yt-dlp download for local file URLs", async () => {
    const root = await mkdtemp(join(tmpdir(), "summarize-ytdlp-local-"));
    const filePath = join(root, "local-video.webm");
    await writeFile(filePath, new Uint8Array([1, 2, 3]));
    (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(
      new Response(JSON.stringify({ text: "Local transcript" }), { status: 200 }),
    );

    try {
      const events: string[] = [];
      const result = await fetchTranscriptWithYtDlp({
        ytDlpPath: "/usr/bin/yt-dlp",
        groqApiKey: null,
        openaiApiKey: "OPENAI",
        falApiKey: null,
        url: pathToFileURL(filePath).href,
        mediaKind: "video",
        onProgress: (event) => events.push(event.kind),
      });

      expect(result.text).toBe("Local transcript");
      expect(result.provider).toBe("openai");
      expect(events).not.toContain("transcript-media-download-start");
      expect(spawnMock).not.toHaveBeenCalledWith(
        "/usr/bin/yt-dlp",
        expect.anything(),
        expect.anything(),
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("transcribes local yt-dlp media through Deepgram with timestamp segments", async () => {
    const root = await mkdtemp(join(tmpdir(), "summarize-ytdlp-deepgram-"));
    const filePath = join(root, "local-audio.mp3");
    await writeFile(filePath, new Uint8Array([1, 2, 3]));
    (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mockImplementation(
      (input: RequestInfo | URL) => {
        expect(new URL(input.toString()).hostname).toBe("api.deepgram.com");
        return Response.json({
          results: {
            channels: [{ alternatives: [{ transcript: "Deepgram local transcript" }] }],
            utterances: [{ start: 0.25, end: 1.5, transcript: "Deepgram local transcript" }],
          },
        });
      },
    );

    try {
      const result = await fetchTranscriptWithYtDlp({
        ytDlpPath: null,
        deepgramApiKey: "DG",
        url: pathToFileURL(filePath).href,
        mediaKind: "audio",
      });

      expect(result.text).toBe("Deepgram local transcript");
      expect(result.provider).toBe("deepgram");
      expect(result.segments).toEqual([
        { startMs: 250, endMs: 1500, text: "Deepgram local transcript" },
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("diarizes local MP3 files without a yt-dlp path", async () => {
    const root = await mkdtemp(join(tmpdir(), "summarize-ytdlp-local-diarize-"));
    const filePath = join(root, "interview.mp3");
    await writeFile(filePath, new Uint8Array([1, 2, 3]));
    (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(
      new Response(
        JSON.stringify({
          segments: [
            { start: 0, end: 1, speaker: "A", text: "Hello." },
            { start: 1, end: 2, speaker: "B", text: "Hi." },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );

    try {
      const result = await fetchTranscriptWithYtDlp({
        ytDlpPath: null,
        openaiApiKey: "OPENAI",
        diarization: "openai",
        url: pathToFileURL(filePath).href,
        mediaKind: "audio",
      });

      expect(result.text).toBe("Speaker A: Hello.\nSpeaker B: Hi.");
      expect(result.provider).toBe("openai");
      expect(result.segments).toEqual([
        { startMs: 0, endMs: 1000, speaker: "Speaker A", text: "Hello." },
        { startMs: 1000, endMs: 2000, speaker: "Speaker B", text: "Hi." },
      ]);
      expect(spawnMock).not.toHaveBeenCalledWith(
        expect.stringContaining("yt-dlp"),
        expect.anything(),
        expect.anything(),
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("returns a helpful error when yt-dlp path is missing", async () => {
    const result = await fetchTranscriptWithYtDlp({
      ytDlpPath: null,
      groqApiKey: null,
      openaiApiKey: "OPENAI",
      falApiKey: null,
      url: "https://youtu.be/dQw4w9WgXcQ",
    });

    expect(result.text).toBeNull();
    expect(result.error?.message).toMatch(/YT_DLP_PATH/);
  });

  it("returns a helpful error when transcription keys are missing", async () => {
    const result = await fetchTranscriptWithYtDlp({
      ytDlpPath: "/usr/bin/yt-dlp",
      groqApiKey: null,
      openaiApiKey: null,
      falApiKey: null,
      url: "https://youtu.be/dQw4w9WgXcQ",
    });

    expect(result.text).toBeNull();
    expect(result.error?.message).toMatch(
      /GROQ_API_KEY, ASSEMBLYAI_API_KEY, GEMINI_API_KEY, OPENAI_API_KEY, FAL_KEY, or DEEPGRAM_API_KEY/,
    );
  });

  it("returns a helpful error when yt-dlp fails to download", async () => {
    spawnMock.mockImplementation(() => {
      const proc = new EventEmitter() as unknown as {
        stderr?: PassThrough;
        kill?: (signal?: string) => void;
        on: (event: string, listener: (...args: unknown[]) => void) => void;
        emit: (event: string, ...args: unknown[]) => void;
      };
      const stderr = new PassThrough();
      stderr.write("download failed");
      proc.stderr = stderr;
      proc.kill = vi.fn();
      process.nextTick(() => proc.emit("close", 1, null));
      return proc;
    });

    const result = await fetchTranscriptWithYtDlp({
      ytDlpPath: "/usr/bin/yt-dlp",
      groqApiKey: null,
      openaiApiKey: "OPENAI",
      falApiKey: null,
      url: "https://youtu.be/dQw4w9WgXcQ",
    });

    expect(result.text).toBeNull();
    expect(result.error?.message).toMatch(/yt-dlp exited with code 1/);
  });

  it("returns empty text and a note when yt-dlp fails with 'unable to obtain file audio codec'", async () => {
    spawnMock.mockImplementation(() => {
      const proc = new EventEmitter() as any;
      proc.stdout = new PassThrough();
      proc.stderr = new PassThrough();
      process.nextTick(() => {
        proc.stderr.write(
          "ERROR: Postprocessing: WARNING: unable to obtain file audio codec with ffprobe\n",
        );
        proc.stderr.end();
        process.nextTick(() => proc.emit("close", 1, null));
      });
      return proc;
    });

    const result = await fetchTranscriptWithYtDlp({
      ytDlpPath: "/usr/bin/yt-dlp",
      openaiApiKey: "OPENAI",
      url: "https://youtu.be/dQw4w9WgXcQ",
    });

    expect(result.text).toBe("");
    expect(result.error).toBeNull();
    expect(result.notes).toContain("yt-dlp: Media has no audio stream");
  });

  it("passes --no-playlist to yt-dlp", async () => {
    mockSpawnSuccess();
    (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(
      new Response(JSON.stringify({ text: "OpenAI transcript" }), { status: 200 }),
    );

    await fetchTranscriptWithYtDlp({
      ytDlpPath: "/usr/bin/yt-dlp",
      groqApiKey: null,
      openaiApiKey: "OPENAI",
      falApiKey: null,
      url: "https://youtu.be/dQw4w9WgXcQ",
    });

    const args = spawnMock.mock.calls[0]?.[1] ?? [];
    expect(args).toContain("--no-playlist");
  });

  it("uses audio-only extraction unless a shared slide video is requested", () => {
    const audioArgs = buildYtDlpDownloadArgs({
      url: "https://youtu.be/dQw4w9WgXcQ",
      output: "/tmp/audio.mp3",
      format: "bestaudio",
      extractAudio: true,
      progress: false,
    });
    const sharedArgs = buildYtDlpDownloadArgs({
      url: "https://youtu.be/dQw4w9WgXcQ",
      output: "/tmp/media.%(vcodec)s.%(acodec)s.%(ext)s",
      format: "bestvideo,bestaudio",
      extractAudio: false,
      progress: false,
    });

    expect(audioArgs).toEqual(
      expect.arrayContaining(["-f", "bestaudio", "-x", "--audio-format", "mp3"]),
    );
    expect(sharedArgs).toEqual(expect.arrayContaining(["-f", "bestvideo,bestaudio"]));
    expect(sharedArgs).not.toContain("-x");
    expect(sharedArgs).not.toContain("--audio-format");
  });

  it("downloads audio when the shared slide cache contains video only", async () => {
    const mediaCache = {
      get: vi.fn(async ({ url }: { url: string }) =>
        url.endsWith("#summarize-slides")
          ? {
              url,
              filePath: "/tmp/cached-video.mp4",
              sizeBytes: 1024,
              sha256: null,
              mediaType: "video/mp4",
              filename: "video.mp4",
              createdAtMs: 1,
              lastAccessAtMs: 1,
              expiresAtMs: null,
            }
          : null,
      ),
      put: vi.fn(),
    };
    (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(
      new Response(
        JSON.stringify({
          segments: [{ start: 0, end: 1, speaker: "A", text: "Cached." }],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );

    const result = await fetchTranscriptWithYtDlp({
      ytDlpPath: "/usr/bin/yt-dlp",
      openaiApiKey: "OPENAI",
      diarization: "openai",
      downloadVideo: true,
      mediaCache,
      url: "https://youtu.be/dQw4w9WgXcQ",
    });

    expect(result.text).toBe("Speaker A: Cached.");
    expect(result.notes).toContain("shared slide video cache hit");
    expect(mediaCache.get).toHaveBeenCalledWith({
      url: "https://youtu.be/dQw4w9WgXcQ",
    });
    expect(mediaCache.get).toHaveBeenCalledWith({
      url: "https://youtu.be/dQw4w9WgXcQ#summarize-slides",
    });
    const args = spawnMock.mock.calls.find(([command]) => command === "/usr/bin/yt-dlp")?.[1] ?? [];
    expect(args).toEqual(
      expect.arrayContaining([
        "-f",
        expect.stringContaining("bestaudio"),
        "-x",
        "--audio-format",
        "mp3",
      ]),
    );
    expect(args).not.toContain(
      "bestvideo[height<=720][vcodec^=avc1][ext=mp4]/bestvideo[height<=720][ext=mp4]/bestvideo[height<=720],bestaudio[vcodec=none]",
    );
  });

  it("restricts transcription downloads to audio-capable formats", async () => {
    (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(
      new Response(JSON.stringify({ text: "OpenAI transcript" }), { status: 200 }),
    );

    await fetchTranscriptWithYtDlp({
      ytDlpPath: "/usr/bin/yt-dlp",
      openaiApiKey: "OPENAI",
      url: "https://www.loom.com/share/ef3224a48a084371bd6d766ee81f083f",
      service: "generic",
      mediaKind: "video",
    });

    const args = spawnMock.mock.calls.find(([command]) => command === "/usr/bin/yt-dlp")?.[1] ?? [];
    const formatIndex = args.indexOf("-f");
    const formats = String(args[formatIndex + 1] ?? "").split("/");
    expect(args).toEqual(expect.arrayContaining(["-x", "--audio-format", "mp3"]));
    expect(formats[0]).toBe("bestaudio[vcodec=none]");
    expect(formats.slice(1).every((format) => format.includes("[acodec!=none]"))).toBe(true);
    expect(formats).not.toContain("best");
  });

  it("emits download progress events from yt-dlp output", async () => {
    spawnMock.mockImplementation(() => {
      const proc = new EventEmitter() as unknown as {
        stdout?: PassThrough;
        stderr?: PassThrough;
        kill?: (signal?: string) => void;
        on: (event: string, listener: (...args: unknown[]) => void) => void;
        emit: (event: string, ...args: unknown[]) => void;
      };
      proc.stdout = new PassThrough();
      proc.stderr = new PassThrough();
      proc.kill = vi.fn();
      process.nextTick(() => {
        proc.stdout?.write("progress:1024|7000|0\n");
        proc.stdout?.write("progress:2048|6500|0\n");
        proc.stdout?.write("progress:3072||6400\n");
        proc.stdout?.end();
        proc.emit("close", 0, null);
      });
      return proc;
    });
    (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(
      new Response(JSON.stringify({ text: "OpenAI transcript" }), { status: 200 }),
    );

    const events: Array<{
      kind: string;
      downloadedBytes?: number;
      totalBytes?: number | null;
    }> = [];
    await fetchTranscriptWithYtDlp({
      ytDlpPath: "/usr/bin/yt-dlp",
      groqApiKey: null,
      openaiApiKey: "OPENAI",
      falApiKey: null,
      url: "https://youtu.be/dQw4w9WgXcQ",
      onProgress: (event) => events.push(event as { kind: string }),
    });

    const progress = events.filter((event) => event.kind === "transcript-media-download-progress");
    expect(progress.length).toBeGreaterThan(0);
    expect(progress[0]?.downloadedBytes).toBe(1024);
    expect(progress[0]?.totalBytes).toBe(7000);
    expect(
      progress.some((event) => event.downloadedBytes === 2048 && event.totalBytes === 7000),
    ).toBe(true);
    expect(
      progress.some((event) => event.downloadedBytes === 3072 && event.totalBytes === 7000),
    ).toBe(true);
  });

  it("uses OpenAI when available", async () => {
    mockSpawnSuccess();
    (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(
      new Response(JSON.stringify({ text: "OpenAI transcript" }), { status: 200 }),
    );

    const result = await fetchTranscriptWithYtDlp({
      ytDlpPath: "/usr/bin/yt-dlp",
      groqApiKey: null,
      openaiApiKey: "OPENAI",
      falApiKey: "FAL",
      url: "https://youtu.be/dQw4w9WgXcQ",
    });

    expect(result.text).toBe("OpenAI transcript");
    expect(result.provider).toBe("openai");
    expect(result.error).toBeNull();
    expect(falMock.createFalClient).not.toHaveBeenCalled();
  });

  it("uses AssemblyAI when it is the only remote provider", async () => {
    mockSpawnSuccess();
    let polls = 0;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.endsWith("/upload")) {
        return new Response(JSON.stringify({ upload_url: "https://upload.example/audio" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (url.endsWith("/transcript")) {
        return new Response(JSON.stringify({ id: "tr_assembly", status: "queued" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (url.endsWith("/transcript/tr_assembly")) {
        polls += 1;
        return new Response(
          JSON.stringify(
            polls === 1
              ? { id: "tr_assembly", status: "processing" }
              : { id: "tr_assembly", status: "completed", text: "Assembly transcript" },
          ),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        );
      }
      throw new Error(`Unexpected fetch call: ${url}`);
    }) as typeof fetch;

    const result = await fetchTranscriptWithYtDlp({
      ytDlpPath: "/usr/bin/yt-dlp",
      groqApiKey: null,
      assemblyaiApiKey: "AAI",
      openaiApiKey: null,
      falApiKey: null,
      url: "https://youtu.be/dQw4w9WgXcQ",
    });

    expect(result.text).toBe("Assembly transcript");
    expect(result.provider).toBe("assemblyai");
    expect(result.error).toBeNull();
  });

  it("falls back to FAL when OpenAI fails", async () => {
    mockSpawnSuccess();
    (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(
      new Response(JSON.stringify({ text: "" }), { status: 200 }),
    );
    falMock.createFalClient.mockReturnValue({
      storage: { upload: vi.fn().mockResolvedValue("https://fal.ai/audio") },
      subscribe: vi.fn().mockResolvedValue({
        data: { chunks: [{ text: "Fal" }, { text: "transcript" }] },
      }),
    });

    const result = await fetchTranscriptWithYtDlp({
      ytDlpPath: "/usr/bin/yt-dlp",
      groqApiKey: null,
      openaiApiKey: "OPENAI",
      falApiKey: "FAL",
      url: "https://youtu.be/dQw4w9WgXcQ",
    });

    expect(result.text).toBe("Fal transcript");
    expect(result.provider).toBe("fal");
    expect(result.notes.join(" ")).toMatch(/falling back to FAL/i);
  });

  it("returns OpenAI error when OpenAI fails and no FAL key is present", async () => {
    mockSpawnSuccess();
    (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(
      new Response("fail", { status: 500 }),
    );

    const result = await fetchTranscriptWithYtDlp({
      ytDlpPath: "/usr/bin/yt-dlp",
      groqApiKey: null,
      openaiApiKey: "OPENAI",
      falApiKey: null,
      url: "https://youtu.be/dQw4w9WgXcQ",
    });

    expect(result.text).toBeNull();
    expect(result.provider).toBe("openai");
    expect(result.error?.message).toMatch(/OpenAI transcription failed/);
  });

  it("returns an error when FAL returns empty text", async () => {
    mockSpawnSuccess();
    falMock.createFalClient.mockReturnValue({
      storage: { upload: vi.fn().mockResolvedValue("https://fal.ai/audio") },
      subscribe: vi.fn().mockResolvedValue({ data: { text: "" } }),
    });

    const result = await fetchTranscriptWithYtDlp({
      ytDlpPath: "/usr/bin/yt-dlp",
      groqApiKey: null,
      openaiApiKey: null,
      falApiKey: "FAL",
      url: "https://youtu.be/dQw4w9WgXcQ",
    });

    expect(result.text).toBeNull();
    expect(result.provider).toBe("fal");
    expect(result.error?.message).toMatch(/FAL transcription returned empty text/);
  });
});
