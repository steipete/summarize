export type TranscriptionConfig = {
  env?: Record<string, string | undefined>
  groqApiKey: string | null
  openaiApiKey: string | null
  falApiKey: string | null
}

type TranscriptionConfigInput = {
  env?: Record<string, string | undefined>
  transcription?: Partial<TranscriptionConfig> | null
  groqApiKey?: string | null
  openaiApiKey?: string | null
  falApiKey?: string | null
}

function normalizeKey(raw: string | null | undefined): string | null {
  const trimmed = typeof raw === 'string' ? raw.trim() : ''
  return trimmed.length > 0 ? trimmed : null
}

export function resolveTranscriptionConfig(input: TranscriptionConfigInput): TranscriptionConfig {
  const fromObject = input.transcription ?? null
  return {
    env: fromObject?.env ?? input.env,
    groqApiKey: normalizeKey(fromObject?.groqApiKey ?? input.groqApiKey),
    openaiApiKey: normalizeKey(fromObject?.openaiApiKey ?? input.openaiApiKey),
    falApiKey: normalizeKey(fromObject?.falApiKey ?? input.falApiKey),
  }
}
