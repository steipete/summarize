import type {
  Api,
  AssistantMessage,
  Context,
  KnownProvider,
  Message,
  Model,
} from '@mariozechner/pi-ai'
import { completeSimple, getModel, streamSimple } from '@mariozechner/pi-ai'
import { parseGatewayStyleModelId } from './model-id.js'
import { isDocumentPrompt, type DocumentPrompt, type PromptPayload } from './prompt.js'

export type LlmApiKeys = {
  xaiApiKey: string | null
  openaiApiKey: string | null
  googleApiKey: string | null
  anthropicApiKey: string | null
  openrouterApiKey: string | null
}

export type OpenRouterOptions = {
  providers: string[] | null
}

export type LlmTokenUsage = {
  promptTokens: number | null
  completionTokens: number | null
  totalTokens: number | null
}

type RetryNotice = {
  attempt: number
  maxRetries: number
  delayMs: number
  error: unknown
}

type OpenAiClientConfig = {
  apiKey: string
  baseURL?: string
  useChatCompletions: boolean
  isOpenRouter: boolean
}

function parseAnthropicErrorPayload(
  responseBody: string
): { type: string; message: string } | null {
  try {
    const parsed = JSON.parse(responseBody) as {
      type?: unknown
      error?: { type?: unknown; message?: unknown }
    }
    if (parsed?.type !== 'error') return null
    const error = parsed.error
    if (!error || typeof error !== 'object') return null
    const errorType = typeof error.type === 'string' ? error.type : null
    const errorMessage = typeof error.message === 'string' ? error.message : null
    if (!errorType || !errorMessage) return null
    return { type: errorType, message: errorMessage }
  } catch {
    return null
  }
}

function normalizeAnthropicModelAccessError(error: unknown, modelId: string): Error | null {
  if (!error || typeof error !== 'object') return null
  const maybe = error as Record<string, unknown>
  const statusCode = typeof maybe.statusCode === 'number' ? maybe.statusCode : null
  const responseBody = typeof maybe.responseBody === 'string' ? maybe.responseBody : null
  const payload = responseBody ? parseAnthropicErrorPayload(responseBody) : null
  const payloadType = payload?.type ?? null
  const payloadMessage = payload?.message ?? null
  const message = typeof maybe.message === 'string' ? maybe.message : ''
  const combinedMessage = (payloadMessage ?? message).trim()

  const hasModelMessage = /^model:\s*\S+/i.test(combinedMessage)
  const isAccessStatus = statusCode === 401 || statusCode === 403 || statusCode === 404
  const isAccessType =
    payloadType === 'not_found_error' ||
    payloadType === 'permission_error' ||
    payloadType === 'authentication_error'

  if (!hasModelMessage && !isAccessStatus && !isAccessType) return null

  const modelLabel = hasModelMessage ? combinedMessage.replace(/^model:\s*/i, '').trim() : modelId
  const hint = `Anthropic API rejected model "${modelLabel}". Your ANTHROPIC_API_KEY likely lacks access to this model or it is unavailable for your account. Try another anthropic/... model or request access.`
  return new Error(hint, { cause: error instanceof Error ? error : undefined })
}

function normalizeTokenUsage(raw: unknown): LlmTokenUsage | null {
  if (!raw || typeof raw !== 'object') return null
  const usage = raw as { input?: unknown; output?: unknown; totalTokens?: unknown }

  const promptTokens =
    typeof usage.input === 'number' && Number.isFinite(usage.input) ? usage.input : null
  const completionTokens =
    typeof usage.output === 'number' && Number.isFinite(usage.output) ? usage.output : null
  const totalTokens =
    typeof usage.totalTokens === 'number' && Number.isFinite(usage.totalTokens)
      ? usage.totalTokens
      : null

  if (promptTokens === null && completionTokens === null && totalTokens === null) return null
  return { promptTokens, completionTokens, totalTokens }
}

function resolveBaseUrlOverride(raw: string | null | undefined): string | null {
  const trimmed = typeof raw === 'string' ? raw.trim() : ''
  return trimmed.length > 0 ? trimmed : null
}

function resolveOpenAiClientConfig({
  apiKeys,
  forceOpenRouter,
  openaiBaseUrlOverride,
  forceChatCompletions,
}: {
  apiKeys: LlmApiKeys
  forceOpenRouter?: boolean
  openaiBaseUrlOverride?: string | null
  forceChatCompletions?: boolean
}): OpenAiClientConfig {
  const baseUrlRaw =
    openaiBaseUrlOverride ??
    (typeof process !== 'undefined' ? process.env.OPENAI_BASE_URL : undefined)
  const baseUrl =
    typeof baseUrlRaw === 'string' && baseUrlRaw.trim().length > 0 ? baseUrlRaw.trim() : null
  const isOpenRouterViaBaseUrl = baseUrl ? /openrouter\.ai/i.test(baseUrl) : false
  const hasOpenRouterKey = apiKeys.openrouterApiKey != null
  const hasOpenAiKey = apiKeys.openaiApiKey != null
  const isOpenRouter =
    Boolean(forceOpenRouter) ||
    isOpenRouterViaBaseUrl ||
    (hasOpenRouterKey && !baseUrl && !hasOpenAiKey)

  const apiKey = isOpenRouter
    ? (apiKeys.openrouterApiKey ?? apiKeys.openaiApiKey)
    : apiKeys.openaiApiKey
  if (!apiKey) {
    throw new Error(
      isOpenRouter
        ? 'Missing OPENROUTER_API_KEY (or OPENAI_API_KEY) for OpenRouter'
        : 'Missing OPENAI_API_KEY for openai/... model'
    )
  }

  const baseURL = forceOpenRouter
    ? 'https://openrouter.ai/api/v1'
    : (baseUrl ?? (isOpenRouter ? 'https://openrouter.ai/api/v1' : undefined))

  const isCustomBaseURL = (() => {
    if (!baseURL) return false
    try {
      const url = new URL(baseURL)
      return url.host !== 'api.openai.com' && url.host !== 'openrouter.ai'
    } catch {
      return false
    }
  })()

  const useChatCompletions = Boolean(forceChatCompletions) || isOpenRouter || isCustomBaseURL
  return {
    apiKey,
    baseURL: baseURL ?? undefined,
    useChatCompletions,
    isOpenRouter,
  }
}

function promptToContext({ system, prompt }: { system?: string; prompt: PromptPayload }): Context {
  if (isDocumentPrompt(prompt)) {
    throw new Error('Internal error: document prompt cannot be converted to context.')
  }
  const messages: Message[] =
    typeof prompt === 'string'
      ? [{ role: 'user', content: prompt, timestamp: Date.now() }]
      : prompt.map((msg) =>
          typeof (msg as { timestamp?: unknown }).timestamp === 'number'
            ? msg
            : ({ ...msg, timestamp: Date.now() } as Message)
        )

  return { systemPrompt: system, messages }
}

function extractText(message: AssistantMessage): string {
  const text = message.content
    .filter((c) => c.type === 'text')
    .map((c) => c.text)
    .join('')
  return text.trim()
}

function bytesToBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64')
}

function createUnsupportedFunctionalityError(message: string): Error {
  const error = new Error(`Functionality not supported: ${message}`)
  error.name = 'UnsupportedFunctionalityError'
  return error
}

function normalizeAnthropicUsage(raw: unknown): LlmTokenUsage | null {
  if (!raw || typeof raw !== 'object') return null
  const usage = raw as { input_tokens?: unknown; output_tokens?: unknown }
  const promptTokens =
    typeof usage.input_tokens === 'number' && Number.isFinite(usage.input_tokens)
      ? usage.input_tokens
      : null
  const completionTokens =
    typeof usage.output_tokens === 'number' && Number.isFinite(usage.output_tokens)
      ? usage.output_tokens
      : null
  const totalTokens =
    typeof promptTokens === 'number' && typeof completionTokens === 'number'
      ? promptTokens + completionTokens
      : null
  if (promptTokens === null && completionTokens === null && totalTokens === null) return null
  return { promptTokens, completionTokens, totalTokens }
}

async function completeAnthropicDocument({
  modelId,
  apiKey,
  prompt,
  system,
  maxOutputTokens,
  timeoutMs,
  fetchImpl,
  anthropicBaseUrlOverride,
}: {
  modelId: string
  apiKey: string
  prompt: DocumentPrompt
  system?: string
  maxOutputTokens?: number
  timeoutMs: number
  fetchImpl: typeof fetch
  anthropicBaseUrlOverride?: string | null
}): Promise<{ text: string; usage: LlmTokenUsage | null }> {
  const baseUrl = resolveBaseUrlOverride(anthropicBaseUrlOverride) ?? 'https://api.anthropic.com'
  const url = new URL('/v1/messages', baseUrl)
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), timeoutMs)
  const payload = {
    model: modelId,
    max_tokens: maxOutputTokens ?? 4096,
    ...(system ? { system } : {}),
    messages: [
      {
        role: 'user',
        content: [
          {
            type: 'document',
            source: {
              type: 'base64',
              media_type: prompt.document.mediaType,
              data: bytesToBase64(prompt.document.bytes),
            },
          },
          { type: 'text', text: prompt.text },
        ],
      },
    ],
  }

  try {
    const response = await fetchImpl(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    })

    const bodyText = await response.text()
    if (!response.ok) {
      const error = new Error(`Anthropic API error (${response.status}).`)
      ;(error as { statusCode?: number }).statusCode = response.status
      ;(error as { responseBody?: string }).responseBody = bodyText
      throw error
    }

    const data = JSON.parse(bodyText) as {
      content?: Array<{ type?: string; text?: string }>
      usage?: unknown
    }
    const text = Array.isArray(data.content)
      ? data.content
          .filter((block) => block.type === 'text' && typeof block.text === 'string')
          .map((block) => block.text)
          .join('')
          .trim()
      : ''
    if (!text) {
      throw new Error(`LLM returned an empty summary (model anthropic/${modelId}).`)
    }
    return { text, usage: normalizeAnthropicUsage(data.usage) }
  } finally {
    clearTimeout(timeout)
  }
}

function normalizeOpenAiUsage(raw: unknown): LlmTokenUsage | null {
  if (!raw || typeof raw !== 'object') return null
  const usage = raw as { input_tokens?: unknown; output_tokens?: unknown; total_tokens?: unknown }
  const promptTokens =
    typeof usage.input_tokens === 'number' && Number.isFinite(usage.input_tokens)
      ? usage.input_tokens
      : null
  const completionTokens =
    typeof usage.output_tokens === 'number' && Number.isFinite(usage.output_tokens)
      ? usage.output_tokens
      : null
  const totalTokens =
    typeof usage.total_tokens === 'number' && Number.isFinite(usage.total_tokens)
      ? usage.total_tokens
      : typeof promptTokens === 'number' && typeof completionTokens === 'number'
        ? promptTokens + completionTokens
        : null
  if (promptTokens === null && completionTokens === null && totalTokens === null) return null
  return { promptTokens, completionTokens, totalTokens }
}

function resolveOpenAiResponsesUrl(baseUrl: string): URL {
  const url = new URL(baseUrl)
  const path = url.pathname.replace(/\/$/, '')
  if (/\/responses$/.test(path)) {
    url.pathname = path
    return url
  }
  if (/\/v1$/.test(path)) {
    url.pathname = `${path}/responses`
    return url
  }
  url.pathname = `${path}/v1/responses`
  return url
}

function extractOpenAiResponseText(payload: {
  output_text?: unknown
  output?: Array<{ content?: Array<{ text?: string }> }>
}): string {
  if (typeof payload.output_text === 'string') return payload.output_text.trim()
  const output = Array.isArray(payload.output) ? payload.output : []
  const text = output
    .flatMap((item) => (Array.isArray(item.content) ? item.content : []))
    .map((block) => (typeof block.text === 'string' ? block.text : ''))
    .join('')
    .trim()
  return text
}

async function completeOpenAiDocument({
  modelId,
  apiKey,
  prompt,
  maxOutputTokens,
  temperature,
  timeoutMs,
  fetchImpl,
  baseUrl,
}: {
  modelId: string
  apiKey: string
  prompt: DocumentPrompt
  maxOutputTokens?: number
  temperature?: number
  timeoutMs: number
  fetchImpl: typeof fetch
  baseUrl: string
}): Promise<{ text: string; usage: LlmTokenUsage | null }> {
  const url = resolveOpenAiResponsesUrl(baseUrl)
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), timeoutMs)
  const filename = prompt.document.filename?.trim() || 'document.pdf'
  const payload = {
    model: modelId,
    input: [
      {
        role: 'user',
        content: [
          {
            type: 'input_file',
            filename,
            file_data: bytesToBase64(prompt.document.bytes),
          },
          { type: 'input_text', text: prompt.text },
        ],
      },
    ],
    ...(typeof maxOutputTokens === 'number' ? { max_output_tokens: maxOutputTokens } : {}),
    ...(typeof temperature === 'number' ? { temperature } : {}),
  }

  try {
    const response = await fetchImpl(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    })

    const bodyText = await response.text()
    if (!response.ok) {
      const error = new Error(`OpenAI API error (${response.status}).`)
      ;(error as { statusCode?: number }).statusCode = response.status
      ;(error as { responseBody?: string }).responseBody = bodyText
      throw error
    }

    const data = JSON.parse(bodyText) as {
      output_text?: unknown
      output?: Array<{ content?: Array<{ text?: string }> }>
      usage?: unknown
    }
    const text = extractOpenAiResponseText(data)
    if (!text) {
      throw new Error(`LLM returned an empty summary (model openai/${modelId}).`)
    }
    return { text, usage: normalizeOpenAiUsage(data.usage) }
  } finally {
    clearTimeout(timeout)
  }
}

function normalizeGoogleUsage(raw: unknown): LlmTokenUsage | null {
  if (!raw || typeof raw !== 'object') return null
  const usage = raw as {
    promptTokenCount?: unknown
    candidatesTokenCount?: unknown
    totalTokenCount?: unknown
  }
  const promptTokens =
    typeof usage.promptTokenCount === 'number' && Number.isFinite(usage.promptTokenCount)
      ? usage.promptTokenCount
      : null
  const completionTokens =
    typeof usage.candidatesTokenCount === 'number' &&
    Number.isFinite(usage.candidatesTokenCount)
      ? usage.candidatesTokenCount
      : null
  const totalTokens =
    typeof usage.totalTokenCount === 'number' && Number.isFinite(usage.totalTokenCount)
      ? usage.totalTokenCount
      : typeof promptTokens === 'number' && typeof completionTokens === 'number'
        ? promptTokens + completionTokens
        : null
  if (promptTokens === null && completionTokens === null && totalTokens === null) return null
  return { promptTokens, completionTokens, totalTokens }
}

async function completeGoogleDocument({
  modelId,
  apiKey,
  prompt,
  maxOutputTokens,
  temperature,
  timeoutMs,
  fetchImpl,
  googleBaseUrlOverride,
}: {
  modelId: string
  apiKey: string
  prompt: DocumentPrompt
  maxOutputTokens?: number
  temperature?: number
  timeoutMs: number
  fetchImpl: typeof fetch
  googleBaseUrlOverride?: string | null
}): Promise<{ text: string; usage: LlmTokenUsage | null }> {
  const baseUrl =
    resolveBaseUrlOverride(googleBaseUrlOverride) ??
    'https://generativelanguage.googleapis.com/v1beta'
  const url = new URL(`${baseUrl.replace(/\/$/, '')}/models/${modelId}:generateContent`)
  url.searchParams.set('key', apiKey)

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), timeoutMs)
  const payload = {
    contents: [
      {
        parts: [
          {
            inline_data: {
              mime_type: prompt.document.mediaType,
              data: bytesToBase64(prompt.document.bytes),
            },
          },
          { text: prompt.text },
        ],
      },
    ],
    ...(typeof maxOutputTokens === 'number' ? { maxOutputTokens } : {}),
    ...(typeof temperature === 'number' ? { temperature } : {}),
  }

  try {
    const response = await fetchImpl(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      signal: controller.signal,
    })

    const bodyText = await response.text()
    if (!response.ok) {
      const error = new Error(`Google API error (${response.status}).`)
      ;(error as { statusCode?: number }).statusCode = response.status
      ;(error as { responseBody?: string }).responseBody = bodyText
      throw error
    }

    const data = JSON.parse(bodyText) as {
      candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>
      usageMetadata?: unknown
    }
    const text = (data.candidates ?? [])
      .flatMap((candidate) => candidate.content?.parts ?? [])
      .map((part) => (typeof part.text === 'string' ? part.text : ''))
      .join('')
      .trim()
    if (!text) {
      throw new Error(`LLM returned an empty summary (model google/${modelId}).`)
    }
    return { text, usage: normalizeGoogleUsage(data.usageMetadata) }
  } finally {
    clearTimeout(timeout)
  }
}

function wantsImages(context: Context): boolean {
  for (const msg of context.messages) {
    if (msg.role === 'user' || msg.role === 'toolResult') {
      if (Array.isArray(msg.content) && msg.content.some((c) => c.type === 'image')) return true
    }
  }
  return false
}

function tryGetModel(provider: KnownProvider, modelId: string): Model<Api> | null {
  try {
    return getModel(provider, modelId as never) as unknown as Model<Api>
  } catch {
    return null
  }
}

function createSyntheticModel({
  provider,
  modelId,
  api,
  baseUrl,
  allowImages,
  headers,
}: {
  provider: KnownProvider
  modelId: string
  api: Model<Api>['api']
  baseUrl: string
  allowImages: boolean
  headers?: Record<string, string>
}): Model<Api> {
  return {
    id: modelId,
    name: `${provider}/${modelId}`,
    api,
    provider,
    baseUrl,
    reasoning: false,
    input: allowImages ? ['text', 'image'] : ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128_000,
    maxTokens: 16_384,
    ...(headers ? { headers } : {}),
  }
}

function resolveModelForCall({
  modelId,
  parsedProvider,
  openaiConfig,
  context,
  openaiBaseUrlOverride,
  anthropicBaseUrlOverride,
  googleBaseUrlOverride,
  xaiBaseUrlOverride,
}: {
  modelId: string
  parsedProvider: 'xai' | 'openai' | 'google' | 'anthropic' | 'zai'
  openaiConfig: OpenAiClientConfig | null
  context: Context
  openaiBaseUrlOverride?: string | null
  anthropicBaseUrlOverride?: string | null
  googleBaseUrlOverride?: string | null
  xaiBaseUrlOverride?: string | null
}): Model<Api> {
  const allowImages = wantsImages(context)

  if (parsedProvider === 'openai') {
    const base = tryGetModel('openai', modelId)
    const api = openaiConfig?.useChatCompletions ? 'openai-completions' : 'openai-responses'
    const baseUrl = openaiConfig?.baseURL ?? base?.baseUrl ?? 'https://api.openai.com/v1'
    const headers = openaiConfig?.isOpenRouter
      ? {
          ...(base?.headers ?? {}),
          'HTTP-Referer': 'https://github.com/steipete/summarize',
          'X-Title': 'summarize',
        }
      : base?.headers
    return {
      ...(base ?? createSyntheticModel({ provider: 'openai', modelId, api, baseUrl, allowImages })),
      api,
      baseUrl,
      ...(headers ? { headers } : {}),
    }
  }

  if (parsedProvider === 'zai') {
    const base = tryGetModel('zai', modelId)
    const api = 'openai-completions'
    const baseUrl =
      openaiBaseUrlOverride ??
      base?.baseUrl ??
      openaiConfig?.baseURL ??
      'https://api.z.ai/api/paas/v4'
    return {
      ...(base ?? createSyntheticModel({ provider: 'zai', modelId, api, baseUrl, allowImages })),
      api,
      baseUrl,
      input: allowImages ? ['text', 'image'] : ['text'],
    }
  }

  if (parsedProvider === 'xai') {
    const base = tryGetModel('xai', modelId)
    const override = resolveBaseUrlOverride(xaiBaseUrlOverride)
    if (override) {
      return {
        ...(base ??
          createSyntheticModel({
            provider: 'xai',
            modelId,
            api: 'openai-completions',
            baseUrl: override,
            allowImages,
          })),
        baseUrl: override,
      }
    }
    return (
      base ??
      createSyntheticModel({
        provider: 'xai',
        modelId,
        api: 'openai-completions',
        baseUrl: 'https://api.x.ai/v1',
        allowImages,
      })
    )
  }

  if (parsedProvider === 'google') {
    const base = tryGetModel('google', modelId)
    const override = resolveBaseUrlOverride(googleBaseUrlOverride)
    if (override) {
      return {
        ...(base ??
          createSyntheticModel({
            provider: 'google',
            modelId,
            api: 'google-generative-ai',
            baseUrl: override,
            allowImages,
          })),
        baseUrl: override,
      }
    }
    return (
      base ??
      createSyntheticModel({
        provider: 'google',
        modelId,
        api: 'google-generative-ai',
        baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
        allowImages,
      })
    )
  }

  const base = tryGetModel('anthropic', modelId)
  const override = resolveBaseUrlOverride(anthropicBaseUrlOverride)
  if (override) {
    return {
      ...(base ??
        createSyntheticModel({
          provider: 'anthropic',
          modelId,
          api: 'anthropic-messages',
          baseUrl: override,
          allowImages,
        })),
      baseUrl: override,
    }
  }
  return (
    base ??
    createSyntheticModel({
      provider: 'anthropic',
      modelId,
      api: 'anthropic-messages',
      baseUrl: 'https://api.anthropic.com',
      allowImages,
    })
  )
}

export async function generateTextWithModelId({
  modelId,
  apiKeys,
  system,
  prompt,
  temperature,
  maxOutputTokens,
  timeoutMs,
  fetchImpl,
  forceOpenRouter,
  openaiBaseUrlOverride,
  anthropicBaseUrlOverride,
  googleBaseUrlOverride,
  xaiBaseUrlOverride,
  forceChatCompletions,
  retries = 0,
  onRetry,
}: {
  modelId: string
  apiKeys: LlmApiKeys
  system?: string
  prompt: PromptPayload
  temperature?: number
  maxOutputTokens?: number
  timeoutMs: number
  fetchImpl: typeof fetch
  forceOpenRouter?: boolean
  openaiBaseUrlOverride?: string | null
  anthropicBaseUrlOverride?: string | null
  googleBaseUrlOverride?: string | null
  xaiBaseUrlOverride?: string | null
  forceChatCompletions?: boolean
  retries?: number
  onRetry?: (notice: RetryNotice) => void
}): Promise<{
  text: string
  canonicalModelId: string
  provider: 'xai' | 'openai' | 'google' | 'anthropic' | 'zai'
  usage: LlmTokenUsage | null
}> {
  const parsed = parseGatewayStyleModelId(modelId)
  const isOpenaiGpt5 = parsed.provider === 'openai' && /^gpt-5([-.].+)?$/i.test(parsed.model)
  const effectiveTemperature =
    typeof temperature === 'number' && !(isOpenaiGpt5 && temperature === 0)
      ? temperature
      : undefined

  if (isDocumentPrompt(prompt)) {
    if (parsed.provider === 'anthropic') {
      const apiKey = apiKeys.anthropicApiKey
      if (!apiKey) throw new Error('Missing ANTHROPIC_API_KEY for anthropic/... model')
      try {
        const result = await completeAnthropicDocument({
          modelId: parsed.model,
          apiKey,
          prompt,
          system,
          maxOutputTokens,
          timeoutMs,
          fetchImpl,
          anthropicBaseUrlOverride,
        })
        return {
          text: result.text,
          canonicalModelId: parsed.canonical,
          provider: parsed.provider,
          usage: result.usage,
        }
      } catch (error) {
        const normalized = normalizeAnthropicModelAccessError(error, parsed.model)
        if (normalized) throw normalized
        throw error
      }
    }

    if (parsed.provider === 'openai') {
      const openaiConfig = resolveOpenAiClientConfig({
        apiKeys,
        forceOpenRouter,
        openaiBaseUrlOverride,
        forceChatCompletions,
      })
      if (openaiConfig.isOpenRouter) {
        throw createUnsupportedFunctionalityError(
          'OpenRouter does not support PDF attachments for openai/... models'
        )
      }
      const baseUrl = openaiConfig.baseURL ?? 'https://api.openai.com/v1'
      const host = new URL(baseUrl).host
      if (host !== 'api.openai.com') {
        throw createUnsupportedFunctionalityError(
          `Document attachments require api.openai.com; got ${host}`
        )
      }
      const result = await completeOpenAiDocument({
        modelId: parsed.model,
        apiKey: openaiConfig.apiKey,
        prompt,
        maxOutputTokens,
        temperature: effectiveTemperature,
        timeoutMs,
        fetchImpl,
        baseUrl,
      })
      return {
        text: result.text,
        canonicalModelId: parsed.canonical,
        provider: parsed.provider,
        usage: result.usage,
      }
    }

    if (parsed.provider === 'google') {
      const apiKey = apiKeys.googleApiKey
      if (!apiKey)
        throw new Error(
          'Missing GEMINI_API_KEY (or GOOGLE_GENERATIVE_AI_API_KEY / GOOGLE_API_KEY) for google/... model'
        )
      const result = await completeGoogleDocument({
        modelId: parsed.model,
        apiKey,
        prompt,
        maxOutputTokens,
        temperature: effectiveTemperature,
        timeoutMs,
        fetchImpl,
        googleBaseUrlOverride,
      })
      return {
        text: result.text,
        canonicalModelId: parsed.canonical,
        provider: parsed.provider,
        usage: result.usage,
      }
    }

    throw createUnsupportedFunctionalityError(
      `document attachments are not supported for ${parsed.provider}/... models`
    )
  }

  const context = promptToContext({ system, prompt })

  const maxRetries = Math.max(0, retries)
  let attempt = 0

  while (attempt <= maxRetries) {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), timeoutMs)
    try {
      if (parsed.provider === 'xai') {
        const apiKey = apiKeys.xaiApiKey
        if (!apiKey) throw new Error('Missing XAI_API_KEY for xai/... model')
        const model = resolveModelForCall({
          modelId: parsed.model,
          parsedProvider: parsed.provider,
          openaiConfig: null,
          context,
          xaiBaseUrlOverride,
        })
        const result = await completeSimple(model, context, {
          ...(typeof effectiveTemperature === 'number'
            ? { temperature: effectiveTemperature }
            : {}),
          ...(typeof maxOutputTokens === 'number' ? { maxTokens: maxOutputTokens } : {}),
          apiKey,
          signal: controller.signal,
        })
        const text = extractText(result)
        if (!text) throw new Error(`LLM returned an empty summary (model ${parsed.canonical}).`)
        return {
          text,
          canonicalModelId: parsed.canonical,
          provider: parsed.provider,
          usage: normalizeTokenUsage(result.usage),
        }
      }

      if (parsed.provider === 'google') {
        const apiKey = apiKeys.googleApiKey
        if (!apiKey)
          throw new Error(
            'Missing GEMINI_API_KEY (or GOOGLE_GENERATIVE_AI_API_KEY / GOOGLE_API_KEY) for google/... model'
          )
        const model = resolveModelForCall({
          modelId: parsed.model,
          parsedProvider: parsed.provider,
          openaiConfig: null,
          context,
          googleBaseUrlOverride,
        })
        const result = await completeSimple(model, context, {
          ...(typeof effectiveTemperature === 'number'
            ? { temperature: effectiveTemperature }
            : {}),
          ...(typeof maxOutputTokens === 'number' ? { maxTokens: maxOutputTokens } : {}),
          apiKey,
          signal: controller.signal,
        })
        const text = extractText(result)
        if (!text) throw new Error(`LLM returned an empty summary (model ${parsed.canonical}).`)
        return {
          text,
          canonicalModelId: parsed.canonical,
          provider: parsed.provider,
          usage: normalizeTokenUsage(result.usage),
        }
      }

      if (parsed.provider === 'anthropic') {
        const apiKey = apiKeys.anthropicApiKey
        if (!apiKey) throw new Error('Missing ANTHROPIC_API_KEY for anthropic/... model')
        const model = resolveModelForCall({
          modelId: parsed.model,
          parsedProvider: parsed.provider,
          openaiConfig: null,
          context,
          anthropicBaseUrlOverride,
        })
        const result = await completeSimple(model, context, {
          ...(typeof effectiveTemperature === 'number'
            ? { temperature: effectiveTemperature }
            : {}),
          ...(typeof maxOutputTokens === 'number' ? { maxTokens: maxOutputTokens } : {}),
          apiKey,
          signal: controller.signal,
        })
        const text = extractText(result)
        if (!text) throw new Error(`LLM returned an empty summary (model ${parsed.canonical}).`)
        return {
          text,
          canonicalModelId: parsed.canonical,
          provider: parsed.provider,
          usage: normalizeTokenUsage(result.usage),
        }
      }

      const openaiConfig =
        parsed.provider === 'openai'
          ? resolveOpenAiClientConfig({
              apiKeys,
              forceOpenRouter,
              openaiBaseUrlOverride,
              forceChatCompletions,
            })
          : null

      if (parsed.provider === 'zai') {
        const apiKey = apiKeys.openaiApiKey
        if (!apiKey) throw new Error('Missing Z_AI_API_KEY for zai/... model')
        const model = resolveModelForCall({
          modelId: parsed.model,
          parsedProvider: parsed.provider,
          openaiConfig: null,
          context,
          openaiBaseUrlOverride,
        })
        const result = await completeSimple(model, context, {
          ...(typeof effectiveTemperature === 'number'
            ? { temperature: effectiveTemperature }
            : {}),
          ...(typeof maxOutputTokens === 'number' ? { maxTokens: maxOutputTokens } : {}),
          apiKey,
          signal: controller.signal,
        })
        const text = extractText(result)
        if (!text) throw new Error(`LLM returned an empty summary (model ${parsed.canonical}).`)
        return {
          text,
          canonicalModelId: parsed.canonical,
          provider: parsed.provider,
          usage: normalizeTokenUsage(result.usage),
        }
      }

      const model = resolveModelForCall({
        modelId: parsed.model,
        parsedProvider: parsed.provider,
        openaiConfig,
        context,
        openaiBaseUrlOverride,
        anthropicBaseUrlOverride,
        googleBaseUrlOverride,
        xaiBaseUrlOverride,
      })

      const result = await completeSimple(model, context, {
        ...(typeof effectiveTemperature === 'number' ? { temperature: effectiveTemperature } : {}),
        ...(typeof maxOutputTokens === 'number' ? { maxTokens: maxOutputTokens } : {}),
        apiKey: openaiConfig?.apiKey ?? apiKeys.openaiApiKey ?? undefined,
        signal: controller.signal,
      })

      const text = extractText(result)
      if (!text) throw new Error(`LLM returned an empty summary (model ${parsed.canonical}).`)
      return {
        text,
        canonicalModelId: parsed.canonical,
        provider: parsed.provider,
        usage: normalizeTokenUsage(result.usage),
      }
    } catch (error) {
      const normalizedError =
        error instanceof DOMException && error.name === 'AbortError'
          ? new Error(`LLM request timed out after ${timeoutMs}ms (model ${parsed.canonical}).`)
          : error
      if (parsed.provider === 'anthropic') {
        const normalized = normalizeAnthropicModelAccessError(normalizedError, parsed.model)
        if (normalized) throw normalized
      }
      if (isRetryableTimeoutError(normalizedError) && attempt < maxRetries) {
        const delayMs = computeRetryDelayMs(attempt)
        onRetry?.({ attempt: attempt + 1, maxRetries, delayMs, error: normalizedError })
        await sleep(delayMs)
        attempt += 1
        continue
      }
      throw normalizedError
    } finally {
      clearTimeout(timeout)
    }
  }

  throw new Error(`LLM request failed after ${maxRetries + 1} attempts.`)
}

function isRetryableTimeoutError(error: unknown): boolean {
  if (!error) return false
  const message =
    typeof error === 'string'
      ? error
      : error instanceof Error
        ? error.message
        : typeof (error as { message?: unknown }).message === 'string'
          ? String((error as { message?: unknown }).message)
          : ''
  return /timed out/i.test(message) || /empty summary/i.test(message)
}

function computeRetryDelayMs(attempt: number): number {
  const base = 500
  const jitter = Math.floor(Math.random() * 200)
  return Math.min(2000, base * (attempt + 1) + jitter)
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export async function streamTextWithModelId({
  modelId,
  apiKeys,
  system,
  prompt,
  temperature,
  maxOutputTokens,
  timeoutMs,
  fetchImpl,
  forceOpenRouter,
  openaiBaseUrlOverride,
  anthropicBaseUrlOverride,
  googleBaseUrlOverride,
  xaiBaseUrlOverride,
  forceChatCompletions,
}: {
  modelId: string
  apiKeys: LlmApiKeys
  system?: string
  prompt: PromptPayload
  temperature?: number
  maxOutputTokens?: number
  timeoutMs: number
  fetchImpl: typeof fetch
  forceOpenRouter?: boolean
  openaiBaseUrlOverride?: string | null
  anthropicBaseUrlOverride?: string | null
  googleBaseUrlOverride?: string | null
  xaiBaseUrlOverride?: string | null
  forceChatCompletions?: boolean
}): Promise<{
  textStream: AsyncIterable<string>
  canonicalModelId: string
  provider: 'xai' | 'openai' | 'google' | 'anthropic' | 'zai'
  usage: Promise<LlmTokenUsage | null>
  lastError: () => unknown
}> {
  const parsed = parseGatewayStyleModelId(modelId)
  if (isDocumentPrompt(prompt)) {
    void fetchImpl
    throw createUnsupportedFunctionalityError(
      'streaming document attachments is not supported yet; disable streaming.'
    )
  }
  const context = promptToContext({ system, prompt })

  const controller = new AbortController()
  let timeoutId: ReturnType<typeof setTimeout> | null = null
  const startedAtMs = Date.now()
  let lastError: unknown = null
  const timeoutError = new Error('LLM request timed out')
  const markTimedOut = () => {
    if (lastError === timeoutError) return
    lastError = timeoutError
    controller.abort()
  }

  const startTimeout = () => {
    if (timeoutId) return
    timeoutId = setTimeout(markTimedOut, timeoutMs)
  }

  const stopTimeout = () => {
    if (!timeoutId) return
    clearTimeout(timeoutId)
    timeoutId = null
  }

  const nextWithDeadline = async <T>(promise: Promise<T>): Promise<T> => {
    const elapsed = Date.now() - startedAtMs
    const remaining = timeoutMs - elapsed
    if (remaining <= 0) {
      markTimedOut()
      throw timeoutError
    }
    let timer: ReturnType<typeof setTimeout> | null = null
    try {
      return await Promise.race([
        promise,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            markTimedOut()
            reject(timeoutError)
          }, remaining)
        }),
      ])
    } finally {
      if (timer) clearTimeout(timer)
    }
  }

  const wrapTextStream = (textStream: AsyncIterable<string>): AsyncIterable<string> => ({
    async *[Symbol.asyncIterator]() {
      startTimeout()
      const iterator = textStream[Symbol.asyncIterator]()
      try {
        while (true) {
          const result = await nextWithDeadline(iterator.next())
          if (result.done) break
          yield result.value
        }
      } finally {
        stopTimeout()
        if (typeof iterator.return === 'function') {
          const cleanup = iterator.return()
          const cleanupPromise =
            typeof cleanup === 'undefined' ? undefined : (cleanup as Promise<unknown>)
          if (typeof cleanupPromise?.catch === 'function') {
            void cleanupPromise.catch(() => {})
          }
        }
      }
    },
  })

  try {
    if (parsed.provider === 'xai') {
      const apiKey = apiKeys.xaiApiKey
      if (!apiKey) throw new Error('Missing XAI_API_KEY for xai/... model')
      const model = resolveModelForCall({
        modelId: parsed.model,
        parsedProvider: parsed.provider,
        openaiConfig: null,
        context,
        xaiBaseUrlOverride,
      })
      const stream = streamSimple(model, context, {
        ...(typeof temperature === 'number' ? { temperature } : {}),
        ...(typeof maxOutputTokens === 'number' ? { maxTokens: maxOutputTokens } : {}),
        apiKey,
        signal: controller.signal,
      })

      const textStream: AsyncIterable<string> = {
        async *[Symbol.asyncIterator]() {
          for await (const event of stream) {
            if (event.type === 'text_delta') yield event.delta
            if (event.type === 'error') {
              lastError = event.error
              break
            }
          }
        },
      }
      return {
        textStream: wrapTextStream(textStream),
        canonicalModelId: parsed.canonical,
        provider: parsed.provider,
        usage: stream
          .result()
          .then((msg) => normalizeTokenUsage(msg.usage))
          .catch(() => null),
        lastError: () => lastError,
      }
    }

    if (parsed.provider === 'google') {
      const apiKey = apiKeys.googleApiKey
      if (!apiKey)
        throw new Error(
          'Missing GEMINI_API_KEY (or GOOGLE_GENERATIVE_AI_API_KEY / GOOGLE_API_KEY) for google/... model'
        )
      const model = resolveModelForCall({
        modelId: parsed.model,
        parsedProvider: parsed.provider,
        openaiConfig: null,
        context,
        googleBaseUrlOverride,
      })
      const stream = streamSimple(model, context, {
        ...(typeof temperature === 'number' ? { temperature } : {}),
        ...(typeof maxOutputTokens === 'number' ? { maxTokens: maxOutputTokens } : {}),
        apiKey,
        signal: controller.signal,
      })

      const textStream: AsyncIterable<string> = {
        async *[Symbol.asyncIterator]() {
          for await (const event of stream) {
            if (event.type === 'text_delta') yield event.delta
            if (event.type === 'error') {
              lastError = event.error
              break
            }
          }
        },
      }
      return {
        textStream: wrapTextStream(textStream),
        canonicalModelId: parsed.canonical,
        provider: parsed.provider,
        usage: stream
          .result()
          .then((msg) => normalizeTokenUsage(msg.usage))
          .catch(() => null),
        lastError: () => lastError,
      }
    }

    if (parsed.provider === 'anthropic') {
      const apiKey = apiKeys.anthropicApiKey
      if (!apiKey) throw new Error('Missing ANTHROPIC_API_KEY for anthropic/... model')
      const model = resolveModelForCall({
        modelId: parsed.model,
        parsedProvider: parsed.provider,
        openaiConfig: null,
        context,
        anthropicBaseUrlOverride,
      })
      const stream = streamSimple(model, context, {
        ...(typeof temperature === 'number' ? { temperature } : {}),
        ...(typeof maxOutputTokens === 'number' ? { maxTokens: maxOutputTokens } : {}),
        apiKey,
        signal: controller.signal,
      })

      const textStream: AsyncIterable<string> = {
        async *[Symbol.asyncIterator]() {
          for await (const event of stream) {
            if (event.type === 'text_delta') yield event.delta
            if (event.type === 'error') {
              lastError =
                normalizeAnthropicModelAccessError(event.error, parsed.model) ?? event.error
              break
            }
          }
        },
      }
      return {
        textStream: wrapTextStream(textStream),
        canonicalModelId: parsed.canonical,
        provider: parsed.provider,
        usage: stream
          .result()
          .then((msg) => normalizeTokenUsage(msg.usage))
          .catch(() => null),
        lastError: () => lastError,
      }
    }

    if (parsed.provider === 'zai') {
      const apiKey = apiKeys.openaiApiKey
      if (!apiKey) throw new Error('Missing Z_AI_API_KEY for zai/... model')
      const model = resolveModelForCall({
        modelId: parsed.model,
        parsedProvider: parsed.provider,
        openaiConfig: null,
        context,
        openaiBaseUrlOverride,
      })
      const stream = streamSimple(model, context, {
        ...(typeof temperature === 'number' ? { temperature } : {}),
        ...(typeof maxOutputTokens === 'number' ? { maxTokens: maxOutputTokens } : {}),
        apiKey,
        signal: controller.signal,
      })
      const textStream: AsyncIterable<string> = {
        async *[Symbol.asyncIterator]() {
          for await (const event of stream) {
            if (event.type === 'text_delta') yield event.delta
            if (event.type === 'error') {
              lastError = event.error
              break
            }
          }
        },
      }
      return {
        textStream: wrapTextStream(textStream),
        canonicalModelId: parsed.canonical,
        provider: parsed.provider,
        usage: stream
          .result()
          .then((msg) => normalizeTokenUsage(msg.usage))
          .catch(() => null),
        lastError: () => lastError,
      }
    }

    const openaiConfig = resolveOpenAiClientConfig({
      apiKeys,
      forceOpenRouter,
      openaiBaseUrlOverride,
      forceChatCompletions,
    })
    const model = resolveModelForCall({
      modelId: parsed.model,
      parsedProvider: parsed.provider,
      openaiConfig,
      context,
      openaiBaseUrlOverride,
      anthropicBaseUrlOverride,
      googleBaseUrlOverride,
      xaiBaseUrlOverride,
    })
    const stream = streamSimple(model, context, {
      ...(typeof temperature === 'number' ? { temperature } : {}),
      ...(typeof maxOutputTokens === 'number' ? { maxTokens: maxOutputTokens } : {}),
      apiKey: openaiConfig.apiKey,
      signal: controller.signal,
    })

    const textStream: AsyncIterable<string> = {
      async *[Symbol.asyncIterator]() {
        for await (const event of stream) {
          if (event.type === 'text_delta') yield event.delta
          if (event.type === 'error') {
            lastError = event.error
            break
          }
        }
      },
    }
    return {
      textStream: wrapTextStream(textStream),
      canonicalModelId: parsed.canonical,
      provider: parsed.provider,
      usage: stream
        .result()
        .then((msg) => normalizeTokenUsage(msg.usage))
        .catch(() => null),
      lastError: () => lastError,
    }
  } catch (error) {
    if (parsed.provider === 'anthropic') {
      const normalized = normalizeAnthropicModelAccessError(error, parsed.model)
      if (normalized) throw normalized
    }
    if (error instanceof DOMException && error.name === 'AbortError') {
      throw new Error('LLM request timed out')
    }
    throw error
  } finally {
    stopTimeout()
  }
}
