import type { ModelMessage } from 'ai'
import { parseGatewayStyleModelId } from './model-id.js'

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
  const usage = raw as Record<string, unknown>

  const promptTokens =
    typeof usage.promptTokens === 'number' && Number.isFinite(usage.promptTokens)
      ? usage.promptTokens
      : typeof usage.inputTokens === 'number' && Number.isFinite(usage.inputTokens)
        ? usage.inputTokens
        : null
  const completionTokens =
    typeof usage.completionTokens === 'number' && Number.isFinite(usage.completionTokens)
      ? usage.completionTokens
      : typeof usage.outputTokens === 'number' && Number.isFinite(usage.outputTokens)
        ? usage.outputTokens
        : null
  const totalTokens =
    typeof usage.totalTokens === 'number' && Number.isFinite(usage.totalTokens)
      ? usage.totalTokens
      : null

  if (promptTokens === null && completionTokens === null && totalTokens === null) {
    return null
  }
  return { promptTokens, completionTokens, totalTokens }
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
  openrouter,
}: {
  modelId: string
  apiKeys: LlmApiKeys
  system?: string
  prompt: string | ModelMessage[]
  temperature?: number
  maxOutputTokens?: number
  timeoutMs: number
  fetchImpl: typeof fetch
  openrouter?: OpenRouterOptions
}): Promise<{
  text: string
  canonicalModelId: string
  provider: 'xai' | 'openai' | 'google' | 'anthropic'
  usage: LlmTokenUsage | null
}> {
  const parsed = parseGatewayStyleModelId(modelId)

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), timeoutMs)

  try {
    const { generateText } = await import('ai')

    if (parsed.provider === 'xai') {
      const apiKey = apiKeys.xaiApiKey
      if (!apiKey) throw new Error('Missing XAI_API_KEY for xai/... model')
      const { createXai } = await import('@ai-sdk/xai')
      const xai = createXai({ apiKey, fetch: fetchImpl })
      const result = await generateText({
        model: xai(parsed.model),
        system,
        ...(typeof prompt === 'string' ? { prompt } : { messages: prompt }),
        ...(typeof temperature === 'number' ? { temperature } : {}),
        ...(typeof maxOutputTokens === 'number' ? { maxOutputTokens } : {}),
        abortSignal: controller.signal,
      })
      return {
        text: result.text,
        canonicalModelId: parsed.canonical,
        provider: parsed.provider,
        usage: normalizeTokenUsage((result as unknown as { usage?: unknown }).usage),
      }
    }

    if (parsed.provider === 'google') {
      const apiKey = apiKeys.googleApiKey
      if (!apiKey)
        throw new Error(
          'Missing GEMINI_API_KEY (or GOOGLE_GENERATIVE_AI_API_KEY / GOOGLE_API_KEY) for google/... model'
        )
      const { createGoogleGenerativeAI } = await import('@ai-sdk/google')
      const google = createGoogleGenerativeAI({ apiKey, fetch: fetchImpl })
      const result = await generateText({
        model: google(parsed.model),
        system,
        ...(typeof prompt === 'string' ? { prompt } : { messages: prompt }),
        ...(typeof temperature === 'number' ? { temperature } : {}),
        ...(typeof maxOutputTokens === 'number' ? { maxOutputTokens } : {}),
        abortSignal: controller.signal,
      })
      return {
        text: result.text,
        canonicalModelId: parsed.canonical,
        provider: parsed.provider,
        usage: normalizeTokenUsage((result as unknown as { usage?: unknown }).usage),
      }
    }

    if (parsed.provider === 'anthropic') {
      const apiKey = apiKeys.anthropicApiKey
      if (!apiKey) throw new Error('Missing ANTHROPIC_API_KEY for anthropic/... model')
      const { createAnthropic } = await import('@ai-sdk/anthropic')
      const anthropic = createAnthropic({ apiKey, fetch: fetchImpl })
      const result = await generateText({
        model: anthropic(parsed.model),
        system,
        ...(typeof prompt === 'string' ? { prompt } : { messages: prompt }),
        ...(typeof temperature === 'number' ? { temperature } : {}),
        ...(typeof maxOutputTokens === 'number' ? { maxOutputTokens } : {}),
        abortSignal: controller.signal,
      })
      return {
        text: result.text,
        canonicalModelId: parsed.canonical,
        provider: parsed.provider,
        usage: normalizeTokenUsage((result as unknown as { usage?: unknown }).usage),
      }
    }

    // Detect OpenRouter: via OPENROUTER_API_KEY or OPENAI_BASE_URL containing openrouter.ai
    const baseUrl = typeof process !== 'undefined' ? process.env.OPENAI_BASE_URL : undefined
    const isOpenRouterViaBaseUrl =
      typeof baseUrl === 'string' && /openrouter\.ai/i.test(baseUrl) && baseUrl.length > 0
    const isOpenRouter = apiKeys.openrouterApiKey != null || isOpenRouterViaBaseUrl

    const apiKey = isOpenRouter
      ? (apiKeys.openrouterApiKey ?? apiKeys.openaiApiKey)
      : apiKeys.openaiApiKey
    if (!apiKey) {
      throw new Error(
        isOpenRouter
          ? 'Missing OPENROUTER_API_KEY for OpenRouter'
          : 'Missing OPENAI_API_KEY for openai/... model'
      )
    }

    const { createOpenAI } = await import('@ai-sdk/openai')

    // Build fetch wrapper with OpenRouter provider ordering header
    const openrouterProviders = openrouter?.providers
    const wrappedFetch: typeof fetch = isOpenRouter && openrouterProviders?.length
      ? (url, init) => {
          const headers = new Headers(init?.headers)
          headers.set('HTTP-Referer', 'https://github.com/steipete/summarize')
          headers.set('X-Title', 'summarize')
          headers.set('X-OpenRouter-Provider-Order', openrouterProviders.join(','))
          return fetchImpl(url, { ...init, headers })
        }
      : fetchImpl

    const openai = createOpenAI({
      apiKey,
      ...(isOpenRouter ? { baseURL: 'https://openrouter.ai/api/v1' } : {}),
      fetch: wrappedFetch,
    })

    // OpenRouter requires chat completions endpoint
    const useChatCompletions = isOpenRouter
    const responsesModelId = parsed.model as unknown as Parameters<typeof openai>[0]
    const chatModelId = parsed.model as unknown as Parameters<typeof openai.chat>[0]
    const result = await generateText({
      model: useChatCompletions ? openai.chat(chatModelId) : openai(responsesModelId),
      system,
      ...(typeof prompt === 'string' ? { prompt } : { messages: prompt }),
      ...(typeof temperature === 'number' ? { temperature } : {}),
      ...(typeof maxOutputTokens === 'number' ? { maxOutputTokens } : {}),
      abortSignal: controller.signal,
    })
    return {
      text: result.text,
      canonicalModelId: parsed.canonical,
      provider: parsed.provider,
      usage: normalizeTokenUsage((result as unknown as { usage?: unknown }).usage),
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
    clearTimeout(timeout)
  }
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
  openrouter,
}: {
  modelId: string
  apiKeys: LlmApiKeys
  system?: string
  prompt: string | ModelMessage[]
  temperature?: number
  maxOutputTokens?: number
  timeoutMs: number
  fetchImpl: typeof fetch
  openrouter?: OpenRouterOptions
}): Promise<{
  textStream: AsyncIterable<string>
  canonicalModelId: string
  provider: 'xai' | 'openai' | 'google' | 'anthropic'
  usage: Promise<LlmTokenUsage | null>
  lastError: () => unknown
}> {
  const parsed = parseGatewayStyleModelId(modelId)

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
          if (cleanup && typeof (cleanup as Promise<unknown>).catch === 'function') {
            ;(cleanup as Promise<unknown>).catch(() => {})
          }
        }
      }
    },
  })

  try {
    const { streamText } = await import('ai')
    const onError = ({ error }: { error: unknown }) => {
      if (parsed.provider === 'anthropic') {
        lastError = normalizeAnthropicModelAccessError(error, parsed.model) ?? error
        return
      }
      lastError = error
    }

    if (parsed.provider === 'xai') {
      const apiKey = apiKeys.xaiApiKey
      if (!apiKey) throw new Error('Missing XAI_API_KEY for xai/... model')
      const { createXai } = await import('@ai-sdk/xai')
      const xai = createXai({ apiKey, fetch: fetchImpl })
      const result = streamText({
        model: xai(parsed.model),
        system,
        ...(typeof prompt === 'string' ? { prompt } : { messages: prompt }),
        ...(typeof temperature === 'number' ? { temperature } : {}),
        ...(typeof maxOutputTokens === 'number' ? { maxOutputTokens } : {}),
        abortSignal: controller.signal,
        onError,
      })
      return {
        textStream: wrapTextStream(result.textStream),
        canonicalModelId: parsed.canonical,
        provider: parsed.provider,
        usage: result.totalUsage.then((raw) => normalizeTokenUsage(raw)).catch(() => null),
        lastError: () => lastError,
      }
    }

    if (parsed.provider === 'google') {
      const apiKey = apiKeys.googleApiKey
      if (!apiKey)
        throw new Error(
          'Missing GEMINI_API_KEY (or GOOGLE_GENERATIVE_AI_API_KEY / GOOGLE_API_KEY) for google/... model'
        )
      const { createGoogleGenerativeAI } = await import('@ai-sdk/google')
      const google = createGoogleGenerativeAI({ apiKey, fetch: fetchImpl })
      const result = streamText({
        model: google(parsed.model),
        system,
        ...(typeof prompt === 'string' ? { prompt } : { messages: prompt }),
        ...(typeof temperature === 'number' ? { temperature } : {}),
        ...(typeof maxOutputTokens === 'number' ? { maxOutputTokens } : {}),
        abortSignal: controller.signal,
        onError,
      })
      return {
        textStream: wrapTextStream(result.textStream),
        canonicalModelId: parsed.canonical,
        provider: parsed.provider,
        usage: result.totalUsage.then((raw) => normalizeTokenUsage(raw)).catch(() => null),
        lastError: () => lastError,
      }
    }

    if (parsed.provider === 'anthropic') {
      const apiKey = apiKeys.anthropicApiKey
      if (!apiKey) throw new Error('Missing ANTHROPIC_API_KEY for anthropic/... model')
      const { createAnthropic } = await import('@ai-sdk/anthropic')
      const anthropic = createAnthropic({ apiKey, fetch: fetchImpl })
      const result = streamText({
        model: anthropic(parsed.model),
        system,
        ...(typeof prompt === 'string' ? { prompt } : { messages: prompt }),
        ...(typeof temperature === 'number' ? { temperature } : {}),
        ...(typeof maxOutputTokens === 'number' ? { maxOutputTokens } : {}),
        abortSignal: controller.signal,
        onError,
      })
      return {
        textStream: wrapTextStream(result.textStream),
        canonicalModelId: parsed.canonical,
        provider: parsed.provider,
        usage: result.totalUsage.then((raw) => normalizeTokenUsage(raw)).catch(() => null),
        lastError: () => lastError,
      }
    }

    // Detect OpenRouter: via OPENROUTER_API_KEY or OPENAI_BASE_URL containing openrouter.ai
    const baseUrl = typeof process !== 'undefined' ? process.env.OPENAI_BASE_URL : undefined
    const isOpenRouterViaBaseUrl =
      typeof baseUrl === 'string' && /openrouter\.ai/i.test(baseUrl) && baseUrl.length > 0
    const isOpenRouter = apiKeys.openrouterApiKey != null || isOpenRouterViaBaseUrl

    const apiKey = isOpenRouter
      ? (apiKeys.openrouterApiKey ?? apiKeys.openaiApiKey)
      : apiKeys.openaiApiKey
    if (!apiKey) {
      throw new Error(
        isOpenRouter
          ? 'Missing OPENROUTER_API_KEY for OpenRouter'
          : 'Missing OPENAI_API_KEY for openai/... model'
      )
    }

    const { createOpenAI } = await import('@ai-sdk/openai')

    // Build fetch wrapper with OpenRouter provider ordering header
    const openrouterProviders = openrouter?.providers
    const wrappedFetch: typeof fetch = isOpenRouter && openrouterProviders?.length
      ? (url, init) => {
          const headers = new Headers(init?.headers)
          headers.set('HTTP-Referer', 'https://github.com/steipete/summarize')
          headers.set('X-Title', 'summarize')
          headers.set('X-OpenRouter-Provider-Order', openrouterProviders.join(','))
          return fetchImpl(url, { ...init, headers })
        }
      : fetchImpl

    const openai = createOpenAI({
      apiKey,
      ...(isOpenRouter ? { baseURL: 'https://openrouter.ai/api/v1' } : {}),
      fetch: wrappedFetch,
    })

    // OpenRouter requires chat completions endpoint
    const useChatCompletions = isOpenRouter
    const responsesModelId = parsed.model as unknown as Parameters<typeof openai>[0]
    const chatModelId = parsed.model as unknown as Parameters<typeof openai.chat>[0]
    const result = streamText({
      model: useChatCompletions ? openai.chat(chatModelId) : openai(responsesModelId),
      system,
      ...(typeof prompt === 'string' ? { prompt } : { messages: prompt }),
      ...(typeof temperature === 'number' ? { temperature } : {}),
      ...(typeof maxOutputTokens === 'number' ? { maxOutputTokens } : {}),
      abortSignal: controller.signal,
      onError,
    })
    return {
      textStream: wrapTextStream(result.textStream),
      canonicalModelId: parsed.canonical,
      provider: parsed.provider,
      usage: result.totalUsage.then((raw) => normalizeTokenUsage(raw)).catch(() => null),
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
