import { access, mkdtemp, open, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { MAX_OPENAI_UPLOAD_BYTES } from "../packages/core/src/transcription/whisper/constants.js";
import {
  buildDiarizationModelChain,
  resolveDiarizationProviderOrder,
  transcribeMediaFileWithDiarization,
} from "../packages/core/src/transcription/whisper/diarization.js";
import {
  parseElevenLabsDiarizedSegments,
  transcribeFileWithElevenLabsDiarization,
} from "../packages/core/src/transcription/whisper/elevenlabs.js";
import {
  parseOpenAiDiarizedSegments,
  transcribeFileWithOpenAiDiarization,
} from "../packages/core/src/transcription/whisper/openai.js";

const ffmpegMocks = vi.hoisted(() => ({
  isFfmpegAvailable: vi.fn(async () => true),
  runFfmpegTranscodeToMp3: vi.fn(),
}));

vi.mock("../packages/core/src/transcription/whisper/ffmpeg.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../packages/core/src/transcription/whisper/ffmpeg.js")>();
  return { ...actual, ...ffmpegMocks };
});

describe("transcription diarization", () => {
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
        totalDurationSeconds: null,
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
