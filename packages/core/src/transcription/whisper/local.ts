import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { transcribeWithOnnxCli, transcribeWithOnnxCliFile } from "../onnx-cli.js";
import { resolveOnnxModelPreference } from "./preferences.js";
import { emitInitialProgress, type TranscriptionRun } from "./request.js";
import type { WhisperTranscriptionResult } from "./types.js";
import { ensureWhisperFilenameExtension, wrapError } from "./utils.js";
import { isWhisperCppReady, transcribeWithWhisperCppFile } from "./whisper-cpp.js";

export async function transcribeWithLocalOnnx(
  run: TranscriptionRun,
): Promise<WhisperTranscriptionResult | null> {
  const { source, options, notes } = run;
  const model = resolveOnnxModelPreference(options.env);
  if (!model) return null;
  const request = {
    model,
    mediaType: source.mediaType,
    totalDurationSeconds: options.totalDurationSeconds,
    onProgress: options.onProgress,
    env: options.env,
  };
  if (source.kind === "file") emitInitialProgress(run);
  const result =
    source.kind === "bytes"
      ? await transcribeWithOnnxCli({ ...request, bytes: source.bytes, filename: source.filename })
      : await transcribeWithOnnxCliFile({ ...request, filePath: source.filePath });
  notes.push(...result.notes);
  if (result.text) return { ...result, notes };
  if (result.error)
    notes.push(
      `${result.provider ?? "onnx"} failed; falling back to Whisper: ${result.error.message}`,
    );
  return null;
}

export async function transcribeWithLocalWhisper(
  run: TranscriptionRun,
): Promise<WhisperTranscriptionResult | null> {
  const { source, options, notes } = run;
  if (!(await isWhisperCppReady(options.env))) return null;
  if (source.kind === "file") emitInitialProgress(run);
  const tempFile =
    source.kind === "bytes"
      ? join(
          tmpdir(),
          `summarize-whisper-local-${randomUUID()}-${ensureWhisperFilenameExtension(source.filename?.trim() ? basename(source.filename.trim()) : "media", source.mediaType)}`,
        )
      : null;
  try {
    if (tempFile && source.kind === "bytes") await fs.writeFile(tempFile, source.bytes);
    let result: WhisperTranscriptionResult;
    try {
      result = await transcribeWithWhisperCppFile({
        filePath: source.kind === "file" ? source.filePath : tempFile!,
        mediaType: source.mediaType,
        totalDurationSeconds: options.totalDurationSeconds,
        onProgress: options.onProgress,
        env: options.env,
      });
    } catch (error) {
      result = {
        text: null,
        provider: "whisper.cpp",
        error: wrapError("whisper.cpp failed", error),
        notes: [],
      };
    }
    notes.push(...result.notes);
    if (result.text) return { ...result, notes };
    if (result.error)
      notes.push(`whisper.cpp failed; falling back to remote Whisper: ${result.error.message}`);
    return null;
  } finally {
    if (tempFile) await fs.unlink(tempFile).catch(() => {});
  }
}
