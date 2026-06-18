import { access } from "node:fs/promises";
import { beforeEach, describe, expect, it, vi } from "vitest";

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

import {
  transcribeWithLocalOnnx,
  transcribeWithLocalOnnxFile,
  transcribeWithLocalWhisperBytes,
  transcribeWithLocalWhisperFile,
} from "../packages/core/src/transcription/whisper/local.js";

describe("local Whisper adapters", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.resolveOnnxModelPreference.mockReturnValue(null);
    mocks.isWhisperCppReady.mockResolvedValue(false);
  });

  it("skips unconfigured ONNX byte and file adapters", async () => {
    const notes: string[] = [];
    await expect(
      transcribeWithLocalOnnx({
        bytes: new Uint8Array([1]),
        mediaType: "audio/mpeg",
        filename: "audio.mp3",
        totalDurationSeconds: null,
        env: {},
        notes,
      }),
    ).resolves.toBeNull();
    await expect(
      transcribeWithLocalOnnxFile({
        filePath: "/unused/audio.mp3",
        mediaType: "audio/mpeg",
        totalDurationSeconds: null,
        env: {},
        notes,
      }),
    ).resolves.toBeNull();
  });

  it("merges ONNX success notes for byte and file inputs", async () => {
    mocks.resolveOnnxModelPreference.mockReturnValue("parakeet");
    mocks.transcribeWithOnnxCli.mockResolvedValue({
      text: "bytes result",
      provider: "onnx-parakeet",
      error: null,
      notes: ["bytes note"],
    });
    mocks.transcribeWithOnnxCliFile.mockResolvedValue({
      text: "file result",
      provider: "onnx-parakeet",
      error: null,
      notes: ["file note"],
    });
    const notes: string[] = [];
    const progress = vi.fn();

    await expect(
      transcribeWithLocalOnnx({
        bytes: new Uint8Array([1]),
        mediaType: "audio/mpeg",
        filename: "audio.mp3",
        totalDurationSeconds: 4,
        env: {},
        notes,
      }),
    ).resolves.toMatchObject({ text: "bytes result", notes: ["bytes note"] });
    await expect(
      transcribeWithLocalOnnxFile({
        filePath: "/unused/audio.mp3",
        mediaType: "audio/mpeg",
        totalDurationSeconds: 4,
        onProgress: progress,
        env: {},
        notes,
      }),
    ).resolves.toMatchObject({ text: "file result", notes: ["bytes note", "file note"] });
    expect(progress).toHaveBeenCalledWith({
      partIndex: null,
      parts: null,
      processedDurationSeconds: null,
      totalDurationSeconds: 4,
    });
  });

  it("records ONNX failures and allows provider fallback", async () => {
    mocks.resolveOnnxModelPreference.mockReturnValue("canary");
    mocks.transcribeWithOnnxCli.mockResolvedValue({
      text: null,
      provider: null,
      error: new Error("bytes failed"),
      notes: ["bytes diagnostic"],
    });
    mocks.transcribeWithOnnxCliFile.mockResolvedValue({
      text: null,
      provider: "onnx-canary",
      error: new Error("file failed"),
      notes: [],
    });
    const notes: string[] = [];

    await transcribeWithLocalOnnx({
      bytes: new Uint8Array([1]),
      mediaType: "audio/mpeg",
      filename: null,
      totalDurationSeconds: null,
      env: {},
      notes,
    });
    await transcribeWithLocalOnnxFile({
      filePath: "/unused/audio.mp3",
      mediaType: "audio/mpeg",
      totalDurationSeconds: null,
      env: {},
      notes,
    });

    expect(notes).toEqual([
      "bytes diagnostic",
      "onnx failed; falling back to Whisper: bytes failed",
      "onnx-canary failed; falling back to Whisper: file failed",
    ]);
  });

  it("passes through empty ONNX results without manufacturing diagnostics", async () => {
    mocks.resolveOnnxModelPreference.mockReturnValue("parakeet");
    const empty = { text: null, provider: "onnx-parakeet", error: null, notes: [] };
    mocks.transcribeWithOnnxCli.mockResolvedValue(empty);
    mocks.transcribeWithOnnxCliFile.mockResolvedValue(empty);
    const notes: string[] = [];

    await expect(
      transcribeWithLocalOnnx({
        bytes: new Uint8Array([1]),
        mediaType: "audio/mpeg",
        filename: null,
        totalDurationSeconds: null,
        env: {},
        notes,
      }),
    ).resolves.toBeNull();
    await expect(
      transcribeWithLocalOnnxFile({
        filePath: "/unused/audio.mp3",
        mediaType: "audio/mpeg",
        totalDurationSeconds: null,
        env: {},
        notes,
      }),
    ).resolves.toBeNull();
    expect(notes).toEqual([]);
  });

  it("skips whisper.cpp when the local engine is unavailable", async () => {
    const notes: string[] = [];
    await expect(
      transcribeWithLocalWhisperBytes({
        bytes: new Uint8Array([1]),
        mediaType: "audio/mpeg",
        filename: null,
        totalDurationSeconds: null,
        env: {},
        notes,
      }),
    ).resolves.toBeNull();
    await expect(
      transcribeWithLocalWhisperFile({
        filePath: "/unused/audio.mp3",
        mediaType: "audio/mpeg",
        totalDurationSeconds: null,
        env: {},
        notes,
      }),
    ).resolves.toBeNull();
  });

  it("transcribes byte input through a cleaned-up whisper.cpp temp file", async () => {
    mocks.isWhisperCppReady.mockResolvedValue(true);
    let tempFile = "";
    mocks.transcribeWithWhisperCppFile.mockImplementation(async ({ filePath }) => {
      tempFile = filePath;
      await expect(access(filePath)).resolves.toBeUndefined();
      return {
        text: "local result",
        provider: "whisper.cpp",
        error: null,
        notes: ["local note"],
      };
    });
    const notes: string[] = [];

    await expect(
      transcribeWithLocalWhisperBytes({
        bytes: new Uint8Array([1, 2, 3]),
        mediaType: "audio/mpeg",
        filename: "audio",
        totalDurationSeconds: 3,
        env: {},
        notes,
      }),
    ).resolves.toMatchObject({ text: "local result", notes: ["local note"] });
    await expect(access(tempFile)).rejects.toMatchObject({ code: "ENOENT" });
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
    const notes: string[] = [];
    const progress = vi.fn();

    await expect(
      transcribeWithLocalWhisperFile({
        filePath: "/unused/one.mp3",
        mediaType: "audio/mpeg",
        totalDurationSeconds: 10,
        onProgress: progress,
        env: {},
        notes,
      }),
    ).resolves.toBeNull();
    await expect(
      transcribeWithLocalWhisperFile({
        filePath: "/unused/two.mp3",
        mediaType: "audio/mpeg",
        totalDurationSeconds: 10,
        env: {},
        notes,
      }),
    ).resolves.toBeNull();

    expect(notes).toEqual([
      "whisper.cpp failed; falling back to remote Whisper: whisper.cpp failed: crashed",
      "engine note",
      "whisper.cpp failed; falling back to remote Whisper: empty",
    ]);
    expect(progress).toHaveBeenCalled();
  });

  it("handles default byte filenames and note-free whisper.cpp results", async () => {
    mocks.isWhisperCppReady.mockResolvedValue(true);
    mocks.transcribeWithWhisperCppFile
      .mockResolvedValueOnce({
        text: null,
        provider: "whisper.cpp",
        error: null,
        notes: [],
      })
      .mockResolvedValueOnce({
        text: "file success",
        provider: "whisper.cpp",
        error: null,
        notes: [],
      });
    const notes: string[] = [];

    await expect(
      transcribeWithLocalWhisperBytes({
        bytes: new Uint8Array([1]),
        mediaType: "audio/mpeg",
        filename: null,
        totalDurationSeconds: null,
        env: {},
        notes,
      }),
    ).resolves.toBeNull();
    await expect(
      transcribeWithLocalWhisperFile({
        filePath: "/unused/audio.mp3",
        mediaType: "audio/mpeg",
        totalDurationSeconds: null,
        env: {},
        notes,
      }),
    ).resolves.toMatchObject({ text: "file success", notes: [] });
  });
});
