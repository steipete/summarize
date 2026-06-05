import {
  resolveAssemblyAiApiKey,
  resolveFalApiKey,
  resolveGeminiApiKey,
  resolveGroqApiKey,
  resolveOpenAiTranscriptionApiKey,
} from "../../transcription/whisper/provider-setup.js";

export type TranscriptionConfig = {
  env?: Record<string, string | undefined>;
  groqApiKey: string | null;
  assemblyaiApiKey: string | null;
  geminiApiKey: string | null;
  openaiApiKey: string | null;
  falApiKey: string | null;
  geminiModel: string | null;
  remoteMediaMaxBytes: number | null;
};

type TranscriptionConfigInput = {
  env?: Record<string, string | undefined>;
  transcription?: Partial<TranscriptionConfig> | null;
  groqApiKey?: string | null;
  assemblyaiApiKey?: string | null;
  geminiApiKey?: string | null;
  openaiApiKey?: string | null;
  falApiKey?: string | null;
  geminiModel?: string | null;
  remoteMediaMaxBytes?: number | string | null;
};

export const REMOTE_MEDIA_MAX_BYTES_ENV = "SUMMARIZE_REMOTE_MEDIA_MAX_BYTES";

function normalizeKey(raw: string | null | undefined): string | null {
  const trimmed = typeof raw === "string" ? raw.trim() : "";
  return trimmed.length > 0 ? trimmed : null;
}

export function normalizeRemoteMediaMaxBytes(
  raw: number | string | null | undefined,
): number | null {
  if (raw == null) return null;
  if (typeof raw === "number") {
    return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : null;
  }

  const trimmed = raw.trim();
  if (!trimmed) return null;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : null;
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
    remoteMediaMaxBytes: normalizeRemoteMediaMaxBytes(
      fromObject?.remoteMediaMaxBytes ??
        input.remoteMediaMaxBytes ??
        env?.[REMOTE_MEDIA_MAX_BYTES_ENV],
    ),
  };
}
