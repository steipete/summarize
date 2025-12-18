import { parseGatewayStyleModelId } from './model-id.js'

export type LlmApiKeys = {
  xaiApiKey: string | null
  openaiApiKey: string | null
  googleApiKey: string | null
}

export async function generateTextWithModelId({
  modelId,
  apiKeys,
  system,
  prompt,
  maxOutputTokens,
  timeoutMs,
  temperature,
  fetchImpl,
}: {
  modelId: string
  apiKeys: LlmApiKeys
  system?: string
  prompt: string
  maxOutputTokens: number
  timeoutMs: number
  temperature: number
  fetchImpl: typeof fetch
}): Promise<{ text: string; canonicalModelId: string; provider: 'xai' | 'openai' | 'google' }> {
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
        prompt,
        temperature,
        maxOutputTokens,
        abortSignal: controller.signal,
      })
      return { text: result.text, canonicalModelId: parsed.canonical, provider: parsed.provider }
    }

    if (parsed.provider === 'google') {
      const apiKey = apiKeys.googleApiKey
      if (!apiKey) throw new Error('Missing GOOGLE_GENERATIVE_AI_API_KEY for google/... model')
      const { createGoogleGenerativeAI } = await import('@ai-sdk/google')
      const google = createGoogleGenerativeAI({ apiKey, fetch: fetchImpl })
      const result = await generateText({
        model: google(parsed.model),
        system,
        prompt,
        temperature,
        maxOutputTokens,
        abortSignal: controller.signal,
      })
      return { text: result.text, canonicalModelId: parsed.canonical, provider: parsed.provider }
    }

    const apiKey = apiKeys.openaiApiKey
    if (!apiKey) throw new Error('Missing OPENAI_API_KEY for openai/... model')
    const { createOpenAI } = await import('@ai-sdk/openai')
    const openai = createOpenAI({ apiKey, fetch: fetchImpl })
    const result = await generateText({
      model: openai(parsed.model),
      system,
      prompt,
      temperature,
      maxOutputTokens,
      abortSignal: controller.signal,
    })
    return { text: result.text, canonicalModelId: parsed.canonical, provider: parsed.provider }
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') {
      throw new Error('LLM request timed out')
    }
    throw error
  } finally {
    clearTimeout(timeout)
  }
}
