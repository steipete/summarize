import { describe, expect, it, vi } from "vitest";
import { ASSEMBLYAI_TRANSCRIPTION_MODEL_ID } from "../packages/core/src/transcription/whisper/assemblyai.js";

const whisperMock = vi.hoisted(() => ({
  isWhisperCppReady: vi.fn(),
  resolveWhisperCppModelNameForDisplay: vi.fn(),
}));

vi.mock("../packages/core/src/transcription/whisper.js", () => whisperMock);

import { resolveTranscriptionStartInfo } from "../packages/core/src/content/transcript/providers/transcription-start.js";

describe("transcription start helper", () => {
  it("reports unknown when nothing is available", async () => {
    whisperMock.isWhisperCppReady.mockResolvedValue(false);
    whisperMock.resolveWhisperCppModelNameForDisplay.mockResolvedValue(null);

    const startInfo = await resolveTranscriptionStartInfo({
      env: {},
      groqApiKey: null,
      openaiApiKey: null,
      falApiKey: null,
    });

    expect(startInfo.availability.hasAnyProvider).toBe(false);
    expect(startInfo.providerHint).toBe("unknown");
    expect(startInfo.modelId).toBeNull();
  });

  it("prefers ONNX when configured + selected", async () => {
    whisperMock.isWhisperCppReady.mockResolvedValue(false);
    whisperMock.resolveWhisperCppModelNameForDisplay.mockResolvedValue(null);

    const startInfo = await resolveTranscriptionStartInfo({
      env: {
        SUMMARIZE_TRANSCRIBER: "parakeet",
        SUMMARIZE_ONNX_PARAKEET_CMD: "printf 'ok'",
      },
      groqApiKey: null,
      openaiApiKey: null,
      falApiKey: null,
    });

    expect(startInfo.availability.onnxReady).toBe(true);
    expect(startInfo.providerHint).toBe("onnx");
    expect(startInfo.modelId).toBe("onnx/parakeet");
  });

  it("reports openai->fal when both keys present", async () => {
    whisperMock.isWhisperCppReady.mockResolvedValue(false);
    whisperMock.resolveWhisperCppModelNameForDisplay.mockResolvedValue(null);

    const startInfo = await resolveTranscriptionStartInfo({
      env: {},
      groqApiKey: null,
      openaiApiKey: "OPENAI",
      falApiKey: "FAL",
    });

    expect(startInfo.availability.hasAnyProvider).toBe(true);
    expect(startInfo.providerHint).toBe("openai->fal");
    expect(startInfo.modelId).toBe("whisper-1->fal-ai/wizper");
  });

  it("reports Gemini when only a Gemini key is present", async () => {
    whisperMock.isWhisperCppReady.mockResolvedValue(false);
    whisperMock.resolveWhisperCppModelNameForDisplay.mockResolvedValue(null);

    const startInfo = await resolveTranscriptionStartInfo({
      env: {},
      groqApiKey: null,
      geminiApiKey: "GEMINI",
      openaiApiKey: null,
      falApiKey: null,
    });

    expect(startInfo.availability.hasAnyProvider).toBe(true);
    expect(startInfo.availability.hasGemini).toBe(true);
    expect(startInfo.providerHint).toBe("gemini");
    expect(startInfo.modelId).toBe("google/gemini-2.5-flash");
  });

  it("reports AssemblyAI when only an AssemblyAI key is present", async () => {
    whisperMock.isWhisperCppReady.mockResolvedValue(false);
    whisperMock.resolveWhisperCppModelNameForDisplay.mockResolvedValue(null);

    const startInfo = await resolveTranscriptionStartInfo({
      env: {},
      groqApiKey: null,
      assemblyaiApiKey: "AAI",
      openaiApiKey: null,
      falApiKey: null,
    });

    expect(startInfo.availability.hasAnyProvider).toBe(true);
    expect(startInfo.availability.hasAssemblyAi).toBe(true);
    expect(startInfo.providerHint).toBe("assemblyai");
    expect(startInfo.modelId).toBe(ASSEMBLYAI_TRANSCRIPTION_MODEL_ID);
  });

  it("reports groq->assemblyai->gemini->openai when all preferred cloud fallbacks exist", async () => {
    whisperMock.isWhisperCppReady.mockResolvedValue(false);
    whisperMock.resolveWhisperCppModelNameForDisplay.mockResolvedValue(null);

    const startInfo = await resolveTranscriptionStartInfo({
      env: {},
      groqApiKey: "GROQ",
      assemblyaiApiKey: "AAI",
      geminiApiKey: "GEMINI",
      openaiApiKey: "OPENAI",
      falApiKey: null,
    });

    expect(startInfo.providerHint).toBe("groq->assemblyai->gemini->openai");
    expect(startInfo.modelId).toBe(
      `groq/whisper-large-v3-turbo->${ASSEMBLYAI_TRANSCRIPTION_MODEL_ID}->google/gemini-2.5-flash->whisper-1`,
    );
  });

  it("reports cpp when whisper.cpp is ready", async () => {
    whisperMock.isWhisperCppReady.mockResolvedValue(true);
    whisperMock.resolveWhisperCppModelNameForDisplay.mockResolvedValue("tiny.en");

    const startInfo = await resolveTranscriptionStartInfo({
      env: {},
      groqApiKey: null,
      openaiApiKey: null,
      falApiKey: null,
    });

    expect(startInfo.availability.hasAnyProvider).toBe(true);
    expect(startInfo.providerHint).toBe("cpp");
    expect(startInfo.modelId).toBe("tiny.en");
  });

  it("passes resolved transcription env through to whisper.cpp helpers", async () => {
    whisperMock.isWhisperCppReady.mockResolvedValue(true);
    whisperMock.resolveWhisperCppModelNameForDisplay.mockResolvedValue("base");

    const effectiveEnv = {
      SUMMARIZE_WHISPER_CPP_BINARY: "/tmp/custom-whisper-cli",
      SUMMARIZE_WHISPER_CPP_MODEL_PATH: "/tmp/ggml-base.bin",
    };

    const startInfo = await resolveTranscriptionStartInfo({
      env: { SUMMARIZE_WHISPER_CPP_MODEL_PATH: "/tmp/ignored.bin" },
      transcription: { env: effectiveEnv },
      groqApiKey: null,
      openaiApiKey: null,
      falApiKey: null,
    });

    expect(whisperMock.isWhisperCppReady).toHaveBeenCalledWith(effectiveEnv);
    expect(whisperMock.resolveWhisperCppModelNameForDisplay).toHaveBeenCalledWith(effectiveEnv);
    expect(startInfo.modelId).toBe("base");
  });
});
