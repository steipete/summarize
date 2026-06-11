import type { SpeakersConfig } from "../config.js";

export type SpeakerAnchor = {
  atMs: number;
  name: string;
};

export type SpeakerIdentityMapping = {
  speaker: string;
  name: string;
  confidence: number;
  source: "anchor" | "remembered" | "openai";
  evidence?: string | null;
};

export type RememberedSpeakerMapping = {
  transcriptHash: string;
  mappings: Record<string, string>;
};

export type SpeakerIdentificationSettings = {
  sourceKey: string;
  profileName: string | null;
  host: string | null;
  knownSpeakers: string[];
  context: string | null;
  model: string;
  minimumConfidence: number;
  anchors: SpeakerAnchor[];
  remembered: RememberedSpeakerMapping | null;
  remember: boolean;
  explicit: boolean;
};

export type ResolveSpeakerIdentificationInput = {
  config: SpeakersConfig | null | undefined;
  sourceUrl: string;
  diarization: "auto" | "elevenlabs" | "openai" | null;
  profileArg: string | null;
  anchorArgs: readonly string[];
  identifyOverride: boolean | null;
  remember: boolean;
};
