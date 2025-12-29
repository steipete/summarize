/**
 * Chat module for conversational Q&A about page content.
 *
 * ## Model Selection: Why Chat Forces OpenRouter
 *
 * Unlike summarization which can use native provider APIs (Anthropic, OpenAI, Google, etc.),
 * chat mode exclusively routes through OpenRouter. This is intentional for several reasons:
 *
 * 1. **Multi-turn conversation support**: OpenRouter provides consistent handling of
 *    conversation history across different model providers, avoiding provider-specific
 *    message format quirks.
 *
 * 2. **Cost optimization**: Chat sessions can involve many back-and-forth messages.
 *    OpenRouter's pricing and rate limiting is more predictable for interactive use.
 *
 * 3. **Model availability**: Chat benefits from OpenRouter's model fallback capabilities
 *    when a specific model is unavailable or rate-limited.
 *
 * 4. **Simplified implementation**: By standardizing on OpenRouter for chat, we avoid
 *    duplicating conversation handling logic across multiple provider implementations.
 *
 * Summarization uses the full model selection pipeline (including native APIs) because
 * it's a single-shot operation where provider-specific optimizations (like prompt caching)
 * provide meaningful benefits.
 */

import type { SseEvent } from '../shared/sse-events.js'
import { streamTextWithModelId, type LlmApiKeys, type LlmTokenUsage } from '../llm/generate-text.js'
import { userTextMessage } from '../llm/prompt.js'
import { resolveRunContextState } from '../run/run-context.js'
import { resolveModelSelection } from '../run/run-models.js'
import { resolveRunOverrides } from '../run/run-settings.js'
import { buildFinishLineVariants, formatModelLabelForDisplay } from '../run/finish-line.js'
import type { RunMetricsReport } from '../costs.js'
import { buildAutoModelAttempts } from '../model-auto.js'
import type { Message } from '@mariozechner/pi-ai'

// Chat-specific defaults
const CHAT_DEFAULT_MAX_OUTPUT_TOKENS = 2048
const CHAT_DEFAULT_TIMEOUT_MS = 120_000

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
  const envForRun = env
  const startedAtMs = Date.now()

  // Get configuration and API keys (same as summarize flow)
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
    env: envForRun,
    envForRun,
    programOpts: { videoMode: 'auto' },
    languageExplicitlySet: false,
    videoModeExplicitlySet: false,
    cliFlagPresent: false,
    cliProviderArg: null,
  })

  // Resolve run overrides from config (like summarize does)
  const overrides = resolveRunOverrides({})
  const timeoutMs = overrides.timeoutMs ?? CHAT_DEFAULT_TIMEOUT_MS
  const maxOutputTokens = overrides.maxOutputTokensArg ?? CHAT_DEFAULT_MAX_OUTPUT_TOKENS

  // Resolve model selection (same as summarize flow)
  const { requestedModel, configForModelSelection, isFallbackModel } = resolveModelSelection({
    config,
    configForCli,
    configPath,
    envForRun,
    explicitModelArg: modelOverride,
  })

  // Model selection for chat: always route through OpenRouter (see module docs for rationale)
  // This differs from summarize which can use native provider APIs directly.
  let modelId: string
  let forceOpenRouter = false

  if (requestedModel.kind === 'fixed' && requestedModel.llmModelId) {
    // Fixed model selected - route through OpenRouter for chat
    if (requestedModel.forceOpenRouter) {
      modelId = requestedModel.llmModelId
      forceOpenRouter = true
    } else {
      // Route native model through OpenRouter for chat
      const nativeModelId = requestedModel.llmModelId
      modelId = nativeModelId.startsWith('openai/')
        ? nativeModelId
        : `openai/${nativeModelId}`
      forceOpenRouter = true
    }
  } else if (isFallbackModel) {
    // Auto mode: use same model selection as summarize, but filter to OpenRouter only
    // Estimate prompt tokens based on page content (typically < 50k for most pages)
    const estimatedPromptTokens = Math.ceil(pageContent.length / 4) // rough estimate: 4 chars per token
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

    // Filter to only OpenRouter attempts (forceOpenRouter === true)
    const openrouterAttempts = attempts.filter(
      (a) => a.transport === 'openrouter' && a.forceOpenRouter && a.llmModelId
    )

    if (openrouterAttempts.length > 0 && openrouterApiKey) {
      // Use the first OpenRouter attempt
      modelId = openrouterAttempts[0].llmModelId!
      forceOpenRouter = true
    } else if (!openrouterApiKey) {
      throw new Error('Chat requires OPENROUTER_API_KEY to be configured')
    } else {
      throw new Error('No OpenRouter models available for chat')
    }
  } else {
    throw new Error('No model available for chat')
  }

  // Emit model info
  const displayModelId = forceOpenRouter ? `openrouter/${modelId.replace(/^openai\//, '')}` : modelId
  emitMeta({
    model: displayModelId,
    modelLabel: formatModelLabelForDisplay(displayModelId),
  })

  // Build system prompt with page content
  const systemPrompt = buildChatSystemPrompt({ pageUrl, pageTitle, pageContent })

  // Convert messages to prompt format that pi-ai expects
  const promptMessages: Message[] = messages.map((m) => {
    if (m.role === 'user') {
      return userTextMessage(m.content)
    }
    // For assistant messages, we need to provide minimal required fields
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

  // Stream the response
  // Note: temperature 0.7 is intentional for chat (more creative than summarize's 0)
  const streamResult = await streamTextWithModelId({
    modelId,
    apiKeys,
    system: systemPrompt,
    prompt: promptMessages,
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

  // Stream chunks to the session
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

  // Emit done event
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
