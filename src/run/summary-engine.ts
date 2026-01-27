import { countTokens } from 'gpt-tokenizer'
import { createMarkdownStreamer, render as renderMarkdownAnsi } from 'markdansi'
import type { CliProvider } from '../config.js'
import { isCliDisabled, runCliModel } from '../llm/cli.js'
import { streamTextWithModelId } from '../llm/generate-text.js'
import { parseGatewayStyleModelId } from '../llm/model-id.js'
import type { Prompt } from '../llm/prompt.js'
import { formatCompactCount } from '../tty/format.js'
import { createRetryLogger, writeVerbose } from './logging.js'
import { prepareMarkdownForTerminalStreaming } from './markdown.js'
import { createStreamOutputGate, type StreamOutputMode } from './stream-output.js'
import {
  canStream,
  isGoogleStreamingUnsupportedError,
  isStreamingTimeoutError,
  mergeStreamingChunk,
} from './streaming.js'
import { resolveModelIdForLlmCall, summarizeWithModelId } from './summary-llm.js'
import { isRichTty, markdownRenderWidth, supportsColor } from './terminal.js'
import type { ModelAttempt, ModelMeta } from './types.js'

export type SummaryEngineDeps = {
  env: Record<string, string | undefined>
  envForRun: Record<string, string | undefined>
  stdout: NodeJS.WritableStream
  stderr: NodeJS.WritableStream
  execFileImpl: Parameters<typeof runCliModel>[0]['execFileImpl']
  timeoutMs: number
  retries: number
  streamingEnabled: boolean
  streamingOutputMode?: StreamOutputMode
  plain: boolean
  verbose: boolean
  verboseColor: boolean
  openaiUseChatCompletions: boolean
  cliConfigForRun: Parameters<typeof runCliModel>[0]['config']
  cliAvailability: Partial<Record<CliProvider, boolean>>
  trackedFetch: typeof fetch
  resolveMaxOutputTokensForCall: (modelId: string) => Promise<number | null>
  resolveMaxInputTokensForCall: (modelId: string) => Promise<number | null>
  llmCalls: Array<{
    provider: 'xai' | 'openai' | 'google' | 'anthropic' | 'zai' | 'cli'
    model: string
    usage: Awaited<ReturnType<typeof summarizeWithModelId>>['usage'] | null
    costUsd?: number | null
    purpose: 'summary' | 'markdown'
  }>
  clearProgressForStdout: () => void
  restoreProgressAfterStdout?: (() => void) | null
  apiKeys: {
    xaiApiKey: string | null
    openaiApiKey: string | null
    googleApiKey: string | null
    anthropicApiKey: string | null
    openrouterApiKey: string | null
  }
  keyFlags: {
    googleConfigured: boolean
    anthropicConfigured: boolean
    openrouterConfigured: boolean
  }
  zai: {
    apiKey: string | null
    baseUrl: string
  }
  providerBaseUrls: {
    openai: string | null
    anthropic: string | null
    google: string | null
    xai: string | null
  }
}

export type SummaryStreamHandler = {
  onChunk: (args: {
    streamed: string
    prevStreamed: string
    appended: string
  }) => void | Promise<void>
  onDone?: ((finalText: string) => void | Promise<void>) | null
}

export function createSummaryEngine(deps: SummaryEngineDeps) {
  const applyZaiOverrides = (attempt: ModelAttempt): ModelAttempt => {
    if (!attempt.userModelId.toLowerCase().startsWith('zai/')) return attempt
    return {
      ...attempt,
      openaiApiKeyOverride: deps.zai.apiKey,
      openaiBaseUrlOverride: deps.zai.baseUrl,
      forceChatCompletions: true,
    }
  }

  const envHasKeyFor = (requiredEnv: ModelAttempt['requiredEnv']) => {
    if (requiredEnv === 'CLI_CLAUDE') {
      return Boolean(deps.cliAvailability.claude)
    }
    if (requiredEnv === 'CLI_CODEX') {
      return Boolean(deps.cliAvailability.codex)
    }
    if (requiredEnv === 'CLI_GEMINI') {
      return Boolean(deps.cliAvailability.gemini)
    }
    if (requiredEnv === 'CLI_AGENT') {
      return Boolean(deps.cliAvailability.agent)
    }
    if (requiredEnv === 'GEMINI_API_KEY') {
      return deps.keyFlags.googleConfigured
    }
    if (requiredEnv === 'OPENROUTER_API_KEY') {
      return deps.keyFlags.openrouterConfigured
    }
    if (requiredEnv === 'OPENAI_API_KEY') {
      return Boolean(deps.apiKeys.openaiApiKey)
    }
    if (requiredEnv === 'Z_AI_API_KEY') {
      return Boolean(deps.zai.apiKey)
    }
    if (requiredEnv === 'XAI_API_KEY') {
      return Boolean(deps.apiKeys.xaiApiKey)
    }
    return Boolean(deps.apiKeys.anthropicApiKey)
  }

  const formatMissingModelError = (attempt: ModelAttempt): string => {
    if (attempt.requiredEnv === 'CLI_CLAUDE') {
      return `Claude CLI not found for model ${attempt.userModelId}. Install Claude CLI or set CLAUDE_PATH.`
    }
    if (attempt.requiredEnv === 'CLI_CODEX') {
      return `Codex CLI not found for model ${attempt.userModelId}. Install Codex CLI or set CODEX_PATH.`
    }
    if (attempt.requiredEnv === 'CLI_GEMINI') {
      return `Gemini CLI not found for model ${attempt.userModelId}. Install Gemini CLI or set GEMINI_PATH.`
    }
    if (attempt.requiredEnv === 'CLI_AGENT') {
      return `Cursor Agent CLI not found for model ${attempt.userModelId}. Install Cursor CLI or set AGENT_PATH.`
    }
    return `Missing ${attempt.requiredEnv} for model ${attempt.userModelId}. Set the env var or choose a different --model.`
  }

  const runSummaryAttempt = async ({
    attempt,
    prompt,
    allowStreaming,
    onModelChosen,
    cli,
    streamHandler,
  }: {
    attempt: ModelAttempt
    prompt: Prompt
    allowStreaming: boolean
    onModelChosen?: ((modelId: string) => void) | null
    cli?: {
      promptOverride?: string
      allowTools?: boolean
      cwd?: string
      extraArgsByProvider?: Partial<Record<CliProvider, string[]>>
    } | null
    streamHandler?: SummaryStreamHandler | null
  }): Promise<{
    summary: string
    summaryAlreadyPrinted: boolean
    modelMeta: ModelMeta
    maxOutputTokensForCall: number | null
  }> => {
    onModelChosen?.(attempt.userModelId)

    if (attempt.transport === 'cli') {
      const hasAttachments = (prompt.attachments?.length ?? 0) > 0
      const cliPrompt = hasAttachments ? (cli?.promptOverride ?? null) : prompt.userText
      if (!cliPrompt) {
        throw new Error('CLI models require a text prompt (no binary attachments).')
      }
      if (!attempt.cliProvider) {
        throw new Error(`Missing CLI provider for model ${attempt.userModelId}.`)
      }
      if (isCliDisabled(attempt.cliProvider, deps.cliConfigForRun)) {
        throw new Error(
          `CLI provider ${attempt.cliProvider} is disabled by cli.enabled. Update your config to enable it.`
        )
      }
      const result = await runCliModel({
        provider: attempt.cliProvider,
        prompt: cliPrompt,
        model: attempt.cliModel ?? null,
        allowTools: Boolean(cli?.allowTools),
        timeoutMs: deps.timeoutMs,
        env: deps.env,
        execFileImpl: deps.execFileImpl,
        config: deps.cliConfigForRun ?? null,
        cwd: cli?.cwd,
        extraArgs: cli?.extraArgsByProvider?.[attempt.cliProvider],
      })
      const summary = result.text.trim()
      if (!summary) throw new Error('CLI returned an empty summary')
      if (result.usage || typeof result.costUsd === 'number') {
        deps.llmCalls.push({
          provider: 'cli',
          model: attempt.userModelId,
          usage: result.usage ?? null,
          costUsd: result.costUsd ?? null,
          purpose: 'summary',
        })
      }
      return {
        summary,
        summaryAlreadyPrinted: false,
        modelMeta: { provider: 'cli', canonical: attempt.userModelId },
        maxOutputTokensForCall: null,
      }
    }

    if (!attempt.llmModelId) {
      throw new Error(`Missing model id for ${attempt.userModelId}.`)
    }
    const parsedModel = parseGatewayStyleModelId(attempt.llmModelId)
    const apiKeysForLlm = {
      xaiApiKey: deps.apiKeys.xaiApiKey,
      openaiApiKey: attempt.openaiApiKeyOverride ?? deps.apiKeys.openaiApiKey,
      googleApiKey: deps.keyFlags.googleConfigured ? deps.apiKeys.googleApiKey : null,
      anthropicApiKey: deps.keyFlags.anthropicConfigured ? deps.apiKeys.anthropicApiKey : null,
      openrouterApiKey: deps.keyFlags.openrouterConfigured ? deps.apiKeys.openrouterApiKey : null,
    }

    const modelResolution = await resolveModelIdForLlmCall({
      parsedModel,
      apiKeys: { googleApiKey: apiKeysForLlm.googleApiKey },
      fetchImpl: deps.trackedFetch,
      timeoutMs: deps.timeoutMs,
    })
    if (modelResolution.note && deps.verbose) {
      writeVerbose(
        deps.stderr,
        deps.verbose,
        modelResolution.note,
        deps.verboseColor,
        deps.envForRun
      )
    }
    const parsedModelEffective = parseGatewayStyleModelId(modelResolution.modelId)
    const streamingEnabledForCall =
      allowStreaming &&
      deps.streamingEnabled &&
      !modelResolution.forceStreamOff &&
      canStream({
        provider: parsedModelEffective.provider,
        prompt,
        transport: attempt.transport === 'openrouter' ? 'openrouter' : 'native',
      })
    const forceChatCompletions =
      Boolean(attempt.forceChatCompletions) ||
      (deps.openaiUseChatCompletions && parsedModelEffective.provider === 'openai')

    const maxOutputTokensForCall = await deps.resolveMaxOutputTokensForCall(
      parsedModelEffective.canonical
    )
    const maxInputTokensForCall = await deps.resolveMaxInputTokensForCall(
      parsedModelEffective.canonical
    )
    if (
      typeof maxInputTokensForCall === 'number' &&
      Number.isFinite(maxInputTokensForCall) &&
      maxInputTokensForCall > 0 &&
      (prompt.attachments?.length ?? 0) === 0
    ) {
      const tokenCount = countTokens(prompt.userText)
      if (tokenCount > maxInputTokensForCall) {
        throw new Error(
          `Input token count (${formatCompactCount(tokenCount)}) exceeds model input limit (${formatCompactCount(maxInputTokensForCall)}). Tokenized with GPT tokenizer; prompt included.`
        )
      }
    }

    if (!streamingEnabledForCall) {
      const result = await summarizeWithModelId({
        modelId: parsedModelEffective.canonical,
        prompt,
        maxOutputTokens: maxOutputTokensForCall ?? undefined,
        timeoutMs: deps.timeoutMs,
        fetchImpl: deps.trackedFetch,
        apiKeys: apiKeysForLlm,
        forceOpenRouter: attempt.forceOpenRouter,
        openaiBaseUrlOverride: attempt.openaiBaseUrlOverride ?? deps.providerBaseUrls.openai,
        anthropicBaseUrlOverride: deps.providerBaseUrls.anthropic,
        googleBaseUrlOverride: deps.providerBaseUrls.google,
        xaiBaseUrlOverride: deps.providerBaseUrls.xai,
        forceChatCompletions,
        retries: deps.retries,
        onRetry: createRetryLogger({
          stderr: deps.stderr,
          verbose: deps.verbose,
          color: deps.verboseColor,
          modelId: parsedModelEffective.canonical,
          env: deps.envForRun,
        }),
      })
      deps.llmCalls.push({
        provider: result.provider,
        model: result.canonicalModelId,
        usage: result.usage,
        purpose: 'summary',
      })
      const summary = result.text.trim()
      if (!summary) throw new Error('LLM returned an empty summary')
      const displayCanonical = attempt.userModelId.toLowerCase().startsWith('openrouter/')
        ? attempt.userModelId
        : parsedModelEffective.canonical
      return {
        summary,
        summaryAlreadyPrinted: false,
        modelMeta: {
          provider: parsedModelEffective.provider,
          canonical: displayCanonical,
        },
        maxOutputTokensForCall: maxOutputTokensForCall ?? null,
      }
    }

    const shouldRenderMarkdownToAnsi = !deps.plain && isRichTty(deps.stdout)
    const hasStreamHandler = Boolean(streamHandler)
    const shouldStreamSummaryToStdout =
      streamingEnabledForCall && !shouldRenderMarkdownToAnsi && !hasStreamHandler
    const shouldStreamRenderedMarkdownToStdout =
      streamingEnabledForCall && shouldRenderMarkdownToAnsi && !hasStreamHandler

    let summaryAlreadyPrinted = false
    let summary = ''
    let getLastStreamError: (() => unknown) | null = null

    let streamResult: Awaited<ReturnType<typeof streamTextWithModelId>> | null = null
    try {
      streamResult = await streamTextWithModelId({
        modelId: parsedModelEffective.canonical,
        apiKeys: apiKeysForLlm,
        forceOpenRouter: attempt.forceOpenRouter,
        openaiBaseUrlOverride: attempt.openaiBaseUrlOverride ?? deps.providerBaseUrls.openai,
        anthropicBaseUrlOverride: deps.providerBaseUrls.anthropic,
        googleBaseUrlOverride: deps.providerBaseUrls.google,
        xaiBaseUrlOverride: deps.providerBaseUrls.xai,
        forceChatCompletions,
        prompt,
        temperature: 0,
        maxOutputTokens: maxOutputTokensForCall ?? undefined,
        timeoutMs: deps.timeoutMs,
        fetchImpl: deps.trackedFetch,
      })
    } catch (error) {
      if (isStreamingTimeoutError(error)) {
        writeVerbose(
          deps.stderr,
          deps.verbose,
          `Streaming timed out for ${parsedModelEffective.canonical}; falling back to non-streaming.`,
          deps.verboseColor,
          deps.envForRun
        )
        const result = await summarizeWithModelId({
          modelId: parsedModelEffective.canonical,
          prompt,
          maxOutputTokens: maxOutputTokensForCall ?? undefined,
          timeoutMs: deps.timeoutMs,
          fetchImpl: deps.trackedFetch,
          apiKeys: apiKeysForLlm,
          forceOpenRouter: attempt.forceOpenRouter,
          openaiBaseUrlOverride: attempt.openaiBaseUrlOverride ?? deps.providerBaseUrls.openai,
          anthropicBaseUrlOverride: deps.providerBaseUrls.anthropic,
          googleBaseUrlOverride: deps.providerBaseUrls.google,
          xaiBaseUrlOverride: deps.providerBaseUrls.xai,
          forceChatCompletions,
          retries: deps.retries,
          onRetry: createRetryLogger({
            stderr: deps.stderr,
            verbose: deps.verbose,
            color: deps.verboseColor,
            modelId: parsedModelEffective.canonical,
            env: deps.envForRun,
          }),
        })
        deps.llmCalls.push({
          provider: result.provider,
          model: result.canonicalModelId,
          usage: result.usage,
          purpose: 'summary',
        })
        summary = result.text
        streamResult = null
      } else if (
        parsedModelEffective.provider === 'google' &&
        isGoogleStreamingUnsupportedError(error)
      ) {
        writeVerbose(
          deps.stderr,
          deps.verbose,
          `Google model ${parsedModelEffective.canonical} rejected streamGenerateContent; falling back to non-streaming.`,
          deps.verboseColor,
          deps.envForRun
        )
        const result = await summarizeWithModelId({
          modelId: parsedModelEffective.canonical,
          prompt,
          maxOutputTokens: maxOutputTokensForCall ?? undefined,
          timeoutMs: deps.timeoutMs,
          fetchImpl: deps.trackedFetch,
          apiKeys: apiKeysForLlm,
          forceOpenRouter: attempt.forceOpenRouter,
          openaiBaseUrlOverride: attempt.openaiBaseUrlOverride ?? deps.providerBaseUrls.openai,
          anthropicBaseUrlOverride: deps.providerBaseUrls.anthropic,
          googleBaseUrlOverride: deps.providerBaseUrls.google,
          xaiBaseUrlOverride: deps.providerBaseUrls.xai,
          retries: deps.retries,
          onRetry: createRetryLogger({
            stderr: deps.stderr,
            verbose: deps.verbose,
            color: deps.verboseColor,
            modelId: parsedModelEffective.canonical,
            env: deps.envForRun,
          }),
        })
        deps.llmCalls.push({
          provider: result.provider,
          model: result.canonicalModelId,
          usage: result.usage,
          purpose: 'summary',
        })
        summary = result.text
        streamResult = null
      } else {
        throw error
      }
    }

    if (streamResult) {
      deps.clearProgressForStdout()
      deps.restoreProgressAfterStdout?.()
      getLastStreamError = streamResult.lastError
      let streamed = ''
      let streamedRaw = ''
      const liveWidth = markdownRenderWidth(deps.stdout, deps.env)
      let wroteLeadingBlankLine = false

      const streamer = shouldStreamRenderedMarkdownToStdout
        ? createMarkdownStreamer({
            render: (markdown) =>
              renderMarkdownAnsi(prepareMarkdownForTerminalStreaming(markdown), {
                width: liveWidth,
                wrap: true,
                color: supportsColor(deps.stdout, deps.envForRun),
                hyperlinks: true,
              }),
            spacing: 'single',
          })
        : null

      const outputGate = shouldStreamSummaryToStdout
        ? createStreamOutputGate({
            stdout: deps.stdout,
            clearProgressForStdout: deps.clearProgressForStdout,
            restoreProgressAfterStdout: deps.restoreProgressAfterStdout ?? null,
            outputMode: deps.streamingOutputMode ?? 'line',
            richTty: isRichTty(deps.stdout),
          })
        : null

      try {
        for await (const delta of streamResult.textStream) {
          const prevStreamed = streamed
          const merged = mergeStreamingChunk(streamed, delta)
          streamed = merged.next
          if (streamHandler) {
            await streamHandler.onChunk({
              streamed: merged.next,
              prevStreamed,
              appended: merged.appended,
            })
            continue
          }
          if (shouldStreamSummaryToStdout && outputGate) {
            outputGate.handleChunk(streamed, prevStreamed)
            continue
          }

          if (shouldStreamRenderedMarkdownToStdout && streamer) {
            const out = streamer.push(merged.appended)
            if (out) {
              deps.clearProgressForStdout()
              if (!wroteLeadingBlankLine) {
                deps.stdout.write(`\n${out.replace(/^\n+/, '')}`)
                wroteLeadingBlankLine = true
              } else {
                deps.stdout.write(out)
              }
              deps.restoreProgressAfterStdout?.()
            }
          }
        }

        streamedRaw = streamed
        const trimmed = streamed.trim()
        streamed = trimmed
      } finally {
        if (streamHandler) {
          await streamHandler.onDone?.(streamedRaw || streamed)
          summaryAlreadyPrinted = true
        } else if (shouldStreamRenderedMarkdownToStdout) {
          const out = streamer?.finish()
          if (out) {
            deps.clearProgressForStdout()
            if (!wroteLeadingBlankLine) {
              deps.stdout.write(`\n${out.replace(/^\n+/, '')}`)
              wroteLeadingBlankLine = true
            } else {
              deps.stdout.write(out)
            }
            deps.restoreProgressAfterStdout?.()
          }
          summaryAlreadyPrinted = true
        }
      }
      const usage = await streamResult.usage
      deps.llmCalls.push({
        provider: streamResult.provider,
        model: streamResult.canonicalModelId,
        usage,
        purpose: 'summary',
      })
      summary = streamed
      if (shouldStreamSummaryToStdout) {
        const finalText = streamedRaw || streamed
        outputGate?.finalize(finalText)
        summaryAlreadyPrinted = true
      }
    }

    summary = summary.trim()
    if (summary.length === 0) {
      const last = getLastStreamError?.()
      if (last instanceof Error) {
        throw new Error(last.message, { cause: last })
      }
      throw new Error('LLM returned an empty summary')
    }

    if (!streamResult && streamHandler) {
      const cleaned = summary.trim()
      await streamHandler.onChunk({ streamed: cleaned, prevStreamed: '', appended: cleaned })
      await streamHandler.onDone?.(cleaned)
      summaryAlreadyPrinted = true
    }

    return {
      summary,
      summaryAlreadyPrinted,
      modelMeta: {
        provider: parsedModelEffective.provider,
        canonical: attempt.userModelId.toLowerCase().startsWith('openrouter/')
          ? attempt.userModelId
          : parsedModelEffective.canonical,
      },
      maxOutputTokensForCall: maxOutputTokensForCall ?? null,
    }
  }

  return {
    applyZaiOverrides,
    envHasKeyFor,
    formatMissingModelError,
    runSummaryAttempt,
  }
}
