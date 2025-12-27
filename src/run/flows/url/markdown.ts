import { createHtmlToMarkdownConverter } from '../../../llm/html-to-markdown.js'
import {
  createTranscriptToMarkdownConverter,
  type ConvertTranscriptToMarkdown,
} from '../../../llm/transcript-to-markdown.js'
import { parseGatewayStyleModelId } from '../../../llm/model-id.js'
import { convertToMarkdownWithMarkitdown } from '../../../markitdown.js'
import { hasUvxCli } from '../../env.js'
import { createRetryLogger } from '../../logging.js'
import type { ModelAttempt } from '../../types.js'
import type { UrlFlowContext } from './types.js'

export type MarkdownModel = {
  llmModelId: string
  forceOpenRouter: boolean
  openaiApiKeyOverride?: string | null
  openaiBaseUrlOverride?: string | null
  forceChatCompletions?: boolean
  requiredEnv?: ModelAttempt['requiredEnv']
}

export type MarkdownConverters = {
  markdownRequested: boolean
  transcriptMarkdownRequested: boolean
  effectiveMarkdownMode: 'off' | 'auto' | 'llm' | 'readability'
  markdownProvider: 'none' | 'xai' | 'openai' | 'google' | 'anthropic' | 'zai'
  markdownModel: MarkdownModel | null
  convertHtmlToMarkdown:
    | ((args: {
        url: string
        html: string
        title: string | null
        siteName: string | null
        timeoutMs: number
      }) => Promise<string>)
    | null
  convertTranscriptToMarkdown: ConvertTranscriptToMarkdown | null
}

export function createMarkdownConverters(
  ctx: UrlFlowContext,
  options: { isYoutubeUrl: boolean }
): MarkdownConverters {
  // HTML markdown conversion (for non-YouTube URLs)
  const wantsHtmlMarkdown = ctx.format === 'markdown' && !options.isYoutubeUrl
  if (wantsHtmlMarkdown && ctx.markdownMode === 'off') {
    throw new Error('--format md conflicts with --markdown-mode off (use --format text)')
  }

  // Transcript markdown conversion (for YouTube URLs, only when --markdown-mode llm is explicit)
  const wantsTranscriptMarkdown =
    ctx.format === 'markdown' && options.isYoutubeUrl && ctx.markdownMode === 'llm'

  const markdownRequested = wantsHtmlMarkdown
  const transcriptMarkdownRequested = wantsTranscriptMarkdown
  const effectiveMarkdownMode = markdownRequested || transcriptMarkdownRequested ? ctx.markdownMode : 'off'

  const markdownModel: MarkdownModel | null = (() => {
    if (!markdownRequested && !transcriptMarkdownRequested) return null

    // Prefer the explicitly chosen model when it is a native provider (keeps behavior stable).
    if (ctx.requestedModel.kind === 'fixed' && ctx.requestedModel.transport === 'native') {
      if (ctx.fixedModelSpec?.requiredEnv === 'Z_AI_API_KEY') {
        return {
          llmModelId: ctx.requestedModel.llmModelId,
          forceOpenRouter: false,
          requiredEnv: ctx.fixedModelSpec.requiredEnv,
          openaiApiKeyOverride: ctx.apiStatus.zaiApiKey,
          openaiBaseUrlOverride: ctx.apiStatus.zaiBaseUrl,
          forceChatCompletions: true,
        }
      }
      return {
        llmModelId: ctx.requestedModel.llmModelId,
        forceOpenRouter: false,
        requiredEnv: ctx.fixedModelSpec?.requiredEnv,
        forceChatCompletions: ctx.openaiUseChatCompletions,
      }
    }

    // Otherwise pick a safe, broadly-capable default for HTML→Markdown conversion.
    if (ctx.apiStatus.googleConfigured) {
      return {
        llmModelId: 'google/gemini-3-flash-preview',
        forceOpenRouter: false,
        requiredEnv: 'GEMINI_API_KEY',
      }
    }
    if (ctx.apiStatus.apiKey) {
      return {
        llmModelId: 'openai/gpt-5-mini',
        forceOpenRouter: false,
        requiredEnv: 'OPENAI_API_KEY',
        forceChatCompletions: ctx.openaiUseChatCompletions,
      }
    }
    if (ctx.apiStatus.openrouterConfigured) {
      return {
        llmModelId: 'openai/openai/gpt-5-mini',
        forceOpenRouter: true,
        requiredEnv: 'OPENROUTER_API_KEY',
      }
    }
    if (ctx.apiStatus.anthropicConfigured) {
      return {
        llmModelId: 'anthropic/claude-sonnet-4-5',
        forceOpenRouter: false,
        requiredEnv: 'ANTHROPIC_API_KEY',
      }
    }
    if (ctx.apiStatus.xaiApiKey) {
      return {
        llmModelId: 'xai/grok-4-fast-non-reasoning',
        forceOpenRouter: false,
        requiredEnv: 'XAI_API_KEY',
      }
    }

    return null
  })()

  const markdownProvider = (() => {
    if (!markdownModel) return 'none' as const
    const parsed = parseGatewayStyleModelId(markdownModel.llmModelId)
    return parsed.provider
  })()

  const hasKeyForMarkdownModel = (() => {
    if (!markdownModel) return false
    if (markdownModel.forceOpenRouter) return ctx.apiStatus.openrouterConfigured
    if (markdownModel.requiredEnv === 'Z_AI_API_KEY') return Boolean(ctx.apiStatus.zaiApiKey)
    if (markdownModel.openaiApiKeyOverride) return true
    const parsed = parseGatewayStyleModelId(markdownModel.llmModelId)
    return parsed.provider === 'xai'
      ? Boolean(ctx.apiStatus.xaiApiKey)
      : parsed.provider === 'google'
        ? ctx.apiStatus.googleConfigured
        : parsed.provider === 'anthropic'
          ? ctx.apiStatus.anthropicConfigured
          : parsed.provider === 'zai'
            ? Boolean(ctx.apiStatus.zaiApiKey)
            : Boolean(ctx.apiStatus.apiKey)
  })()

  if ((markdownRequested || transcriptMarkdownRequested) && effectiveMarkdownMode === 'llm' && !hasKeyForMarkdownModel) {
    const required = (() => {
      if (markdownModel?.forceOpenRouter) return 'OPENROUTER_API_KEY'
      if (markdownModel?.requiredEnv === 'Z_AI_API_KEY') return 'Z_AI_API_KEY'
      if (markdownModel) {
        const parsed = parseGatewayStyleModelId(markdownModel.llmModelId)
        return parsed.provider === 'xai'
          ? 'XAI_API_KEY'
          : parsed.provider === 'google'
            ? 'GEMINI_API_KEY (or GOOGLE_GENERATIVE_AI_API_KEY / GOOGLE_API_KEY)'
            : parsed.provider === 'anthropic'
              ? 'ANTHROPIC_API_KEY'
              : parsed.provider === 'zai'
                ? 'Z_AI_API_KEY'
                : 'OPENAI_API_KEY'
      }
      return 'GEMINI_API_KEY (or GOOGLE_GENERATIVE_AI_API_KEY / GOOGLE_API_KEY)'
    })()
    throw new Error(`--markdown-mode llm requires ${required}`)
  }

  const llmHtmlToMarkdown =
    markdownRequested &&
    markdownModel !== null &&
    (effectiveMarkdownMode === 'llm' || markdownProvider !== 'none')
      ? createHtmlToMarkdownConverter({
          modelId: markdownModel.llmModelId,
          forceOpenRouter: markdownModel.forceOpenRouter,
          xaiApiKey: ctx.apiStatus.xaiApiKey,
          googleApiKey: ctx.apiStatus.googleApiKey,
          openaiApiKey: markdownModel.openaiApiKeyOverride ?? ctx.apiStatus.apiKey,
          anthropicApiKey: ctx.apiStatus.anthropicApiKey,
          openrouterApiKey: ctx.apiStatus.openrouterApiKey,
          openaiBaseUrlOverride: markdownModel.openaiBaseUrlOverride ?? null,
          forceChatCompletions:
            markdownModel.forceChatCompletions ??
            (ctx.openaiUseChatCompletions && markdownProvider === 'openai'),
          fetchImpl: ctx.trackedFetch,
          retries: ctx.retries,
          onRetry: createRetryLogger({
            stderr: ctx.stderr,
            verbose: ctx.verbose,
            color: ctx.verboseColor,
            modelId: markdownModel.llmModelId,
          }),
          onUsage: ({ model: usedModel, provider, usage }) => {
            ctx.llmCalls.push({ provider, model: usedModel, usage, purpose: 'markdown' })
          },
        })
      : null

  const markitdownHtmlToMarkdown =
    markdownRequested && ctx.preprocessMode !== 'off' && hasUvxCli(ctx.env)
      ? async (args: {
          url: string
          html: string
          title: string | null
          siteName: string | null
          timeoutMs: number
        }) => {
          void args.url
          void args.title
          void args.siteName
          return convertToMarkdownWithMarkitdown({
            bytes: new TextEncoder().encode(args.html),
            filenameHint: 'page.html',
            mediaTypeHint: 'text/html',
            uvxCommand: ctx.envForRun.UVX_PATH,
            timeoutMs: args.timeoutMs,
            env: ctx.env,
            execFileImpl: ctx.execFileImpl,
          })
        }
      : null

  const convertHtmlToMarkdown = markdownRequested
    ? async (args: {
        url: string
        html: string
        title: string | null
        siteName: string | null
        timeoutMs: number
      }) => {
        if (effectiveMarkdownMode === 'llm') {
          if (!llmHtmlToMarkdown) {
            throw new Error('No HTML→Markdown converter configured')
          }
          return llmHtmlToMarkdown(args)
        }

        if (ctx.extractMode) {
          if (markitdownHtmlToMarkdown) {
            return await markitdownHtmlToMarkdown(args)
          }
          throw new Error(
            'No HTML→Markdown converter configured (install uvx/markitdown or use --markdown-mode llm)'
          )
        }

        if (llmHtmlToMarkdown) {
          try {
            return await llmHtmlToMarkdown(args)
          } catch (error) {
            if (!markitdownHtmlToMarkdown) throw error
            return await markitdownHtmlToMarkdown(args)
          }
        }

        if (markitdownHtmlToMarkdown) {
          return await markitdownHtmlToMarkdown(args)
        }

        throw new Error('No HTML→Markdown converter configured')
      }
    : null

  // Transcript→Markdown converter (only for YouTube with --markdown-mode llm)
  const convertTranscriptToMarkdown: ConvertTranscriptToMarkdown | null =
    transcriptMarkdownRequested && markdownModel !== null
      ? createTranscriptToMarkdownConverter({
          modelId: markdownModel.llmModelId,
          forceOpenRouter: markdownModel.forceOpenRouter,
          xaiApiKey: ctx.apiStatus.xaiApiKey,
          googleApiKey: ctx.apiStatus.googleApiKey,
          openaiApiKey: markdownModel.openaiApiKeyOverride ?? ctx.apiStatus.apiKey,
          anthropicApiKey: ctx.apiStatus.anthropicApiKey,
          openrouterApiKey: ctx.apiStatus.openrouterApiKey,
          openaiBaseUrlOverride: markdownModel.openaiBaseUrlOverride ?? null,
          forceChatCompletions:
            markdownModel.forceChatCompletions ??
            (ctx.openaiUseChatCompletions && markdownProvider === 'openai'),
          fetchImpl: ctx.trackedFetch,
          retries: ctx.retries,
          onRetry: createRetryLogger({
            stderr: ctx.stderr,
            verbose: ctx.verbose,
            color: ctx.verboseColor,
            modelId: markdownModel.llmModelId,
          }),
          onUsage: ({ model: usedModel, provider, usage }) => {
            ctx.llmCalls.push({ provider, model: usedModel, usage, purpose: 'markdown' })
          },
        })
      : null

  return {
    markdownRequested,
    transcriptMarkdownRequested,
    effectiveMarkdownMode,
    markdownProvider,
    markdownModel,
    convertHtmlToMarkdown,
    convertTranscriptToMarkdown,
  }
}
