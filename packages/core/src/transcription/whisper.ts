export { MAX_OPENAI_UPLOAD_BYTES } from './whisper/constants.js'
export { transcribeMediaFileWithWhisper, transcribeMediaWithWhisper } from './whisper/core.js'
export { isFfmpegAvailable, probeMediaDurationSecondsWithFfprobe } from './whisper/ffmpeg.js'
export type {
  TranscriptionProvider,
  WhisperProgressEvent,
  WhisperTranscriptionResult,
} from './whisper/types.js'
export {
  isWhisperCppReady,
  resolveWhisperCppModelNameForDisplay,
} from './whisper/whisper-cpp.js'
