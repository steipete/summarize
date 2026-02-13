import type { Context, Message } from '@mariozechner/pi-ai'
import type { LlmApiKeys } from '../llm/generate-text.js'
import { streamTextWithContext } from '../llm/generate-text.js'
import { buildAutoModelAttempts, envHasKey } from '../model-auto.js'
import { parseRequestedModelId } from '../model-spec.js'
import { resolveEnvState } from '../run/run-env.js'

type ChatSession = {
  id: string
  lastMeta: {
    model: string | null
    modelLabel: string | null
    inputSummary: string | null
    summaryFromCache: boolean | null
  }
}

type ChatEvent = { event: string; data?: unknown }

const SYSTEM_PROMPT = `You are Summarize Chat.

You answer questions about the current page content. Keep responses concise and grounded in the page.`

function normalizeMessages(messages: Message[]): Message[] {
  return messages.map((message) => ({
    ...message,
    timestamp: message.timestamp ?? Date.now(),
  }))
}

function buildContext({
  pageUrl,
  pageTitle,
  pageContent,
  messages,
}: {
  pageUrl: string
  pageTitle: string | null
  pageContent: string
  messages: Message[]
}): Context {
  const header = pageTitle ? `${pageTitle} (${pageUrl})` : pageUrl
  const systemPrompt = `${SYSTEM_PROMPT}\n\nPage:\n${header}\n\nContent:\n${pageContent}`
  return { systemPrompt, messages: normalizeMessages(messages) }
}

function resolveApiKeys(env: Record<string, string | undefined>): LlmApiKeys {
  const envState = resolveEnvState({ env, envForRun: env, configForCli: null })
  return {
    xaiApiKey: envState.xaiApiKey,
    openaiApiKey: envState.apiKey ?? envState.openaiTranscriptionKey,
    googleApiKey: envState.googleApiKey,
    anthropicApiKey: envState.anthropicApiKey,
    openrouterApiKey: envState.openrouterApiKey,
  }
}

export async function streamChatResponse({
  env,
  fetchImpl,
  session: _session,
  pageUrl,
  pageTitle,
  pageContent,
  messages,
  modelOverride,
  pushToSession,
  emitMeta,
}: {
  env: Record<string, string | undefined>
  fetchImpl: typeof fetch
  session: ChatSession
  pageUrl: string
  pageTitle: string | null
  pageContent: string
  messages: Message[]
  modelOverride: string | null
  pushToSession: (event: ChatEvent) => void
  emitMeta: (patch: Partial<ChatSession['lastMeta']>) => void
}) {
  const apiKeys = resolveApiKeys(env)
  const context = buildContext({ pageUrl, pageTitle, pageContent, messages })

  const resolveModel = () => {
    if (modelOverride && modelOverride.trim().length > 0) {
      const requested = parseRequestedModelId(modelOverride)
      if (requested.kind === 'auto') {
        return null
      }
      if (requested.transport === 'cli') {
        throw new Error('CLI models are not supported in the daemon')
      }
      return {
        userModelId: requested.userModelId,
        modelId: requested.llmModelId,
        forceOpenRouter: requested.forceOpenRouter,
      }
    }
    return null
  }

  const resolved = resolveModel()
  if (resolved) {
    emitMeta({ model: resolved.userModelId })
    const result = await streamTextWithContext({
      modelId: resolved.modelId,
      apiKeys,
      context,
      timeoutMs: 30_000,
      fetchImpl,
      forceOpenRouter: resolved.forceOpenRouter,
    })
    for await (const chunk of result.textStream) {
      pushToSession({ event: 'content', data: chunk })
    }
    pushToSession({ event: 'metrics' })
    return
  }

  const envState = resolveEnvState({ env, envForRun: env, configForCli: null })
  const attempts = buildAutoModelAttempts({
    kind: 'text',
    promptTokens: null,
    desiredOutputTokens: null,
    requiresVideoUnderstanding: false,
    env: envState.envForAuto,
    config: null,
    catalog: null,
    openrouterProvidersFromEnv: null,
    cliAvailability: envState.cliAvailability,
  })

  const attempt = attempts.find(
    (entry) =>
      entry.transport !== 'cli' &&
      entry.llmModelId &&
      envHasKey(envState.envForAuto, entry.requiredEnv)
  )
  if (!attempt || !attempt.llmModelId) {
    throw new Error('No model available for chat')
  }

  emitMeta({ model: attempt.userModelId })
  const result = await streamTextWithContext({
    modelId: attempt.llmModelId,
    apiKeys,
    context,
    timeoutMs: 30_000,
    fetchImpl,
    forceOpenRouter: attempt.forceOpenRouter,
  })
  for await (const chunk of result.textStream) {
    pushToSession({ event: 'content', data: chunk })
  }
  pushToSession({ event: 'metrics' })
  void _session
}
