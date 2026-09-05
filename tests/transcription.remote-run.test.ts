import { beforeEach, describe, expect, it, vi } from "vitest";
import { MAX_OPENAI_UPLOAD_BYTES } from "../packages/core/src/transcription/whisper/constants.js";
import { transcribeWithDecodeRetry } from "../packages/core/src/transcription/whisper/decode-retry.js";
import { transcribeWithRemoteFallbacks } from "../packages/core/src/transcription/whisper/remote.js";
import {
  createTranscriptionRun,
  type TranscriptionOptions,
} from "../packages/core/src/transcription/whisper/request.js";

const mocks = vi.hoisted(() => ({
  stat: vi.fn(),
  readFile: vi.fn(),
  ffmpeg: vi.fn(),
  transcode: vi.fn(),
  assemblyFile: vi.fn(),
  assemblyBytes: vi.fn(),
  geminiFile: vi.fn(),
  geminiBytes: vi.fn(),
  deepgramFile: vi.fn(),
  deepgramBytes: vi.fn(),
  openai: vi.fn(),
  fal: vi.fn(),
}));
vi.mock("node:fs", async (original) => {
  const actual = await original<typeof import("node:fs")>();
  return {
    ...actual,
    promises: { ...actual.promises, stat: mocks.stat, readFile: mocks.readFile },
  };
});
vi.mock("../packages/core/src/transcription/whisper/assemblyai.js", () => ({
  ASSEMBLYAI_TRANSCRIPTION_MODEL_ID: "assemblyai/test",
  transcribeFileWithAssemblyAi: mocks.assemblyFile,
  transcribeWithAssemblyAi: mocks.assemblyBytes,
}));
vi.mock("../packages/core/src/transcription/whisper/gemini.js", () => ({
  transcribeFileWithGemini: mocks.geminiFile,
  transcribeWithGemini: mocks.geminiBytes,
}));
vi.mock("../packages/core/src/transcription/whisper/deepgram.js", () => ({
  transcribeFileWithDeepgram: mocks.deepgramFile,
  transcribeWithDeepgram: mocks.deepgramBytes,
}));
vi.mock("../packages/core/src/transcription/whisper/openai.js", () => ({
  transcribeWithOpenAi: mocks.openai,
  shouldRetryOpenAiViaFfmpeg: () => false,
}));
vi.mock("../packages/core/src/transcription/whisper/fal.js", () => ({
  transcribeWithFal: mocks.fal,
}));
vi.mock("../packages/core/src/transcription/whisper/ffmpeg.js", () => ({
  isFfmpegAvailable: mocks.ffmpeg,
  transcodeBytesToMp3: mocks.transcode,
}));

const chunking = { file: vi.fn(), bytes: vi.fn() };
const segments = [{ startMs: 0, endMs: 100, text: "transcript" }];
const createRun = (options: Partial<TranscriptionOptions> = {}) =>
  createTranscriptionRun(
    { kind: "file", filePath: "/media.mp3", mediaType: "audio/mpeg", filename: "media.mp3" },
    { groqApiKey: null, openaiApiKey: null, falApiKey: null, env: {}, ...options },
  );

beforeEach(() => {
  vi.resetAllMocks();
  mocks.stat.mockResolvedValue({ size: 3 });
  mocks.readFile.mockResolvedValue(new Uint8Array([1, 2, 3]));
  mocks.ffmpeg.mockResolvedValue(false);
});

describe("source-aware remote transcription", () => {
  it.each([false, true])(
    "keeps native-file fallback lazy and preserves the final result (failure=%s)",
    async (fail) => {
      const failure = new Error("Deepgram unavailable");
      mocks.assemblyFile.mockRejectedValue(new Error("AssemblyAI unavailable"));
      mocks.geminiFile.mockRejectedValue(new Error("Gemini unavailable"));
      if (fail) mocks.deepgramFile.mockRejectedValue(failure);
      else mocks.deepgramFile.mockResolvedValue({ text: "transcript", segments });
      const run = createRun({
        assemblyaiApiKey: "assembly",
        geminiApiKey: "gemini",
        deepgramApiKey: "deepgram",
      });
      const result = await transcribeWithRemoteFallbacks(run, chunking);
      expect(result.provider).toBe("deepgram");
      if (fail) expect(result.error).toBe(failure);
      else expect(result.segments).toBe(segments);
      expect(mocks.readFile).not.toHaveBeenCalled();
      expect(mocks.assemblyBytes).not.toHaveBeenCalled();
      expect(mocks.geminiBytes).not.toHaveBeenCalled();
      expect(mocks.deepgramBytes).not.toHaveBeenCalled();
    },
  );

  it("converts a file once before byte-only providers and keeps its full fallback payload", async () => {
    mocks.assemblyFile.mockRejectedValue(new Error("unavailable"));
    mocks.openai.mockRejectedValue(new Error("unavailable"));
    mocks.deepgramBytes.mockResolvedValue({ text: "transcript", segments });
    const run = createRun({
      assemblyaiApiKey: "assembly",
      openaiApiKey: "openai",
      falApiKey: "fal",
      deepgramApiKey: "deepgram",
    });
    run.source.mediaType = "video/mp4";
    const result = await transcribeWithRemoteFallbacks(run, chunking);
    expect(result).toMatchObject({ text: "transcript", provider: "deepgram", segments });
    expect(mocks.readFile).toHaveBeenCalledExactlyOnceWith("/media.mp3");
    expect(mocks.deepgramBytes).toHaveBeenCalledWith(
      new Uint8Array([1, 2, 3]),
      "video/mp4",
      "deepgram",
      { env: {} },
    );
    expect(mocks.deepgramFile).not.toHaveBeenCalled();
    expect(mocks.fal).not.toHaveBeenCalled();
    expect(run.notes.join(" ")).toContain("Skipping FAL transcription");
  });

  it("treats a failed chunk result as terminal instead of retrying another provider", async () => {
    mocks.ffmpeg.mockResolvedValue(true);
    const failure = new Error("chunk failed");
    const result = { text: null, provider: "openai", error: failure, notes: ["chunk note"] };
    chunking.bytes.mockResolvedValue(result);
    const run = createRun({ openaiApiKey: "openai", deepgramApiKey: "deepgram" });
    run.source = {
      kind: "bytes",
      bytes: new Uint8Array(MAX_OPENAI_UPLOAD_BYTES + 1),
      mediaType: "audio/mpeg",
      filename: null,
    };
    run.notes.push("earlier note");
    await expect(transcribeWithRemoteFallbacks(run, chunking)).resolves.toEqual({
      ...result,
      notes: ["earlier note", "chunk note"],
    });
    expect(mocks.openai).not.toHaveBeenCalled();
    expect(mocks.deepgramBytes).not.toHaveBeenCalled();
  });
});

describe.each(["groq", "openai"] as const)("%s decode retry source ownership", (provider) => {
  it.each([false, true])(
    "adopts an empty retry conversion but preserves input after a thrown retry (throws=%s)",
    async (throws) => {
      mocks.ffmpeg.mockResolvedValue(true);
      const converted = new Uint8Array([9]);
      mocks.transcode.mockResolvedValue(converted);
      const transcribe = vi.fn().mockRejectedValueOnce(new Error("decode failure"));
      if (throws) transcribe.mockRejectedValueOnce(new Error("retry unavailable"));
      else transcribe.mockResolvedValueOnce(null);
      const source = {
        kind: "bytes" as const,
        bytes: new Uint8Array([1]),
        mediaType: "video/mp4",
        filename: "video.mp4",
      };
      const notes: string[] = [];
      const attempt = await transcribeWithDecodeRetry({
        source,
        provider,
        notes,
        transcribe,
        shouldRetry: () => true,
      });
      expect(attempt.kind).toBe("error");
      if (throws) {
        expect(attempt.source).toBe(source);
        expect(notes.join(" ")).toContain("retry unavailable");
      } else {
        expect(attempt.source).toMatchObject({
          bytes: converted,
          mediaType: "audio/mpeg",
          filename: "audio.mp3",
        });
      }
    },
  );
});
