type Env = Record<string, string | undefined>

export function normalizeBaseUrl(raw: string | null | undefined): string | null {
  const trimmed = typeof raw === 'string' ? raw.trim() : ''
  return trimmed.length > 0 ? trimmed : null
}

export function isOpenRouterBaseUrl(baseUrl: string): boolean {
  try {
    return new URL(baseUrl).host.toLowerCase().includes('openrouter.ai')
  } catch {
    return /openrouter\.ai/i.test(baseUrl)
  }
}

export function resolveConfiguredBaseUrl({
  envValue,
  configValue,
}: {
  envValue: string | null | undefined
  configValue: string | null | undefined
}): string | null {
  const normalizedEnv = normalizeBaseUrl(envValue)
  if (normalizedEnv) return normalizedEnv
  return normalizeBaseUrl(configValue)
}

export function resolveOpenAiWhisperBaseUrl({
  explicitBaseUrl,
  env,
  allowOpenRouterFallback = false,
  defaultBaseUrl = 'https://api.openai.com/v1',
}: {
  explicitBaseUrl?: string | null
  env?: Env
  allowOpenRouterFallback?: boolean
  defaultBaseUrl?: string
}): string {
  const explicit = normalizeBaseUrl(explicitBaseUrl)
  if (explicit) return explicit

  const effectiveEnv = env ?? process.env
  const whisperBaseUrl = normalizeBaseUrl(effectiveEnv.OPENAI_WHISPER_BASE_URL)
  if (whisperBaseUrl) return whisperBaseUrl

  const openaiBaseUrl = normalizeBaseUrl(effectiveEnv.OPENAI_BASE_URL)
  if (openaiBaseUrl) {
    if (allowOpenRouterFallback || !isOpenRouterBaseUrl(openaiBaseUrl)) {
      return openaiBaseUrl
    }
  }

  return defaultBaseUrl
}
