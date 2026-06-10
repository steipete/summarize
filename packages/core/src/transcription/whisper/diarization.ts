import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MAX_OPENAI_UPLOAD_BYTES } from "./constants.js";
import {
  ELEVENLABS_DIARIZATION_MODEL,
  transcribeFileWithElevenLabsDiarization,
} from "./elevenlabs.js";
import { isFfmpegAvailable, runFfmpegTranscodeToMp3 } from "./ffmpeg.js";
import { OPENAI_DIARIZATION_MODEL, transcribeFileWithOpenAiDiarization } from "./openai.js";
import type {
  DiarizationPreference,
  DiarizationProvider,
  WhisperProgressEvent,
  WhisperTranscriptionResult,
} from "./types.js";
import { wrapError } from "./utils.js";

export function resolveDiarizationProviderOrder({
  preference,
  elevenlabsApiKey,
  openaiApiKey,
}: {
  preference: DiarizationPreference;
  elevenlabsApiKey: string | null;
  openaiApiKey: string | null;
}): DiarizationProvider[] {
  if (preference === "elevenlabs") return elevenlabsApiKey ? ["elevenlabs"] : [];
  if (preference === "openai") return openaiApiKey ? ["openai"] : [];
  return [
    ...(elevenlabsApiKey ? (["elevenlabs"] as const) : []),
    ...(openaiApiKey ? (["openai"] as const) : []),
  ];
}

export function buildDiarizationModelChain(providers: DiarizationProvider[]): string | null {
  const models = providers.map((provider) =>
    provider === "elevenlabs"
      ? `elevenlabs/${ELEVENLABS_DIARIZATION_MODEL}`
      : OPENAI_DIARIZATION_MODEL,
  );
  return models.length > 0 ? models.join("->") : null;
}

export async function transcribeMediaFileWithDiarization({
  filePath,
  mediaType,
  filename,
  preference,
  elevenlabsApiKey,
  openaiApiKey,
  env,
  totalDurationSeconds,
  onProgress,
}: {
  filePath: string;
  mediaType: string;
  filename: string | null;
  preference: DiarizationPreference;
  elevenlabsApiKey: string | null;
  openaiApiKey: string | null;
  env: Record<string, string | undefined>;
  totalDurationSeconds: number | null;
  onProgress?: ((event: WhisperProgressEvent) => void) | null;
}): Promise<WhisperTranscriptionResult> {
  const providers = resolveDiarizationProviderOrder({
    preference,
    elevenlabsApiKey,
    openaiApiKey,
  });
  if (providers.length === 0) {
    return {
      text: null,
      provider: preference === "auto" ? null : preference,
      error: new Error(buildMissingDiarizationProviderMessage(preference)),
      notes: [],
      segments: null,
    };
  }

  onProgress?.({
    partIndex: null,
    parts: null,
    processedDurationSeconds: null,
    totalDurationSeconds,
  });
  const notes: string[] = [];
  let lastError: Error | null = null;

  for (const [index, provider] of providers.entries()) {
    let preparedOpenAiFile: string | null = null;
    try {
      const result =
        provider === "elevenlabs"
          ? await transcribeFileWithElevenLabsDiarization({
              filePath,
              mediaType,
              filename,
              apiKey: elevenlabsApiKey!,
            })
          : await (async () => {
              const prepared = await prepareOpenAiDiarizationFile({
                filePath,
                mediaType,
                filename,
              });
              preparedOpenAiFile = prepared.cleanupPath;
              if (prepared.note) notes.push(prepared.note);
              return await transcribeFileWithOpenAiDiarization({
                filePath: prepared.filePath,
                mediaType: prepared.mediaType,
                filename: prepared.filename,
                apiKey: openaiApiKey!,
                options: { env },
              });
            })();
      return { ...result, notes: [...notes, ...result.notes] };
    } catch (caught) {
      lastError = wrapError(`${providerLabel(provider)} diarization failed`, caught);
      const next = providers[index + 1];
      if (next) {
        notes.push(
          `${providerLabel(provider)} diarization failed; falling back to ${providerLabel(next)}: ${lastError.message}`,
        );
      }
    } finally {
      if (preparedOpenAiFile) await fs.unlink(preparedOpenAiFile).catch(() => {});
    }
  }

  return {
    text: null,
    provider: providers.at(-1) ?? null,
    error: lastError ?? new Error("Speaker diarization failed"),
    notes,
    segments: null,
  };
}

export async function transcribeMediaBytesWithDiarization({
  bytes,
  mediaType,
  filename,
  ...rest
}: {
  bytes: Uint8Array;
  mediaType: string;
  filename: string | null;
  preference: DiarizationPreference;
  elevenlabsApiKey: string | null;
  openaiApiKey: string | null;
  env: Record<string, string | undefined>;
  totalDurationSeconds: number | null;
  onProgress?: ((event: WhisperProgressEvent) => void) | null;
}): Promise<WhisperTranscriptionResult> {
  const tempPath = join(tmpdir(), `summarize-diarize-${randomUUID()}`);
  try {
    await fs.writeFile(tempPath, bytes);
    return await transcribeMediaFileWithDiarization({
      filePath: tempPath,
      mediaType,
      filename,
      ...rest,
    });
  } finally {
    await fs.unlink(tempPath).catch(() => {});
  }
}

export function buildMissingDiarizationProviderMessage(preference: DiarizationPreference): string {
  if (preference === "elevenlabs") {
    return "Speaker diarization with ElevenLabs requires ELEVENLABS_API_KEY";
  }
  if (preference === "openai") {
    return "Speaker diarization with OpenAI requires OPENAI_API_KEY";
  }
  return "Speaker diarization requires ELEVENLABS_API_KEY or OPENAI_API_KEY";
}

function providerLabel(provider: DiarizationProvider): string {
  return provider === "elevenlabs" ? "ElevenLabs" : "OpenAI";
}

async function prepareOpenAiDiarizationFile({
  filePath,
  mediaType,
  filename,
}: {
  filePath: string;
  mediaType: string;
  filename: string | null;
}): Promise<{
  filePath: string;
  mediaType: string;
  filename: string | null;
  cleanupPath: string | null;
  note: string | null;
}> {
  const stat = await fs.stat(filePath);
  if (stat.size <= MAX_OPENAI_UPLOAD_BYTES) {
    return { filePath, mediaType, filename, cleanupPath: null, note: null };
  }
  if (!(await isFfmpegAvailable())) {
    throw new Error(
      "OpenAI diarization media exceeds the upload limit; install ffmpeg to compress it",
    );
  }

  const compressedPath = join(tmpdir(), `summarize-diarize-openai-${randomUUID()}.mp3`);
  let handedOff = false;
  try {
    await runFfmpegTranscodeToMp3({
      inputPath: filePath,
      outputPath: compressedPath,
      bitrateKbps: 24,
    });
    const compressedStat = await fs.stat(compressedPath);
    if (compressedStat.size > MAX_OPENAI_UPLOAD_BYTES) {
      throw new Error("OpenAI diarization media remains above the upload limit after compression");
    }
    handedOff = true;
    return {
      filePath: compressedPath,
      mediaType: "audio/mpeg",
      filename: "audio.mp3",
      cleanupPath: compressedPath,
      note: "OpenAI diarization: compressed oversized media to 24 kbps MP3",
    };
  } finally {
    if (!handedOff) await fs.unlink(compressedPath).catch(() => {});
  }
}
