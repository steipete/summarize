import { isOnnxCliConfigured, resolvePreferredOnnxModel } from "../../../transcription/onnx-cli.js";
import {
  buildDiarizationModelChain,
  isWhisperCppReady,
  resolveDiarizationProviderOrder,
  resolveWhisperCppModelNameForDisplay,
  type DiarizationPreference,
} from "../../../transcription/whisper.js";
import {
  buildCloudModelIdChain,
  buildCloudProviderHint,
} from "../../../transcription/whisper/cloud-providers.js";
import { resolveGeminiTranscriptionModel } from "../../../transcription/whisper/provider-setup.js";
import type { TranscriptionProviderHint } from "../../link-preview/deps.js";
import { resolveTranscriptionConfig, type TranscriptionConfig } from "../transcription-config.js";

type Env = Record<string, string | undefined>;

export type TranscriptionAvailability = {
  preferredOnnxModel: ReturnType<typeof resolvePreferredOnnxModel>;
  onnxReady: boolean;
  hasLocalWhisper: boolean;
  hasGroq: boolean;
  hasAssemblyAi: boolean;
  hasElevenLabs: boolean;
  hasGemini: boolean;
  hasOpenai: boolean;
  hasFal: boolean;
  hasAnyProvider: boolean;
  geminiModelId: string;
  effectiveEnv: Env;
};

export async function resolveTranscriptionAvailability({
  env,
  transcription,
  groqApiKey,
  assemblyaiApiKey,
  geminiApiKey,
  openaiApiKey,
  falApiKey,
}: {
  env?: Env;
  transcription?: Partial<TranscriptionConfig> | null;
  groqApiKey?: string | null;
  assemblyaiApiKey?: string | null;
  geminiApiKey?: string | null;
  openaiApiKey?: string | null;
  falApiKey?: string | null;
}): Promise<TranscriptionAvailability> {
  const effective = resolveTranscriptionConfig({
    env,
    transcription,
    groqApiKey,
    assemblyaiApiKey,
    geminiApiKey,
    openaiApiKey,
    falApiKey,
  });
  const effectiveEnv = effective.env ?? process.env;
  const preferredOnnxModel = resolvePreferredOnnxModel(effectiveEnv);
  const onnxReady = preferredOnnxModel
    ? isOnnxCliConfigured(preferredOnnxModel, effectiveEnv)
    : false;

  const hasLocalWhisper = await isWhisperCppReady(effectiveEnv);
  const hasGroq = Boolean(effective.groqApiKey);
  const hasAssemblyAi = Boolean(effective.assemblyaiApiKey);
  const hasElevenLabs = Boolean(effective.elevenlabsApiKey);
  const hasGemini = Boolean(effective.geminiApiKey);
  const hasOpenai = Boolean(effective.openaiApiKey);
  const hasFal = Boolean(effective.falApiKey);
  const hasAnyProvider =
    onnxReady || hasLocalWhisper || hasGroq || hasAssemblyAi || hasGemini || hasOpenai || hasFal;

  return {
    preferredOnnxModel,
    onnxReady,
    hasLocalWhisper,
    hasGroq,
    hasAssemblyAi,
    hasElevenLabs,
    hasGemini,
    hasOpenai,
    hasFal,
    hasAnyProvider,
    geminiModelId: effective.geminiModel ?? resolveGeminiTranscriptionModel(effectiveEnv),
    effectiveEnv,
  };
}

export async function resolveTranscriptionStartInfo({
  env,
  transcription,
  groqApiKey,
  assemblyaiApiKey,
  geminiApiKey,
  openaiApiKey,
  falApiKey,
  diarization = null,
}: {
  env?: Env;
  transcription?: Partial<TranscriptionConfig> | null;
  groqApiKey?: string | null;
  assemblyaiApiKey?: string | null;
  geminiApiKey?: string | null;
  openaiApiKey?: string | null;
  falApiKey?: string | null;
  diarization?: DiarizationPreference | null;
}): Promise<{
  availability: TranscriptionAvailability;
  providerHint: TranscriptionProviderHint;
  modelId: string | null;
}> {
  const availability = await resolveTranscriptionAvailability({
    env,
    transcription,
    groqApiKey,
    assemblyaiApiKey,
    geminiApiKey,
    openaiApiKey,
    falApiKey,
  });

  if (diarization) {
    const providers = resolveDiarizationProviderOrder({
      preference: diarization,
      elevenlabsApiKey: availability.hasElevenLabs ? "1" : null,
      openaiApiKey: availability.hasOpenai ? "1" : null,
    });
    return {
      availability,
      providerHint:
        providers.length > 0
          ? (providers.join("->") as TranscriptionProviderHint)
          : ("unknown" as const),
      modelId: buildDiarizationModelChain(providers),
    };
  }

  const providerHint: TranscriptionProviderHint = availability.onnxReady
    ? "onnx"
    : availability.hasLocalWhisper
      ? "cpp"
      : resolveCloudProviderHint(availability);

  const modelId =
    providerHint === "onnx"
      ? availability.preferredOnnxModel
        ? `onnx/${availability.preferredOnnxModel}`
        : "onnx"
      : providerHint === "cpp"
        ? ((await resolveWhisperCppModelNameForDisplay(availability.effectiveEnv)) ?? "whisper.cpp")
        : resolveCloudModelId(availability);

  return { availability, providerHint, modelId };
}

function resolveCloudModelId(availability: TranscriptionAvailability): string | null {
  const cloudModelId = buildCloudModelIdChain({
    availability,
    geminiModelId: availability.geminiModelId,
  });
  if (!availability.hasGroq) return cloudModelId;
  return cloudModelId
    ? `groq/whisper-large-v3-turbo->${cloudModelId}`
    : "groq/whisper-large-v3-turbo";
}

function resolveCloudProviderHint(
  availability: TranscriptionAvailability,
): TranscriptionProviderHint {
  const cloudHint = buildCloudProviderHint({
    hasAssemblyAi: availability.hasAssemblyAi,
    hasGemini: availability.hasGemini,
    hasOpenai: availability.hasOpenai,
    hasFal: availability.hasFal,
  });
  const chain = availability.hasGroq
    ? ["groq", cloudHint].filter(Boolean).join("->")
    : (cloudHint ?? "");
  return chain.length > 0 ? (chain as TranscriptionProviderHint) : "unknown";
}
