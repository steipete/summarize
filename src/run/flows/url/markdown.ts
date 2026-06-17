import { resolveFixedModelAttempt } from "../../../application/model-attempts.js";
import type { ModelAttempt } from "../../../engine/types.js";
import { createHtmlToMarkdownConverter } from "../../../llm/html-to-markdown.js";
import { parseGatewayStyleModelId } from "../../../llm/model-id.js";
import { mergeRequestOptionsForProvider } from "../../../llm/model-options.js";
import {
  type ConvertTranscriptToMarkdown,
  createTranscriptToMarkdownConverter,
} from "../../../llm/transcript-to-markdown.js";
import { convertToMarkdownWithMarkitdown } from "../../../markitdown.js";
import { parseRequestedModelId } from "../../../model-spec.js";
import { hasUvxCli } from "../../env.js";
import { createRetryLogger } from "../../logging.js";
import type { UrlFlowContext } from "./types.js";

export type MarkdownModel = ModelAttempt & {
  transport: "native" | "openrouter";
  llmModelId: string;
};

export type MarkdownConverters = {
  markdownRequested: boolean;
  transcriptMarkdownRequested: boolean;
  effectiveMarkdownMode: "off" | "auto" | "llm" | "readability";
  markdownProvider:
    | "none"
    | "xai"
    | "openai"
    | "google"
    | "anthropic"
    | "evolink"
    | "zai"
    | "nvidia"
    | "minimax"
    | "github-copilot"
    | "ollama";
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

  const resolveMarkdownModel = (modelId: string): MarkdownModel => {
    const requested = parseRequestedModelId(modelId);
    if (requested.kind !== "fixed" || requested.transport === "cli") {
      throw new Error(`Internal error: unsupported markdown model ${modelId}`);
    }
    const attempt = resolveFixedModelAttempt({
      requestedModel: requested,
      providerRuntime: ctx.model.summaryEngine.providerRuntime,
    });
    if (attempt.transport === "cli" || !attempt.llmModelId) {
      throw new Error(`Internal error: unsupported markdown model ${modelId}`);
    }
    return attempt as MarkdownModel;
  };

  const markdownModel: MarkdownModel | null = (() => {
    if (!markdownRequested && !transcriptMarkdownRequested) return null;

    // Prefer the explicitly chosen native model; otherwise choose the first configured default.
    if (
      ctx.model.requestedModel.kind === "fixed" &&
      ctx.model.requestedModel.transport === "native"
    ) {
      const attempt = resolveFixedModelAttempt({
        requestedModel: ctx.model.requestedModel,
        providerRuntime: ctx.model.summaryEngine.providerRuntime,
      });
      if (attempt.transport === "cli" || !attempt.llmModelId) {
        throw new Error("Internal error: unsupported fixed markdown model");
      }
      return attempt as MarkdownModel;
    }
    if (ctx.model.apiStatus.googleConfigured) {
      return resolveMarkdownModel("google/gemini-3-flash");
    }
    if (ctx.model.apiStatus.apiKey) {
      return resolveMarkdownModel("openai/gpt-5-mini");
    }
    if (ctx.model.apiStatus.openrouterConfigured) {
      return resolveMarkdownModel("openrouter/openai/gpt-5-mini");
    }
    if (ctx.model.apiStatus.anthropicConfigured) {
      return resolveMarkdownModel("anthropic/claude-sonnet-4-5");
    }
    if (ctx.model.apiStatus.xaiApiKey) {
      return resolveMarkdownModel("xai/grok-4-fast-non-reasoning");
    }
    return null;
  })();

  const markdownProvider = (() => {
    if (!markdownModel) return "none" as const;
    const parsed = parseGatewayStyleModelId(markdownModel.llmModelId);
    return parsed.provider;
  })();

  const hasKeyForMarkdownModel = markdownModel
    ? ctx.model.summaryEngine.envHasKeyFor(markdownModel.requiredEnv)
    : false;

  if (
    (markdownRequested || transcriptMarkdownRequested) &&
    effectiveMarkdownMode === "llm" &&
    !hasKeyForMarkdownModel
  ) {
    const required =
      markdownModel?.requiredEnv === "GEMINI_API_KEY"
        ? "GEMINI_API_KEY (or GOOGLE_GENERATIVE_AI_API_KEY / GOOGLE_API_KEY)"
        : markdownModel?.requiredEnv === "GITHUB_TOKEN"
          ? "GITHUB_TOKEN (or GH_TOKEN)"
          : (markdownModel?.requiredEnv ??
            "GEMINI_API_KEY (or GOOGLE_GENERATIVE_AI_API_KEY / GOOGLE_API_KEY)");
    throw new Error(`--markdown-mode llm requires ${required}`);
  }

  const llmConverterOptions = markdownModel
    ? ({
        modelId: markdownModel.llmModelId,
        forceOpenRouter: markdownModel.forceOpenRouter,
        xaiApiKey: ctx.model.apiStatus.xaiApiKey,
        googleApiKey: ctx.model.apiStatus.googleApiKey,
        openaiApiKey:
          markdownModel.openaiApiKeyOverride === undefined
            ? ctx.model.apiStatus.apiKey
            : markdownModel.openaiApiKeyOverride,
        anthropicApiKey: ctx.model.apiStatus.anthropicApiKey,
        openrouterApiKey: ctx.model.apiStatus.openrouterApiKey,
        openaiBaseUrlOverride: markdownModel.openaiBaseUrlOverride,
        ollamaBaseUrlOverride:
          markdownProvider === "ollama" ? markdownModel.openaiBaseUrlOverride : undefined,
        anthropicBaseUrlOverride: ctx.model.apiStatus.providerBaseUrls.anthropic,
        googleBaseUrlOverride: ctx.model.apiStatus.providerBaseUrls.google,
        xaiBaseUrlOverride: ctx.model.apiStatus.providerBaseUrls.xai,
        forceChatCompletions: markdownModel.forceChatCompletions,
        requestOptions: mergeRequestOptionsForProvider({
          provider: markdownProvider,
          openaiGlobalDefault: ctx.model.openaiRequestOptions,
          attemptOptions: markdownModel.requestOptions,
          openaiOverride: ctx.model.openaiRequestOptionsOverride,
          cliReasoningEffortOverride: ctx.model.cliReasoningEffortOverride,
        }),
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
      } satisfies Parameters<typeof createHtmlToMarkdownConverter>[0])
    : null;

  const llmHtmlToMarkdown =
    markdownRequested &&
    llmConverterOptions !== null &&
    (effectiveMarkdownMode === "llm" || markdownProvider !== "none")
      ? createHtmlToMarkdownConverter(llmConverterOptions)
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
          const { markdown } = await convertToMarkdownWithMarkitdown({
            bytes: new TextEncoder().encode(args.html),
            filenameHint: "page.html",
            mediaTypeHint: "text/html",
            uvxCommand: ctx.io.envForRun.UVX_PATH,
            timeoutMs: args.timeoutMs,
            env: ctx.io.env,
            execFileImpl: ctx.io.execFileImpl,
          });
          return markdown;
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
    transcriptMarkdownRequested && llmConverterOptions !== null
      ? createTranscriptToMarkdownConverter(llmConverterOptions)
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
