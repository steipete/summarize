import {
  processBrowserAudioBytesWithMediaBunny,
  processBrowserAudioUrlWithMediaBunny,
  type BrowserAudioChunk,
  type BrowserAudioProcessResult,
} from "../background/browser-media";
import {
  clampWhisperTranscript,
  transcribePcmChunkWithWhisper,
  type WhisperRuntimeDiagnostics,
} from "./whisper";

export type BrowserMediaTranscriptionDiagnostics = {
  chunksProcessed: number;
  chunksTotal: number;
  codec: string;
  decoder: "mediabunny-webcodecs";
  durationSeconds: number;
  input: "buffer" | "url-range";
  whisper: WhisperRuntimeDiagnostics;
};

export type BrowserMediaTranscription = {
  diagnostics: BrowserMediaTranscriptionDiagnostics;
  text: string;
  transcriptTimedText: string;
  truncated: boolean;
};

export async function transcribeBrowserMediaUrl({
  credentials = "include",
  maxChars,
  mediaUrl,
  onStatus,
}: {
  credentials?: RequestCredentials;
  maxChars: number;
  mediaUrl: string;
  onStatus: (status: string) => void;
}): Promise<BrowserMediaTranscription> {
  return await transcribeBrowserMedia({
    input: "url-range",
    maxChars,
    onStatus,
    process: async (onChunk) =>
      await processBrowserAudioUrlWithMediaBunny({
        credentials,
        mediaUrl,
        onChunk,
      }),
  });
}

export async function transcribeBrowserMediaBytes({
  inputBytes,
  maxChars,
  mimeType,
  onStatus,
}: {
  inputBytes: Uint8Array;
  maxChars: number;
  mimeType: string;
  onStatus: (status: string) => void;
}): Promise<BrowserMediaTranscription> {
  return await transcribeBrowserMedia({
    input: "buffer",
    maxChars,
    onStatus,
    process: async (onChunk) =>
      await processBrowserAudioBytesWithMediaBunny({
        inputBytes,
        mimeType,
        onChunk,
      }),
  });
}

async function transcribeBrowserMedia({
  input,
  maxChars,
  onStatus,
  process,
}: {
  input: BrowserMediaTranscriptionDiagnostics["input"];
  maxChars: number;
  onStatus: (status: string) => void;
  process: (
    onChunk: (chunk: BrowserAudioChunk) => Promise<boolean | void>,
  ) => Promise<BrowserAudioProcessResult>;
}): Promise<BrowserMediaTranscription> {
  const textParts: string[] = [];
  const timedLines: string[] = [];
  let chunksProcessed = 0;
  let whisper: WhisperRuntimeDiagnostics | null = null;
  const normalizedMaxChars =
    Number.isFinite(maxChars) && maxChars > 0 ? Math.floor(maxChars) : Number.POSITIVE_INFINITY;

  onStatus("Preparing audio with browser media decoder...");
  const media = await process(async (chunk) => {
    const current = chunk.chunkIndex + 1;
    const transcript = await transcribePcmChunkWithWhisper({
      audio: chunk.audio,
      timestampOffsetSeconds: chunk.startSeconds,
      transcribingStatus: `Transcribing audio locally (${current}/${chunk.chunkCount})...`,
      onStatus,
    });
    chunksProcessed += 1;
    whisper ??= transcript.diagnostics;
    if (transcript.text) textParts.push(transcript.text);
    timedLines.push(...transcript.timedLines);
    return textParts.join(" ").length < normalizedMaxChars;
  });

  const clamped = clampWhisperTranscript(
    textParts.join(" ").replace(/\s+/g, " ").trim(),
    timedLines.join("\n"),
    maxChars,
  );
  if (!clamped.text) throw new Error("Local Whisper returned an empty transcript.");
  if (!whisper) throw new Error("Local Whisper did not process any audio.");

  return {
    ...clamped,
    diagnostics: {
      chunksProcessed,
      chunksTotal: media.chunkCount,
      codec: media.codec,
      decoder: "mediabunny-webcodecs",
      durationSeconds: media.durationSeconds,
      input,
      whisper,
    },
  };
}
