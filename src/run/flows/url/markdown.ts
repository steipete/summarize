import type { ModelAttempt } from "../../types.js";
import type { UrlFlowContext } from "./types.js";
import { createHtmlToMarkdownConverter } from "../../../llm/html-to-markdown.js";
import { parseGatewayStyleModelId } from "../../../llm/model-id.js";
import {
  type ConvertTranscriptToMarkdown,
  createTranscriptToMarkdownConverter,
} from "../../../llm/transcript-to-markdown.js";
import { convertToMarkdownWithMarkitdown } from "../../../markitdown.js";
import { hasUvxCli } from "../../env.js";
import { createRetryLogger } from "../../logging.js";

export type MarkdownModel = {
  llmModelId: string;
  forceOpenRouter: boolean;
  openaiApiKeyOverride?: string | null;
  openaiBaseUrlOverride?: string | null;
  forceChatCompletions?: boolean;
  requiredEnv?: ModelAttempt["requiredEnv"];
};

export type MarkdownConverters = {
  markdownRequested: boolean;
  transcriptMarkdownRequested: boolean;
  effectiveMarkdownMode: "off" | "auto" | "llm" | "readability";
  markdownProvider: "none" | "xai" | "openai" | "google" | "anthropic" | "zai" | "nvidia" | "vertex";
  markdownModel: MarkdownModel | null;
  convertHtmlToMarkdown:
    | ((args: {
        url: string;
        html: string;
        title: string | null;
        siteName: string | null;
        timeoutMs: number;
      }) => Promise<string>)
    | null;
  convertTranscriptToMarkdown: ConvertTranscriptToMarkdown | null;
};

export function createMarkdownConverters(
  ctx: UrlFlowContext,
  options: { isYoutubeUrl: boolean },
): MarkdownConverters {
  // HTML markdown conversion (for non-YouTube URLs)
  const wantsHtmlMarkdown = ctx.flags.format === "markdown" && !options.isYoutubeUrl;
  if (wantsHtmlMarkdown && ctx.flags.markdownMode === "off") {
    throw new Error("--format md conflicts with --markdown-mode off (use --format text)");
  }

  // Transcript markdown conversion (for YouTube URLs, only when --markdown-mode llm is explicit)
  const wantsTranscriptMarkdown =
    ctx.flags.format === "markdown" &&
    options.isYoutubeUrl &&
    ctx.flags.markdownMode === "llm" &&
    !ctx.flags.transcriptTimestamps;

  const markdownRequested = wantsHtmlMarkdown;
  const transcriptMarkdownRequested = wantsTranscriptMarkdown;
  const effectiveMarkdownMode =
    markdownRequested || transcriptMarkdownRequested ? ctx.flags.markdownMode : "off";

  const markdownModel: MarkdownModel | null = (() => {
    if (!markdownRequested && !transcriptMarkdownRequested) return null;

    // Prefer the explicitly chosen model when it is a native provider (keeps behavior stable).
    if (
      ctx.model.requestedModel.kind === "fixed" &&
      ctx.model.requestedModel.transport === "native"
    ) {
      if (ctx.model.fixedModelSpec?.requiredEnv === "Z_AI_API_KEY") {
        return {
          llmModelId: ctx.model.requestedModel.llmModelId,
          forceOpenRouter: false,
          requiredEnv: ctx.model.fixedModelSpec.requiredEnv,
          openaiApiKeyOverride: ctx.model.apiStatus.zaiApiKey,
          openaiBaseUrlOverride: ctx.model.apiStatus.zaiBaseUrl,
          forceChatCompletions: true,
        };
      }
      if (ctx.model.fixedModelSpec?.requiredEnv === "NVIDIA_API_KEY") {
        return {
          llmModelId: ctx.model.requestedModel.llmModelId,
          forceOpenRouter: false,
          requiredEnv: ctx.model.fixedModelSpec.requiredEnv,
          openaiApiKeyOverride: ctx.model.apiStatus.nvidiaApiKey,
          openaiBaseUrlOverride: ctx.model.apiStatus.nvidiaBaseUrl,
          forceChatCompletions: true,
        };
      }
      return {
        llmModelId: ctx.model.requestedModel.llmModelId,
        forceOpenRouter: false,
        requiredEnv: ctx.model.fixedModelSpec?.requiredEnv,
        forceChatCompletions: ctx.model.openaiUseChatCompletions,
      };
    }

    // Otherwise pick a safe, broadly-capable default for HTML→Markdown conversion.
    if (ctx.model.apiStatus.googleConfigured) {
      return {
        llmModelId: "google/gemini-3-flash-preview",
        forceOpenRouter: false,
        requiredEnv: "GEMINI_API_KEY",
      };
    }
    if (ctx.model.apiStatus.apiKey) {
      return {
        llmModelId: "openai/gpt-5-mini",
        forceOpenRouter: false,
        requiredEnv: "OPENAI_API_KEY",
        forceChatCompletions: ctx.model.openaiUseChatCompletions,
      };
    }
    if (ctx.model.apiStatus.openrouterConfigured) {
      return {
        llmModelId: "openai/openai/gpt-5-mini",
        forceOpenRouter: true,
        requiredEnv: "OPENROUTER_API_KEY",
      };
    }
    if (ctx.model.apiStatus.anthropicConfigured) {
      return {
        llmModelId: "anthropic/claude-sonnet-4-5",
        forceOpenRouter: false,
        requiredEnv: "ANTHROPIC_API_KEY",
      };
    }
    if (ctx.model.apiStatus.xaiApiKey) {
      return {
        llmModelId: "xai/grok-4-fast-non-reasoning",
        forceOpenRouter: false,
        requiredEnv: "XAI_API_KEY",
      };
    }

    return null;
  })();

  const markdownProvider = (() => {
    if (!markdownModel) return "none" as const;
    const parsed = parseGatewayStyleModelId(markdownModel.llmModelId);
    return parsed.provider;
  })();

  const hasKeyForMarkdownModel = (() => {
    if (!markdownModel) return false;
    if (markdownModel.forceOpenRouter) return ctx.model.apiStatus.openrouterConfigured;
    if (markdownModel.requiredEnv === "Z_AI_API_KEY") return Boolean(ctx.model.apiStatus.zaiApiKey);
    if (markdownModel.requiredEnv === "NVIDIA_API_KEY")
      return Boolean(ctx.model.apiStatus.nvidiaApiKey);
    if (markdownModel.openaiApiKeyOverride) return true;
    const parsed = parseGatewayStyleModelId(markdownModel.llmModelId);
    return parsed.provider === "xai"
      ? Boolean(ctx.model.apiStatus.xaiApiKey)
      : parsed.provider === "google"
        ? ctx.model.apiStatus.googleConfigured
        : parsed.provider === "anthropic"
          ? ctx.model.apiStatus.anthropicConfigured
          : parsed.provider === "zai"
            ? Boolean(ctx.model.apiStatus.zaiApiKey)
            : parsed.provider === "nvidia"
              ? Boolean(ctx.model.apiStatus.nvidiaApiKey)
              : Boolean(ctx.model.apiStatus.apiKey);
  })();

  if (
    (markdownRequested || transcriptMarkdownRequested) &&
    effectiveMarkdownMode === "llm" &&
    !hasKeyForMarkdownModel
  ) {
    const required = (() => {
      if (markdownModel?.forceOpenRouter) return "OPENROUTER_API_KEY";
      if (markdownModel?.requiredEnv === "Z_AI_API_KEY") return "Z_AI_API_KEY";
      if (markdownModel?.requiredEnv === "NVIDIA_API_KEY") return "NVIDIA_API_KEY";
      if (markdownModel) {
        const parsed = parseGatewayStyleModelId(markdownModel.llmModelId);
        return parsed.provider === "xai"
          ? "XAI_API_KEY"
          : parsed.provider === "google"
            ? "GEMINI_API_KEY (or GOOGLE_GENERATIVE_AI_API_KEY / GOOGLE_API_KEY)"
            : parsed.provider === "anthropic"
              ? "ANTHROPIC_API_KEY"
              : parsed.provider === "zai"
                ? "Z_AI_API_KEY"
                : parsed.provider === "nvidia"
                  ? "NVIDIA_API_KEY"
                  : "OPENAI_API_KEY";
      }
      return "GEMINI_API_KEY (or GOOGLE_GENERATIVE_AI_API_KEY / GOOGLE_API_KEY)";
    })();
    throw new Error(`--markdown-mode llm requires ${required}`);
  }

  const llmHtmlToMarkdown =
    markdownRequested &&
    markdownModel !== null &&
    (effectiveMarkdownMode === "llm" || markdownProvider !== "none")
      ? createHtmlToMarkdownConverter({
          modelId: markdownModel.llmModelId,
          forceOpenRouter: markdownModel.forceOpenRouter,
          xaiApiKey: ctx.model.apiStatus.xaiApiKey,
          googleApiKey: ctx.model.apiStatus.googleApiKey,
          openaiApiKey: markdownModel.openaiApiKeyOverride ?? ctx.model.apiStatus.apiKey,
          anthropicApiKey: ctx.model.apiStatus.anthropicApiKey,
          openrouterApiKey: ctx.model.apiStatus.openrouterApiKey,
          openaiBaseUrlOverride:
            markdownModel.openaiBaseUrlOverride ?? ctx.model.apiStatus.providerBaseUrls.openai,
          anthropicBaseUrlOverride: ctx.model.apiStatus.providerBaseUrls.anthropic,
          googleBaseUrlOverride: ctx.model.apiStatus.providerBaseUrls.google,
          xaiBaseUrlOverride: ctx.model.apiStatus.providerBaseUrls.xai,
          forceChatCompletions:
            markdownModel.forceChatCompletions ??
            (ctx.model.openaiUseChatCompletions && markdownProvider === "openai"),
          fetchImpl: ctx.io.fetch,
          retries: ctx.flags.retries,
          onRetry: createRetryLogger({
            stderr: ctx.io.stderr,
            verbose: ctx.flags.verbose,
            color: ctx.flags.verboseColor,
            modelId: markdownModel.llmModelId,
            env: ctx.io.envForRun,
          }),
          onUsage: ({ model: usedModel, provider, usage }) => {
            ctx.model.llmCalls.push({ provider, model: usedModel, usage, purpose: "markdown" });
          },
        })
      : null;

  const markitdownHtmlToMarkdown =
    markdownRequested && ctx.flags.preprocessMode !== "off" && hasUvxCli(ctx.io.env)
      ? async (args: {
          url: string;
          html: string;
          title: string | null;
          siteName: string | null;
          timeoutMs: number;
        }) => {
          void args.url;
          void args.title;
          void args.siteName;
          return convertToMarkdownWithMarkitdown({
            bytes: new TextEncoder().encode(args.html),
            filenameHint: "page.html",
            mediaTypeHint: "text/html",
            uvxCommand: ctx.io.envForRun.UVX_PATH,
            timeoutMs: args.timeoutMs,
            env: ctx.io.env,
            execFileImpl: ctx.io.execFileImpl,
          });
        }
      : null;

  const convertHtmlToMarkdown = markdownRequested
    ? async (args: {
        url: string;
        html: string;
        title: string | null;
        siteName: string | null;
        timeoutMs: number;
      }) => {
        if (effectiveMarkdownMode === "llm") {
          if (!llmHtmlToMarkdown) {
            throw new Error("No HTML→Markdown converter configured");
          }
          return llmHtmlToMarkdown(args);
        }

        if (ctx.flags.extractMode) {
          if (markitdownHtmlToMarkdown) {
            return await markitdownHtmlToMarkdown(args);
          }
          throw new Error(
            "No HTML→Markdown converter configured (install uvx/markitdown or use --markdown-mode llm)",
          );
        }

        if (llmHtmlToMarkdown) {
          try {
            return await llmHtmlToMarkdown(args);
          } catch (error) {
            if (!markitdownHtmlToMarkdown) throw error;
            return await markitdownHtmlToMarkdown(args);
          }
        }

        if (markitdownHtmlToMarkdown) {
          return await markitdownHtmlToMarkdown(args);
        }

        throw new Error("No HTML→Markdown converter configured");
      }
    : null;

  // Transcript→Markdown converter (only for YouTube with --markdown-mode llm)
  const convertTranscriptToMarkdown: ConvertTranscriptToMarkdown | null =
    transcriptMarkdownRequested && markdownModel !== null
      ? createTranscriptToMarkdownConverter({
          modelId: markdownModel.llmModelId,
          forceOpenRouter: markdownModel.forceOpenRouter,
          xaiApiKey: ctx.model.apiStatus.xaiApiKey,
          googleApiKey: ctx.model.apiStatus.googleApiKey,
          openaiApiKey: markdownModel.openaiApiKeyOverride ?? ctx.model.apiStatus.apiKey,
          anthropicApiKey: ctx.model.apiStatus.anthropicApiKey,
          openrouterApiKey: ctx.model.apiStatus.openrouterApiKey,
          openaiBaseUrlOverride:
            markdownModel.openaiBaseUrlOverride ?? ctx.model.apiStatus.providerBaseUrls.openai,
          anthropicBaseUrlOverride: ctx.model.apiStatus.providerBaseUrls.anthropic,
          googleBaseUrlOverride: ctx.model.apiStatus.providerBaseUrls.google,
          xaiBaseUrlOverride: ctx.model.apiStatus.providerBaseUrls.xai,
          forceChatCompletions:
            markdownModel.forceChatCompletions ??
            (ctx.model.openaiUseChatCompletions && markdownProvider === "openai"),
          fetchImpl: ctx.io.fetch,
          retries: ctx.flags.retries,
          onRetry: createRetryLogger({
            stderr: ctx.io.stderr,
            verbose: ctx.flags.verbose,
            color: ctx.flags.verboseColor,
            modelId: markdownModel.llmModelId,
            env: ctx.io.envForRun,
          }),
          onUsage: ({ model: usedModel, provider, usage }) => {
            ctx.model.llmCalls.push({ provider, model: usedModel, usage, purpose: "markdown" });
          },
        })
      : null;

  return {
    markdownRequested,
    transcriptMarkdownRequested,
    effectiveMarkdownMode,
    markdownProvider,
    markdownModel,
    convertHtmlToMarkdown,
    convertTranscriptToMarkdown,
  };
}
