export {
  buildSpeakerSourceKey,
  DEFAULT_SPEAKER_IDENTIFICATION_CONFIDENCE,
  DEFAULT_SPEAKER_IDENTIFICATION_MODEL,
  parseSpeakerAnchor,
  resolveSpeakerIdentificationSettings,
} from "./settings.js";
export {
  identifySpeakersInExtractedContent,
  SpeakerIdentificationError,
  type SpeakerIdentificationResult,
} from "./identify.js";
export {
  buildSpeakerEvidence,
  inferSpeakerMappingsWithOpenAi,
  type InferSpeakerMappingsResult,
  type OpenAiSpeakerMapping,
} from "./openai.js";
export { rememberSpeakerMappings } from "./remember.js";
export type {
  RememberedSpeakerMapping,
  ResolveSpeakerIdentificationInput,
  SpeakerAnchor,
  SpeakerIdentificationSettings,
  SpeakerIdentityMapping,
} from "./types.js";
