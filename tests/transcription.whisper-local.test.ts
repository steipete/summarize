import { access } from "node:fs/promises";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  transcribeWithLocalOnnx,
  transcribeWithLocalWhisper,
} from "../packages/core/src/transcription/whisper/local.js";
import { createTranscriptionRun } from "../packages/core/src/transcription/whisper/request.js";

const mocks = vi.hoisted(() => ({
  resolveOnnxModelPreference: vi.fn(),
  transcribeWithOnnxCli: vi.fn(),
  transcribeWithOnnxCliFile: vi.fn(),
  isWhisperCppReady: vi.fn(),
  transcribeWithWhisperCppFile: vi.fn(),
}));
vi.mock("../packages/core/src/transcription/onnx-cli.js", () => ({
  transcribeWithOnnxCli: mocks.transcribeWithOnnxCli,
  transcribeWithOnnxCliFile: mocks.transcribeWithOnnxCliFile,
}));
vi.mock("../packages/core/src/transcription/whisper/preferences.js", () => ({
  resolveOnnxModelPreference: mocks.resolveOnnxModelPreference,
}));
vi.mock("../packages/core/src/transcription/whisper/whisper-cpp.js", () => ({
  isWhisperCppReady: mocks.isWhisperCppReady,
  transcribeWithWhisperCppFile: mocks.transcribeWithWhisperCppFile,
}));

function createRun(kind: "bytes" | "file", filename: string | null = "audio") {
  return createTranscriptionRun(
    kind === "bytes"
      ? { kind, bytes: new Uint8Array([1, 2, 3]), mediaType: "audio/mpeg", filename }
      : { kind, filePath: "/unused/audio.mp3", mediaType: "audio/mpeg", filename },
    {
      groqApiKey: null,
      openaiApiKey: null,
      falApiKey: null,
      env: {},
      totalDurationSeconds: 4,
      onProgress: vi.fn(),
    },
  );
}

describe.each(["bytes", "file"] as const)("local Whisper adapters (%s)", (kind) => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.resolveOnnxModelPreference.mockReturnValue(null);
    mocks.isWhisperCppReady.mockResolvedValue(false);
  });

  it("skips unconfigured ONNX without emitting progress", async () => {
    const run = createRun(kind);
    await expect(transcribeWithLocalOnnx(run)).resolves.toBeNull();
    expect(run.options.onProgress).not.toHaveBeenCalled();
    expect(mocks.transcribeWithOnnxCli).not.toHaveBeenCalled();
    expect(mocks.transcribeWithOnnxCliFile).not.toHaveBeenCalled();
  });

  it("keeps source dispatch, progress, and accumulated ONNX notes", async () => {
    mocks.resolveOnnxModelPreference.mockReturnValue("parakeet");
    const transcribe =
      kind === "bytes" ? mocks.transcribeWithOnnxCli : mocks.transcribeWithOnnxCliFile;
    transcribe.mockResolvedValue({
      text: "result",
      provider: "onnx-parakeet",
      error: null,
      notes: ["engine note"],
    });
    const run = createRun(kind);
    run.notes.push("earlier");
    const result = await transcribeWithLocalOnnx(run);
    expect(result).toMatchObject({ text: "result", notes: ["earlier", "engine note"] });
    expect(result?.notes).toBe(run.notes);
    expect(transcribe).toHaveBeenCalledOnce();
    if (kind === "file") {
      expect(run.options.onProgress).toHaveBeenCalledExactlyOnceWith({
        partIndex: null,
        parts: null,
        processedDurationSeconds: null,
        totalDurationSeconds: 4,
      });
    } else {
      expect(run.options.onProgress).not.toHaveBeenCalled();
    }
  });

  it("records ONNX failures and allows provider fallback", async () => {
    mocks.resolveOnnxModelPreference.mockReturnValue("canary");
    const transcribe =
      kind === "bytes" ? mocks.transcribeWithOnnxCli : mocks.transcribeWithOnnxCliFile;
    const provider = kind === "file" ? "onnx-canary" : null;
    transcribe.mockResolvedValue({
      text: null,
      provider,
      error: new Error("failed"),
      notes: ["diagnostic"],
    });
    const run = createRun(kind);
    await expect(transcribeWithLocalOnnx(run)).resolves.toBeNull();
    expect(run.notes).toEqual([
      "diagnostic",
      `${provider ?? "onnx"} failed; falling back to Whisper: failed`,
    ]);
  });

  it("passes through empty ONNX results without manufacturing diagnostics", async () => {
    mocks.resolveOnnxModelPreference.mockReturnValue("parakeet");
    const transcribe =
      kind === "bytes" ? mocks.transcribeWithOnnxCli : mocks.transcribeWithOnnxCliFile;
    transcribe.mockResolvedValue({ text: null, provider: "onnx-parakeet", error: null, notes: [] });
    const run = createRun(kind);
    await expect(transcribeWithLocalOnnx(run)).resolves.toBeNull();
    expect(run.notes).toEqual([]);
  });

  it("skips unavailable whisper.cpp without emitting progress", async () => {
    const run = createRun(kind);
    await expect(transcribeWithLocalWhisper(run)).resolves.toBeNull();
    expect(run.options.onProgress).not.toHaveBeenCalled();
    expect(mocks.transcribeWithWhisperCppFile).not.toHaveBeenCalled();
  });

  it("preserves whisper.cpp results and cleans temporary input", async () => {
    mocks.isWhisperCppReady.mockResolvedValue(true);
    let inputPath = "";
    mocks.transcribeWithWhisperCppFile.mockImplementation(async ({ filePath }) => {
      inputPath = filePath;
      if (kind === "bytes") await expect(access(filePath)).resolves.toBeUndefined();
      return { text: "local result", provider: "whisper.cpp", error: null, notes: ["local note"] };
    });
    const run = createRun(kind, "../audio");
    await expect(transcribeWithLocalWhisper(run)).resolves.toMatchObject({
      text: "local result",
      notes: ["local note"],
    });
    if (kind === "bytes") {
      expect(inputPath).toMatch(/-audio\.mp3$/);
      await expect(access(inputPath)).rejects.toMatchObject({ code: "ENOENT" });
      expect(run.options.onProgress).not.toHaveBeenCalled();
    } else {
      expect(inputPath).toBe("/unused/audio.mp3");
      expect(run.options.onProgress).toHaveBeenCalledOnce();
    }
  });

  it("converts thrown and returned whisper.cpp failures into fallback notes", async () => {
    mocks.isWhisperCppReady.mockResolvedValue(true);
    mocks.transcribeWithWhisperCppFile
      .mockRejectedValueOnce(new Error("crashed"))
      .mockResolvedValueOnce({
        text: null,
        provider: "whisper.cpp",
        error: new Error("empty"),
        notes: ["engine note"],
      });
    const run = createRun(kind);
    await expect(transcribeWithLocalWhisper(run)).resolves.toBeNull();
    await expect(transcribeWithLocalWhisper(run)).resolves.toBeNull();
    expect(run.notes).toEqual([
      "whisper.cpp failed; falling back to remote Whisper: whisper.cpp failed: crashed",
      "engine note",
      "whisper.cpp failed; falling back to remote Whisper: empty",
    ]);
  });

  it("handles default filenames and note-free results", async () => {
    mocks.isWhisperCppReady.mockResolvedValue(true);
    mocks.transcribeWithWhisperCppFile
      .mockResolvedValueOnce({ text: null, provider: "whisper.cpp", error: null, notes: [] })
      .mockResolvedValueOnce({ text: "success", provider: "whisper.cpp", error: null, notes: [] });
    const run = createRun(kind, null);
    await expect(transcribeWithLocalWhisper(run)).resolves.toBeNull();
    await expect(transcribeWithLocalWhisper(run)).resolves.toMatchObject({
      text: "success",
      notes: [],
    });
  });
});
