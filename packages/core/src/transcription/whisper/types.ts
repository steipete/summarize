export type TranscriptionProvider =
  | "groq"
  | "assemblyai"
  | "elevenlabs"
  | "gemini"
  | "openai"
  | "fal"
  | "whisper.cpp"
  | "onnx-parakeet"
  | "onnx-canary";

export type DiarizationProvider = "elevenlabs" | "openai";
export type DiarizationPreference = "auto" | DiarizationProvider;

export type TranscriptionSegment = {
  startMs: number;
  endMs?: number | null;
  text: string;
  speaker?: string | null;
};

export type WhisperTranscriptionResult = {
  text: string | null;
  provider: TranscriptionProvider | null;
  error: Error | null;
  notes: string[];
  segments?: TranscriptionSegment[] | null;
};

export type WhisperProgressEvent = {
  /** 1-based segment index (only when chunked via ffmpeg). */
  partIndex: number | null;
  /** Total number of segments (only when chunked via ffmpeg). */
  parts: number | null;
  /** Best-effort processed duration of the source media. */
  processedDurationSeconds: number | null;
  /** Best-effort total duration of the source media. */
  totalDurationSeconds: number | null;
};
