export type TranscriptionProvider = 'openai' | 'fal' | 'whisper.cpp' | 'onnx-parakeet' | 'onnx-canary'

export type WhisperTranscriptionResult = {
  text: string | null
  provider: TranscriptionProvider | null
  error: Error | null
  notes: string[]
}

export type WhisperProgressEvent = {
  /** 1-based segment index (only when chunked via ffmpeg). */
  partIndex: number | null
  /** Total number of segments (only when chunked via ffmpeg). */
  parts: number | null
  /** Best-effort processed duration of the source media. */
  processedDurationSeconds: number | null
  /** Best-effort total duration of the source media. */
  totalDurationSeconds: number | null
}
