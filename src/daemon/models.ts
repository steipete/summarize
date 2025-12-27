import type { SummarizeConfig } from '../config.js'
import { resolveEnvState } from '../run/run-env.js'

export type ModelPickerOption = {
  id: string
  label: string
}

function uniqById(options: ModelPickerOption[]): ModelPickerOption[] {
  const seen = new Set<string>()
  const out: ModelPickerOption[] = []
  for (const opt of options) {
    const id = opt.id.trim()
    if (!id) continue
    if (seen.has(id)) continue
    seen.add(id)
    out.push({ id, label: opt.label.trim() || id })
  }
  return out
}

function isProbablyOpenRouterBaseUrl(baseUrl: string): boolean {
  return /openrouter\.ai/i.test(baseUrl)
}

function isProbablyZaiBaseUrl(baseUrl: string): boolean {
  return /api\.z\.ai/i.test(baseUrl)
}

function describeBaseUrlHost(baseUrl: string): string | null {
  try {
    const url = new URL(baseUrl)
    const host = url.host.trim()
    return host.length > 0 ? host : null
  } catch {
    return null
  }
}

async function discoverOpenAiCompatibleModelIds({
  baseUrl,
  apiKey,
  fetchImpl,
  timeoutMs,
}: {
  baseUrl: string
  apiKey: string
  fetchImpl: typeof fetch
  timeoutMs: number
}): Promise<string[]> {
  const base = baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`
  const modelsUrl = new URL('models', base).toString()

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetchImpl(modelsUrl, {
      method: 'GET',
      headers: {
        authorization: `Bearer ${apiKey}`,
      },
      signal: controller.signal,
    })
    if (!res.ok) return []
    const json = (await res.json()) as unknown
    if (!json || typeof json !== 'object') return []

    const obj = json as Record<string, unknown>
    const data = obj.data
    if (Array.isArray(data)) {
      const ids = data
        .map((item) => (item && typeof item === 'object' ? (item as { id?: unknown }).id : null))
        .filter((id): id is string => typeof id === 'string' && id.trim().length > 0)
        .map((id) => id.trim())
      return Array.from(new Set(ids)).sort((a, b) => a.localeCompare(b))
    }

    const models = obj.models
    if (Array.isArray(models)) {
      const ids = models
        .filter((id): id is string => typeof id === 'string' && id.trim().length > 0)
        .map((id) => id.trim())
      return Array.from(new Set(ids)).sort((a, b) => a.localeCompare(b))
    }

    return []
  } catch {
    return []
  } finally {
    clearTimeout(timeout)
  }
}

export async function buildModelPickerOptions({
  env,
  envForRun,
  configForCli,
  fetchImpl,
}: {
  env: Record<string, string | undefined>
  envForRun: Record<string, string | undefined>
  configForCli: SummarizeConfig | null
  fetchImpl: typeof fetch
}): Promise<{
  ok: true
  options: ModelPickerOption[]
  providers: {
    xai: boolean
    openai: boolean
    google: boolean
    anthropic: boolean
    openrouter: boolean
    zai: boolean
  }
  openaiBaseUrl: string | null
  localModelsSource: { kind: 'openai-compatible'; baseUrlHost: string } | null
}> {
  const envState = resolveEnvState({ env, envForRun, configForCli })

  const providers = {
    xai: Boolean(envState.xaiApiKey),
    openai: Boolean(envState.apiKey),
    google: envState.googleConfigured,
    anthropic: envState.anthropicConfigured,
    openrouter: envState.openrouterConfigured,
    zai: Boolean(envState.zaiApiKey),
  }

  const options: ModelPickerOption[] = [{ id: 'auto', label: 'Auto' }]

  if (providers.openrouter) {
    options.push({ id: 'free', label: 'Free (OpenRouter)' })
    options.push({ id: 'openrouter/openai/gpt-5-mini', label: 'OpenRouter: OpenAI gpt-5-mini' })
  }

  if (providers.openai) {
    options.push({ id: 'openai/gpt-5-mini', label: 'OpenAI gpt-5-mini' })
    options.push({ id: 'openai/gpt-5-nano', label: 'OpenAI gpt-5-nano' })
    options.push({ id: 'openai/gpt-5.2', label: 'OpenAI gpt-5.2' })
  }

  if (providers.anthropic) {
    options.push({ id: 'anthropic/claude-sonnet-4-5', label: 'Anthropic Claude Sonnet 4.5' })
    options.push({ id: 'anthropic/claude-opus-4-1', label: 'Anthropic Claude Opus 4.1' })
  }

  if (providers.google) {
    options.push({ id: 'google/gemini-3-flash-preview', label: 'Google Gemini 3 Flash' })
  }

  if (providers.xai) {
    options.push({ id: 'xai/grok-4-fast-non-reasoning', label: 'xAI Grok 4 Fast' })
  }

  if (providers.zai) {
    options.push({ id: 'zai/glm-4.7', label: 'Z.AI glm-4.7' })
  }

  const openaiBaseUrl = (() => {
    const raw = typeof envForRun.OPENAI_BASE_URL === 'string' ? envForRun.OPENAI_BASE_URL : null
    const trimmed = raw?.trim() ?? ''
    return trimmed.length > 0 ? trimmed : null
  })()

  let localModelsSource: { kind: 'openai-compatible'; baseUrlHost: string } | null = null

  if (
    openaiBaseUrl &&
    envState.apiKey &&
    !isProbablyOpenRouterBaseUrl(openaiBaseUrl) &&
    !isProbablyZaiBaseUrl(openaiBaseUrl)
  ) {
    const baseUrlHost = describeBaseUrlHost(openaiBaseUrl)
    if (baseUrlHost) {
      const discovered = await discoverOpenAiCompatibleModelIds({
        baseUrl: openaiBaseUrl,
        apiKey: envState.apiKey,
        fetchImpl,
        timeoutMs: 900,
      })
      if (discovered.length > 0) {
        localModelsSource = { kind: 'openai-compatible', baseUrlHost }
        for (const id of discovered) {
          options.push({ id: `openai/${id}`, label: `Local (${baseUrlHost}): ${id}` })
        }
      }
    }
  }

  return {
    ok: true,
    options: uniqById(options),
    providers,
    openaiBaseUrl,
    localModelsSource,
  }
}
