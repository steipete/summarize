import { DEFAULT_SEGMENT_SECONDS } from "./constants.js";
import type {
  DiarizationPreference,
  WhisperProgressEvent,
  WhisperTranscriptionResult,
} from "./types.js";

type MediaMetadata = { mediaType: string; filename: string | null };
export type TranscriptionBytes = MediaMetadata & { kind: "bytes"; bytes: Uint8Array };
export type TranscriptionFile = MediaMetadata & { kind: "file"; filePath: string };
export type TranscriptionSource = TranscriptionBytes | TranscriptionFile;

export type TranscriptionOptions = {
  groqApiKey: string | null;
  assemblyaiApiKey?: string | null;
  elevenlabsApiKey?: string | null;
  geminiApiKey?: string | null;
  openaiApiKey: string | null;
  falApiKey: string | null;
  deepgramApiKey?: string | null;
  diarization?: DiarizationPreference | null;
  segmentSeconds?: number;
  totalDurationSeconds?: number | null;
  onProgress?: ((event: WhisperProgressEvent) => void) | null;
  env?: Record<string, string | undefined>;
};

export type TranscriptionRun = ReturnType<typeof createTranscriptionRun>;
export type ProviderResult =
  | { kind: "result"; result: WhisperTranscriptionResult }
  | { kind: "error"; error: Error };

export type TranscriptionChunking = {
  file: (
    filePath: string,
    segmentSeconds: number,
    skipGroq: boolean,
  ) => Promise<WhisperTranscriptionResult>;
  bytes: (source: TranscriptionBytes) => Promise<WhisperTranscriptionResult>;
};

export function createTranscriptionRun(
  source: TranscriptionSource,
  {
    env = process.env,
    segmentSeconds = DEFAULT_SEGMENT_SECONDS,
    totalDurationSeconds = null,
    ...options
  }: TranscriptionOptions,
) {
  return {
    source,
    options: { ...options, env, segmentSeconds, totalDurationSeconds },
    notes: [] as string[],
    groqError: null as Error | null,
  };
}

export function emitInitialProgress({ options }: TranscriptionRun): void {
  options.onProgress?.({
    partIndex: null,
    parts: null,
    processedDurationSeconds: null,
    totalDurationSeconds: options.totalDurationSeconds,
  });
}
