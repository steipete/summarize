import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { transcribeWithOnnxCli, transcribeWithOnnxCliFile } from "../onnx-cli.js";
import { resolveOnnxModelPreference } from "./preferences.js";
import type { WhisperProgressEvent, WhisperTranscriptionResult } from "./types.js";
import { ensureWhisperFilenameExtension, wrapError } from "./utils.js";
import { isWhisperCppReady, transcribeWithWhisperCppFile } from "./whisper-cpp.js";

type Env = Record<string, string | undefined>;

export async function transcribeWithLocalOnnx({
  bytes,
  mediaType,
  filename,
  totalDurationSeconds,
  onProgress,
  env,
  notes,
}: {
  bytes: Uint8Array;
  mediaType: string;
  filename: string | null;
  totalDurationSeconds: number | null;
  onProgress?: ((event: WhisperProgressEvent) => void) | null;
  env: Env;
  notes: string[];
}): Promise<WhisperTranscriptionResult | null> {
  const onnxPreference = resolveOnnxModelPreference(env);
  if (!onnxPreference) return null;
  const onnx = await transcribeWithOnnxCli({
    model: onnxPreference,
    bytes,
    mediaType,
    filename,
    totalDurationSeconds,
    onProgress,
    env,
  });
  if (onnx.text) {
    if (onnx.notes.length > 0) notes.push(...onnx.notes);
    return { ...onnx, notes };
  }
  if (onnx.notes.length > 0) notes.push(...onnx.notes);
  if (onnx.error) {
    notes.push(`${onnx.provider ?? "onnx"} failed; falling back to Whisper: ${onnx.error.message}`);
  }
  return null;
}

export async function transcribeWithLocalOnnxFile({
  filePath,
  mediaType,
  totalDurationSeconds,
  onProgress,
  env,
  notes,
}: {
  filePath: string;
  mediaType: string;
  totalDurationSeconds: number | null;
  onProgress?: ((event: WhisperProgressEvent) => void) | null;
  env: Env;
  notes: string[];
}): Promise<WhisperTranscriptionResult | null> {
  const onnxPreference = resolveOnnxModelPreference(env);
  if (!onnxPreference) return null;
  onProgress?.({
    partIndex: null,
    parts: null,
    processedDurationSeconds: null,
    totalDurationSeconds,
  });
  const onnx = await transcribeWithOnnxCliFile({
    model: onnxPreference,
    filePath,
    mediaType,
    totalDurationSeconds,
    onProgress,
    env,
  });
  if (onnx.text) {
    if (onnx.notes.length > 0) notes.push(...onnx.notes);
    return { ...onnx, notes };
  }
  if (onnx.notes.length > 0) notes.push(...onnx.notes);
  if (onnx.error) {
    notes.push(`${onnx.provider ?? "onnx"} failed; falling back to Whisper: ${onnx.error.message}`);
  }
  return null;
}

export async function transcribeWithLocalWhisperBytes({
  bytes,
  mediaType,
  filename,
  totalDurationSeconds,
  onProgress,
  env,
  notes,
}: {
  bytes: Uint8Array;
  mediaType: string;
  filename: string | null;
  totalDurationSeconds: number | null;
  onProgress?: ((event: WhisperProgressEvent) => void) | null;
  env: Env;
  notes: string[];
}): Promise<WhisperTranscriptionResult | null> {
  if (!(await isWhisperCppReady(env))) return null;
  const nameHint = filename?.trim() ? basename(filename.trim()) : "media";
  const tempFile = join(
    tmpdir(),
    `summarize-whisper-local-${randomUUID()}-${ensureWhisperFilenameExtension(nameHint, mediaType)}`,
  );
  try {
    await fs.writeFile(tempFile, bytes);
    const result = await safeTranscribeWithWhisperCppFile({
      filePath: tempFile,
      mediaType,
      totalDurationSeconds,
      onProgress,
      env,
    });
    return mergeLocalWhisperResult(result, notes);
  } finally {
    await fs.unlink(tempFile).catch(() => {});
  }
}

export async function transcribeWithLocalWhisperFile({
  filePath,
  mediaType,
  totalDurationSeconds,
  onProgress,
  env,
  notes,
}: {
  filePath: string;
  mediaType: string;
  totalDurationSeconds: number | null;
  onProgress?: ((event: WhisperProgressEvent) => void) | null;
  env: Env;
  notes: string[];
}): Promise<WhisperTranscriptionResult | null> {
  if (!(await isWhisperCppReady(env))) return null;
  onProgress?.({
    partIndex: null,
    parts: null,
    processedDurationSeconds: null,
    totalDurationSeconds,
  });
  const result = await safeTranscribeWithWhisperCppFile({
    filePath,
    mediaType,
    totalDurationSeconds,
    onProgress,
    env,
  });
  return mergeLocalWhisperResult(result, notes);
}

function mergeLocalWhisperResult(
  result: WhisperTranscriptionResult,
  notes: string[],
): WhisperTranscriptionResult | null {
  if (result.notes.length > 0) notes.push(...result.notes);
  if (result.text) return { ...result, notes };
  if (result.error) {
    notes.push(`whisper.cpp failed; falling back to remote Whisper: ${result.error.message}`);
  }
  return null;
}

async function safeTranscribeWithWhisperCppFile(args: {
  filePath: string;
  mediaType: string;
  totalDurationSeconds: number | null;
  onProgress?: ((event: WhisperProgressEvent) => void) | null;
  env: Env;
}): Promise<WhisperTranscriptionResult> {
  try {
    return await transcribeWithWhisperCppFile(args);
  } catch (error) {
    return {
      text: null,
      provider: "whisper.cpp",
      error: wrapError("whisper.cpp failed", error),
      notes: [],
    };
  }
}
