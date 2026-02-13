import type { CliProvider, SummarizeConfig } from '../config.js'
import { resolveCliAvailability, resolveExecutableInPath } from './env.js'

export type EnvState = {
  apiKey: string | null
  openrouterApiKey: string | null
  openrouterConfigured: boolean
  groqApiKey: string | null
  openaiTranscriptionKey: string | null
  xaiApiKey: string | null
  googleApiKey: string | null
  anthropicApiKey: string | null
  zaiApiKey: string | null
  zaiBaseUrl: string
  firecrawlApiKey: string | null
  firecrawlConfigured: boolean
  googleConfigured: boolean
  anthropicConfigured: boolean
  apifyToken: string | null
  ytDlpPath: string | null
  ytDlpCookiesFromBrowser: string | null
  falApiKey: string | null
  cliAvailability: Partial<Record<CliProvider, boolean>>
  envForAuto: Record<string, string | undefined>
  providerBaseUrls: {
    openai: string | null
    anthropic: string | null
    google: string | null
    xai: string | null
  }
}

function normalizeBaseUrl(raw: string | null | undefined): string | null {
  const trimmed = typeof raw === 'string' ? raw.trim() : ''
  return trimmed.length > 0 ? trimmed : null
}

export function resolveEnvState({
  env,
  envForRun,
  configForCli,
}: {
  env: Record<string, string | undefined>
  envForRun: Record<string, string | undefined>
  configForCli: SummarizeConfig | null
}): EnvState {
  const xaiKeyRaw = typeof envForRun.XAI_API_KEY === 'string' ? envForRun.XAI_API_KEY : null
  const openaiBaseUrl = (() => {
    const envValue = normalizeBaseUrl(envForRun.OPENAI_BASE_URL)
    if (envValue) return envValue
    return normalizeBaseUrl(configForCli?.openai?.baseUrl)
  })()
  const anthropicBaseUrl = (() => {
    const envValue = normalizeBaseUrl(envForRun.ANTHROPIC_BASE_URL)
    if (envValue) return envValue
    return normalizeBaseUrl(configForCli?.anthropic?.baseUrl)
  })()
  const googleBaseUrl = (() => {
    const envValue = normalizeBaseUrl(envForRun.GOOGLE_BASE_URL ?? envForRun.GEMINI_BASE_URL)
    if (envValue) return envValue
    return normalizeBaseUrl(configForCli?.google?.baseUrl)
  })()
  const xaiBaseUrl = (() => {
    const envValue = normalizeBaseUrl(envForRun.XAI_BASE_URL)
    if (envValue) return envValue
    return normalizeBaseUrl(configForCli?.xai?.baseUrl)
  })()
  const zaiKeyRaw =
    typeof envForRun.Z_AI_API_KEY === 'string'
      ? envForRun.Z_AI_API_KEY
      : typeof envForRun.ZAI_API_KEY === 'string'
        ? envForRun.ZAI_API_KEY
        : null
  const zaiBaseUrlRaw =
    typeof envForRun.Z_AI_BASE_URL === 'string'
      ? envForRun.Z_AI_BASE_URL
      : typeof envForRun.ZAI_BASE_URL === 'string'
        ? envForRun.ZAI_BASE_URL
        : null
  const openRouterKeyRaw =
    typeof envForRun.OPENROUTER_API_KEY === 'string' ? envForRun.OPENROUTER_API_KEY : null
  const openaiKeyRaw =
    typeof envForRun.OPENAI_API_KEY === 'string' ? envForRun.OPENAI_API_KEY : null
  const apiKey =
    typeof openaiBaseUrl === 'string' && /openrouter\.ai/i.test(openaiBaseUrl)
      ? (openRouterKeyRaw ?? openaiKeyRaw)
      : openaiKeyRaw
  const apifyToken =
    typeof envForRun.APIFY_API_TOKEN === 'string' ? envForRun.APIFY_API_TOKEN : null
  const ytDlpPath = (() => {
    const explicit = typeof envForRun.YT_DLP_PATH === 'string' ? envForRun.YT_DLP_PATH.trim() : ''
    if (explicit.length > 0) return explicit
    return resolveExecutableInPath('yt-dlp', envForRun)
  })()
  const ytDlpCookiesFromBrowser = (() => {
    const raw =
      typeof envForRun.SUMMARIZE_YT_DLP_COOKIES_FROM_BROWSER === 'string'
        ? envForRun.SUMMARIZE_YT_DLP_COOKIES_FROM_BROWSER
        : typeof envForRun.YT_DLP_COOKIES_FROM_BROWSER === 'string'
          ? envForRun.YT_DLP_COOKIES_FROM_BROWSER
          : ''
    const value = raw.trim()
    return value.length > 0 ? value : null
  })()
  const groqApiKey =
    typeof envForRun.GROQ_API_KEY === 'string' ? envForRun.GROQ_API_KEY.trim() || null : null
  const falApiKey = typeof envForRun.FAL_KEY === 'string' ? envForRun.FAL_KEY : null
  const firecrawlKey =
    typeof envForRun.FIRECRAWL_API_KEY === 'string' ? envForRun.FIRECRAWL_API_KEY : null
  const anthropicKeyRaw =
    typeof envForRun.ANTHROPIC_API_KEY === 'string' ? envForRun.ANTHROPIC_API_KEY : null
  const googleKeyRaw =
    typeof envForRun.GEMINI_API_KEY === 'string'
      ? envForRun.GEMINI_API_KEY
      : typeof envForRun.GOOGLE_GENERATIVE_AI_API_KEY === 'string'
        ? envForRun.GOOGLE_GENERATIVE_AI_API_KEY
        : typeof envForRun.GOOGLE_API_KEY === 'string'
          ? envForRun.GOOGLE_API_KEY
          : null

  const firecrawlApiKey = firecrawlKey && firecrawlKey.trim().length > 0 ? firecrawlKey : null
  const firecrawlConfigured = firecrawlApiKey !== null
  const xaiApiKey = xaiKeyRaw?.trim() ?? null
  const zaiApiKey = zaiKeyRaw?.trim() ?? null
  const zaiBaseUrl = (zaiBaseUrlRaw?.trim() ?? '') || 'https://api.z.ai/api/paas/v4'
  const googleApiKey = googleKeyRaw?.trim() ?? null
  const anthropicApiKey = anthropicKeyRaw?.trim() ?? null
  const openrouterApiKey = (() => {
    const explicit = openRouterKeyRaw?.trim() ?? ''
    if (explicit.length > 0) return explicit
    const baseUrl = openaiBaseUrl ?? ''
    const openaiKey = openaiKeyRaw?.trim() ?? ''
    if (baseUrl.length > 0 && /openrouter\.ai/i.test(baseUrl) && openaiKey.length > 0) {
      return openaiKey
    }
    return null
  })()
  const openaiTranscriptionKey = openaiKeyRaw?.trim() ?? null
  const googleConfigured = typeof googleApiKey === 'string' && googleApiKey.length > 0
  const anthropicConfigured = typeof anthropicApiKey === 'string' && anthropicApiKey.length > 0
  const openrouterConfigured = typeof openrouterApiKey === 'string' && openrouterApiKey.length > 0
  const cliAvailability = resolveCliAvailability({ env, config: configForCli })
  const envForAuto = openrouterApiKey ? { ...env, OPENROUTER_API_KEY: openrouterApiKey } : env
  const providerBaseUrls = {
    openai: openaiBaseUrl,
    anthropic: anthropicBaseUrl,
    google: googleBaseUrl,
    xai: xaiBaseUrl,
  }

  return {
    apiKey: apiKey?.trim() ?? null,
    openrouterApiKey,
    openrouterConfigured,
    groqApiKey,
    openaiTranscriptionKey,
    xaiApiKey,
    googleApiKey,
    anthropicApiKey,
    zaiApiKey,
    zaiBaseUrl,
    firecrawlApiKey,
    firecrawlConfigured,
    googleConfigured,
    anthropicConfigured,
    apifyToken,
    ytDlpPath,
    ytDlpCookiesFromBrowser,
    falApiKey,
    cliAvailability,
    envForAuto,
    providerBaseUrls,
  }
}
