import type { ModelMessage } from 'ai'
import { generateTextWithModelId } from '../llm/generate-text.js'
import { resolveGoogleModelForUsage } from '../llm/google-models.js'
import type { parseGatewayStyleModelId } from '../llm/model-id.js'

export async function resolveModelIdForLlmCall({
  parsedModel,
  apiKeys,
  fetchImpl,
  timeoutMs,
}: {
  parsedModel: ReturnType<typeof parseGatewayStyleModelId>
  apiKeys: {
    googleApiKey: string | null
  }
  fetchImpl: typeof fetch
  timeoutMs: number
}): Promise<{ modelId: string; note: string | null; forceStreamOff: boolean }> {
  if (parsedModel.provider !== 'google') {
    return { modelId: parsedModel.canonical, note: null, forceStreamOff: false }
  }

  const key = apiKeys.googleApiKey
  if (!key) {
    return { modelId: parsedModel.canonical, note: null, forceStreamOff: false }
  }

  const resolved = await resolveGoogleModelForUsage({
    requestedModelId: parsedModel.model,
    apiKey: key,
    fetchImpl,
    timeoutMs,
  })

  return {
    modelId: `google/${resolved.resolvedModelId}`,
    note: resolved.note,
    forceStreamOff: false,
  }
}

export async function summarizeWithModelId({
  modelId,
  prompt,
  maxOutputTokens,
  timeoutMs,
  fetchImpl,
  apiKeys,
  forceOpenRouter,
  openaiBaseUrlOverride,
  anthropicBaseUrlOverride,
  googleBaseUrlOverride,
  xaiBaseUrlOverride,
  forceChatCompletions,
  retries,
  onRetry,
}: {
  modelId: string
  prompt: string | ModelMessage[]
  maxOutputTokens?: number
  timeoutMs: number
  fetchImpl: typeof fetch
  apiKeys: {
    xaiApiKey: string | null
    openaiApiKey: string | null
    googleApiKey: string | null
    anthropicApiKey: string | null
    openrouterApiKey: string | null
  }
  forceOpenRouter?: boolean
  openaiBaseUrlOverride?: string | null
  anthropicBaseUrlOverride?: string | null
  googleBaseUrlOverride?: string | null
  xaiBaseUrlOverride?: string | null
  forceChatCompletions?: boolean
  retries: number
  onRetry?: (notice: {
    attempt: number
    maxRetries: number
    delayMs: number
    error: unknown
  }) => void
}): Promise<{
  text: string
  provider: 'xai' | 'openai' | 'google' | 'anthropic' | 'zai'
  canonicalModelId: string
  usage: Awaited<ReturnType<typeof generateTextWithModelId>>['usage']
}> {
  const result = await generateTextWithModelId({
    modelId,
    apiKeys,
    forceOpenRouter,
    openaiBaseUrlOverride,
    anthropicBaseUrlOverride,
    googleBaseUrlOverride,
    xaiBaseUrlOverride,
    forceChatCompletions,
    prompt,
    temperature: 0,
    maxOutputTokens,
    timeoutMs,
    fetchImpl,
    retries,
    onRetry,
  })
  return {
    text: result.text,
    provider: result.provider,
    canonicalModelId: result.canonicalModelId,
    usage: result.usage,
  }
}
