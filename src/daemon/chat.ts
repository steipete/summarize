/**
 * Chat module for conversational Q&A about page content.
 */

import type { Message } from '@mariozechner/pi-ai'

import type { RunMetricsReport } from '../costs.js'
import { streamTextWithContext, type LlmApiKeys, type LlmTokenUsage } from '../llm/generate-text.js'
import { userTextMessage } from '../llm/prompt.js'
import { buildAutoModelAttempts } from '../model-auto.js'
import { buildFinishLineVariants, formatModelLabelForDisplay } from '../run/finish-line.js'
import { resolveRunContextState } from '../run/run-context.js'
import { resolveModelSelection } from '../run/run-models.js'
import { resolveRunOverrides } from '../run/run-settings.js'
import type { SseEvent } from '../shared/sse-events.js'

type ChatMessage = {
  role: 'user' | 'assistant'
  content: string
}

type Session = {
  id: string
  lastMeta: {
    model: string | null
    modelLabel: string | null
    inputSummary: string | null
    summaryFromCache: boolean | null
  }
}

const CHAT_DEFAULT_MAX_OUTPUT_TOKENS = 2048
const CHAT_DEFAULT_TIMEOUT_MS = 120_000

export async function streamChatResponse({
  env,
  fetchImpl,
  session,
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
  session: Session
  pageUrl: string
  pageTitle: string | null
  pageContent: string
  messages: ChatMessage[]
  modelOverride: string | null
  pushToSession: (evt: SseEvent) => void
  emitMeta: (patch: Partial<{
    model: string | null
    modelLabel: string | null
    inputSummary: string | null
    summaryFromCache: boolean | null
  }>) => void
}): Promise<void> {
  const startedAtMs = Date.now()

  const {
    config,
    configPath,
    configForCli,
    apiKey,
    openrouterApiKey,
    xaiApiKey,
    googleApiKey,
    anthropicApiKey,
    providerBaseUrls,
    envForAuto,
  } = resolveRunContextState({
    env,
    envForRun: env,
    programOpts: { videoMode: 'auto' },
    languageExplicitlySet: false,
    videoModeExplicitlySet: false,
    cliFlagPresent: false,
    cliProviderArg: null,
  })

  const overrides = resolveRunOverrides({})
  const timeoutMs = overrides.timeoutMs ?? CHAT_DEFAULT_TIMEOUT_MS
  const maxOutputTokens = overrides.maxOutputTokensArg ?? CHAT_DEFAULT_MAX_OUTPUT_TOKENS

  const { requestedModel, configForModelSelection, isFallbackModel } = resolveModelSelection({
    config,
    configForCli,
    configPath,
    envForRun: env,
    explicitModelArg: modelOverride,
  })

  let modelId: string
  let forceOpenRouter = false
  let displayModelId: string

  if (requestedModel.kind === 'fixed' && requestedModel.llmModelId) {
    modelId = requestedModel.llmModelId
    forceOpenRouter = requestedModel.forceOpenRouter
    displayModelId = requestedModel.userModelId
  } else if (isFallbackModel) {
    const estimatedPromptTokens = Math.ceil(pageContent.length / 4)
    const attempts = buildAutoModelAttempts({
      kind: 'website',
      promptTokens: estimatedPromptTokens,
      desiredOutputTokens: maxOutputTokens,
      requiresVideoUnderstanding: false,
      env: envForAuto,
      config: configForModelSelection,
      catalog: null,
      openrouterProvidersFromEnv: null,
    })

    const selected = attempts.find((attempt) => attempt.llmModelId)
    if (!selected?.llmModelId) {
      throw new Error('No model available for chat')
    }
    modelId = selected.llmModelId
    forceOpenRouter = selected.forceOpenRouter
    displayModelId = selected.userModelId
  } else {
    throw new Error('No model available for chat')
  }

  emitMeta({
    model: displayModelId,
    modelLabel: formatModelLabelForDisplay(displayModelId),
  })

  const systemPrompt = buildChatSystemPrompt({ pageUrl, pageTitle, pageContent })

  const promptMessages: Message[] = messages.map((m) => {
    if (m.role === 'user') {
      return userTextMessage(m.content)
    }
    return {
      role: 'assistant' as const,
      content: [{ type: 'text' as const, text: m.content }],
      timestamp: Date.now(),
      api: 'openai-completions' as const,
      provider: 'openai' as const,
      model: modelId,
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: 'stop' as const,
    }
  })

  const apiKeys: LlmApiKeys = {
    xaiApiKey,
    openaiApiKey: apiKey,
    googleApiKey,
    anthropicApiKey,
    openrouterApiKey,
  }

  const streamResult = await streamTextWithContext({
    modelId,
    apiKeys,
    context: { systemPrompt, messages: promptMessages },
    temperature: 0.7,
    maxOutputTokens,
    timeoutMs,
    fetchImpl,
    forceOpenRouter,
    openaiBaseUrlOverride: providerBaseUrls.openai,
    anthropicBaseUrlOverride: providerBaseUrls.anthropic,
    googleBaseUrlOverride: providerBaseUrls.google,
    xaiBaseUrlOverride: providerBaseUrls.xai,
  })

  for await (const delta of streamResult.textStream) {
    pushToSession({ event: 'chunk', data: { text: delta } })
  }

  const elapsedMs = Date.now() - startedAtMs
  let tokenUsage: LlmTokenUsage | null = null
  try {
    const resolved = await streamResult.usage
    tokenUsage = resolved ?? null
  } catch {
    tokenUsage = null
  }

  const report: RunMetricsReport = {
    llm: [
      {
        provider: streamResult.provider,
        model: streamResult.canonicalModelId,
        calls: 1,
        promptTokens: tokenUsage?.promptTokens ?? null,
        completionTokens: tokenUsage?.completionTokens ?? null,
        totalTokens: tokenUsage?.totalTokens ?? null,
      },
    ],
    services: {
      firecrawl: { requests: 0 },
      apify: { requests: 0 },
    },
  }

  const { compact, detailed } = buildFinishLineVariants({
    elapsedMs,
    label: guessSiteName(pageUrl),
    model: displayModelId,
    report,
    costUsd: null,
  })

  pushToSession({
    event: 'metrics',
    data: {
      elapsedMs,
      summary: compact.line,
      details: compact.details,
      summaryDetailed: detailed.line,
      detailsDetailed: detailed.details,
    },
  })

  pushToSession({ event: 'done', data: {} })
}

function buildChatSystemPrompt({
  pageUrl,
  pageTitle,
  pageContent,
}: {
  pageUrl: string
  pageTitle: string | null
  pageContent: string
}): string {
  return `You are a helpful assistant that answers questions about a web page.

Page URL: ${pageUrl}
${pageTitle ? `Page Title: ${pageTitle}` : ''}

<page_content>
${pageContent}
</page_content>

Instructions:
- Answer questions based on the page content above
- If asked about something not in the content, say so clearly
- Be concise and direct
- The page_content may include a "Summary (auto-generated)" and a "Full transcript"
- Treat the summary as a quick reference; prefer the full transcript if they conflict
- Use any Metadata section to understand the source and processing details
- Use Markdown formatting when helpful
- Do not make up information not present in the page content`
}

function guessSiteName(url: string): string | null {
  try {
    const { hostname } = new URL(url)
    return hostname || null
  } catch {
    return null
  }
}
