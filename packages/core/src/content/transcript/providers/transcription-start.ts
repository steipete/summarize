import { isOnnxCliConfigured, resolvePreferredOnnxModel } from '../../../transcription/onnx-cli.js'
import {
  isWhisperCppReady,
  resolveWhisperCppModelNameForDisplay,
} from '../../../transcription/whisper.js'
import type { TranscriptionProviderHint } from '../../link-preview/deps.js'

type Env = Record<string, string | undefined>

export type TranscriptionAvailability = {
  preferredOnnxModel: ReturnType<typeof resolvePreferredOnnxModel>
  onnxReady: boolean
  hasLocalWhisper: boolean
  hasGroq: boolean
  hasOpenai: boolean
  hasFal: boolean
  hasAnyProvider: boolean
}

export async function resolveTranscriptionAvailability({
  env,
  groqApiKey,
  openaiApiKey,
  falApiKey,
}: {
  env?: Env
  groqApiKey: string | null
  openaiApiKey: string | null
  falApiKey: string | null
}): Promise<TranscriptionAvailability> {
  const effectiveEnv = env ?? process.env
  const preferredOnnxModel = resolvePreferredOnnxModel(effectiveEnv)
  const onnxReady = preferredOnnxModel
    ? isOnnxCliConfigured(preferredOnnxModel, effectiveEnv)
    : false

  const hasLocalWhisper = await isWhisperCppReady()
  const hasGroq = Boolean(groqApiKey)
  const hasOpenai = Boolean(openaiApiKey)
  const hasFal = Boolean(falApiKey)
  const hasAnyProvider = onnxReady || hasLocalWhisper || hasGroq || hasOpenai || hasFal

  return {
    preferredOnnxModel,
    onnxReady,
    hasLocalWhisper,
    hasGroq,
    hasOpenai,
    hasFal,
    hasAnyProvider,
  }
}

export async function resolveTranscriptionStartInfo({
  env,
  groqApiKey,
  openaiApiKey,
  falApiKey,
}: {
  env?: Env
  groqApiKey: string | null
  openaiApiKey: string | null
  falApiKey: string | null
}): Promise<{
  availability: TranscriptionAvailability
  providerHint: TranscriptionProviderHint
  modelId: string | null
}> {
  const availability = await resolveTranscriptionAvailability({
    env,
    groqApiKey,
    openaiApiKey,
    falApiKey,
  })

  const providerHint: TranscriptionProviderHint = availability.hasGroq
    ? availability.hasOpenai && availability.hasFal
      ? 'groq->openai->fal'
      : availability.hasOpenai
        ? 'groq->openai'
        : availability.hasFal
          ? 'groq->fal'
          : 'groq'
    : availability.onnxReady
      ? 'onnx'
      : availability.hasLocalWhisper
        ? 'cpp'
        : availability.hasOpenai && availability.hasFal
          ? 'openai->fal'
          : availability.hasOpenai
            ? 'openai'
            : availability.hasFal
              ? 'fal'
              : 'unknown'

  const modelId =
    providerHint === 'onnx'
      ? availability.preferredOnnxModel
        ? `onnx/${availability.preferredOnnxModel}`
        : 'onnx'
      : providerHint === 'cpp'
        ? ((await resolveWhisperCppModelNameForDisplay()) ?? 'whisper.cpp')
        : resolveCloudModelId(availability)

  return { availability, providerHint, modelId }
}

function resolveCloudModelId(availability: TranscriptionAvailability): string | null {
  const parts: string[] = []
  if (availability.hasGroq) parts.push('groq/whisper-large-v3-turbo')
  if (availability.hasOpenai) parts.push('whisper-1')
  if (availability.hasFal) parts.push('fal-ai/wizper')
  return parts.length > 0 ? parts.join('->') : null
}
