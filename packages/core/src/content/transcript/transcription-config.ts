import {
  resolveAssemblyAiApiKey,
  resolveElevenLabsApiKey,
  resolveFalApiKey,
  resolveGeminiApiKey,
  resolveGroqApiKey,
  resolveOpenAiTranscriptionApiKey,
} from "../../transcription/whisper/provider-setup.js";

export type TranscriptionConfig = {
  env?: Record<string, string | undefined>;
  groqApiKey: string | null;
  assemblyaiApiKey: string | null;
  elevenlabsApiKey: string | null;
  geminiApiKey: string | null;
  openaiApiKey: string | null;
  falApiKey: string | null;
  geminiModel: string | null;
};

type TranscriptionConfigInput = {
  env?: Record<string, string | undefined>;
  transcription?: Partial<TranscriptionConfig> | null;
  groqApiKey?: string | null;
  assemblyaiApiKey?: string | null;
  elevenlabsApiKey?: string | null;
  geminiApiKey?: string | null;
  openaiApiKey?: string | null;
  falApiKey?: string | null;
  geminiModel?: string | null;
};

function normalizeKey(raw: string | null | undefined): string | null {
  const trimmed = typeof raw === "string" ? raw.trim() : "";
  return trimmed.length > 0 ? trimmed : null;
}

export function resolveTranscriptionConfig(input: TranscriptionConfigInput): TranscriptionConfig {
  const fromObject = input.transcription ?? null;
  const env = fromObject?.env ?? input.env;
  return {
    env,
    groqApiKey: resolveGroqApiKey({
      env,
      groqApiKey: fromObject?.groqApiKey ?? input.groqApiKey,
    }),
    assemblyaiApiKey: resolveAssemblyAiApiKey({
      env,
      assemblyaiApiKey: fromObject?.assemblyaiApiKey ?? input.assemblyaiApiKey,
    }),
    elevenlabsApiKey: resolveElevenLabsApiKey({
      env,
      elevenlabsApiKey: fromObject?.elevenlabsApiKey ?? input.elevenlabsApiKey,
    }),
    geminiApiKey: resolveGeminiApiKey({
      env,
      geminiApiKey: fromObject?.geminiApiKey ?? input.geminiApiKey,
    }),
    openaiApiKey: resolveOpenAiTranscriptionApiKey({
      env,
      openaiApiKey: fromObject?.openaiApiKey ?? input.openaiApiKey,
    }),
    falApiKey: resolveFalApiKey({
      env,
      falApiKey: fromObject?.falApiKey ?? input.falApiKey,
    }),
    geminiModel: normalizeKey(fromObject?.geminiModel ?? input.geminiModel),
  };
}
