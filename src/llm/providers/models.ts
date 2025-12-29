import type { Api, Context, Model } from '@mariozechner/pi-ai'
import { createSyntheticModel, resolveBaseUrlOverride, tryGetModel, wantsImages } from './shared.js'
import type { OpenAiClientConfig } from './types.js'

export function resolveOpenAiModel({
  modelId,
  context,
  openaiConfig,
}: {
  modelId: string
  context: Context
  openaiConfig: OpenAiClientConfig
}): Model<Api> {
  const allowImages = wantsImages(context)
  const base = tryGetModel('openai', modelId)
  const api = openaiConfig.useChatCompletions ? 'openai-completions' : 'openai-responses'
  const baseUrl = openaiConfig.baseURL ?? base?.baseUrl ?? 'https://api.openai.com/v1'
  const headers = openaiConfig.isOpenRouter
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

export function resolveZaiModel({
  modelId,
  context,
  openaiBaseUrlOverride,
}: {
  modelId: string
  context: Context
  openaiBaseUrlOverride?: string | null
}): Model<Api> {
  const allowImages = wantsImages(context)
  const base = tryGetModel('zai', modelId)
  const api = 'openai-completions'
  const baseUrl = openaiBaseUrlOverride ?? base?.baseUrl ?? 'https://api.z.ai/api/paas/v4'
  return {
    ...(base ?? createSyntheticModel({ provider: 'zai', modelId, api, baseUrl, allowImages })),
    api,
    baseUrl,
    input: allowImages ? ['text', 'image'] : ['text'],
  }
}

export function resolveXaiModel({
  modelId,
  context,
  xaiBaseUrlOverride,
}: {
  modelId: string
  context: Context
  xaiBaseUrlOverride?: string | null
}): Model<Api> {
  const allowImages = wantsImages(context)
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

export function resolveGoogleModel({
  modelId,
  context,
  googleBaseUrlOverride,
}: {
  modelId: string
  context: Context
  googleBaseUrlOverride?: string | null
}): Model<Api> {
  const allowImages = wantsImages(context)
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

export function resolveAnthropicModel({
  modelId,
  context,
  anthropicBaseUrlOverride,
}: {
  modelId: string
  context: Context
  anthropicBaseUrlOverride?: string | null
}): Model<Api> {
  const allowImages = wantsImages(context)
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
