import { isTwitterStatusUrl, isYouTubeUrl } from "@steipete/summarize-core/content/url";
import { normalizeSummarySlideHeadings } from "@steipete/summarize-core/slides";
import {
  buildLanguageKey,
  buildLengthKey,
  buildPromptContentHash,
  buildPromptHash,
} from "../../../cache.js";
import type { ExtractedLinkContent } from "../../../content/index.js";
import { resolveGitHubModelsApiKey } from "../../../llm/github-models.js";
import type { Prompt } from "../../../llm/prompt.js";
import { buildAutoModelAttempts } from "../../../model-auto.js";
import { SUMMARY_SYSTEM_PROMPT } from "../../../prompts/index.js";
import { countTokens } from "../../../tokenizer.js";
import {
  readLastSuccessfulCliProvider,
  writeLastSuccessfulCliProvider,
} from "../../cli-fallback-state.js";
import { parseCliUserModelId } from "../../env.js";
import { writeVerbose } from "../../logging.js";
import { executeSummaryAttempts } from "../../summary-execution.js";
import type { ModelAttempt } from "../../types.js";
import type { SlidesTerminalOutput } from "./slides-output.js";
import { buildModelMetaFromAttempt } from "./summary-finish.js";
import { shouldBypassShortContentSummary } from "./summary-prompt.js";
import {
  ensureSummaryKeyMoments,
  resolveSummaryTimestampUpperBound,
  sanitizeSummaryKeyMoments,
  shouldSanitizeSummaryKeyMoments,
} from "./summary-timestamps.js";
import type { UrlFlowContext } from "./types.js";

type SlidesResult = Awaited<
  ReturnType<typeof import("../../../slides/index.js").extractSlidesForSource>
>;

type SummaryResolutionUseExtracted = {
  kind: "use-extracted";
  footerLabel: string;
  verboseMessage: string | null;
};

type SummaryResolutionSummary = {
  kind: "summary";
  normalizedSummary: string;
  summaryAlreadyPrinted: boolean;
  summaryFromCache: boolean;
  usedAttempt: ModelAttempt;
  modelMeta: ReturnType<typeof buildModelMetaFromAttempt>;
  maxOutputTokensForCall: number | null;
};

export type UrlSummaryResolution = SummaryResolutionUseExtracted | SummaryResolutionSummary;

export async function resolveUrlSummaryExecution({
  ctx,
  url,
  extracted,
  prompt,
  onModelChosen,
  slides,
  slidesOutput,
}: {
  ctx: UrlFlowContext;
  url: string;
  extracted: ExtractedLinkContent;
  prompt: string;
  onModelChosen?: ((modelId: string) => void) | null;
  slides?: SlidesResult | null;
  slidesOutput?: SlidesTerminalOutput | null;
}): Promise<UrlSummaryResolution> {
  const { io, flags, model, cache: cacheState } = ctx;
  ctx.perfTrace?.mark("summary:resolve-start");
  const lastSuccessfulCliProvider = model.isFallbackModel
    ? await readLastSuccessfulCliProvider(io.envForRun)
    : null;

  const promptPayload: Prompt = { system: SUMMARY_SYSTEM_PROMPT, userText: prompt };
  const promptTokens = countTokens(promptPayload.userText);
  const kindForAuto =
    extracted.siteName === "YouTube" ? ("youtube" as const) : ("website" as const);
  const hasSlides = Boolean(slides && slides.slides.length > 0);
  const sanitizeKeyMoments = shouldSanitizeSummaryKeyMoments({ extracted, hasSlides });
  const timestampUpperBound = sanitizeKeyMoments
    ? resolveSummaryTimestampUpperBound(extracted)
    : null;

  const attempts: ModelAttempt[] = await (async () => {
    if (model.isFallbackModel) {
      const catalog = await model.getLiteLlmCatalog();
      const list = buildAutoModelAttempts({
        kind: kindForAuto,
        promptTokens,
        desiredOutputTokens: model.desiredOutputTokens,
        requiresVideoUnderstanding: false,
        env: model.envForAuto,
        config: model.configForModelSelection,
        catalog,
        openrouterProvidersFromEnv: null,
        cliAvailability: model.cliAvailability,
        isImplicitAutoSelection: model.isImplicitAutoSelection,
        allowAutoCliFallback: model.allowAutoCliFallback,
        lastSuccessfulCliProvider,
      });
      if (flags.verbose) {
        for (const attempt of list.slice(0, 8)) {
          writeVerbose(
            io.stderr,
            flags.verbose,
            `auto candidate ${attempt.debug}`,
            flags.verboseColor,
            io.envForRun,
          );
        }
      }
      return list.map((attempt) => {
        if (attempt.transport !== "cli")
          return model.summaryEngine.applyOpenAiGatewayOverrides(attempt as ModelAttempt);
        const parsed = parseCliUserModelId(attempt.userModelId);
        return { ...attempt, cliProvider: parsed.provider, cliModel: parsed.model };
      });
    }
    /* v8 ignore next */
    if (!model.fixedModelSpec) {
      throw new Error("Internal error: missing fixed model spec");
    }
    if (model.fixedModelSpec.transport === "cli") {
      return [
        {
          transport: "cli",
          userModelId: model.fixedModelSpec.userModelId,
          llmModelId: null,
          cliProvider: model.fixedModelSpec.cliProvider,
          cliModel: model.fixedModelSpec.cliModel,
          openrouterProviders: null,
          forceOpenRouter: false,
          requiredEnv: model.fixedModelSpec.requiredEnv,
        },
      ];
    }
    const openaiOverrides =
      model.fixedModelSpec.requiredEnv === "Z_AI_API_KEY"
        ? {
            openaiApiKeyOverride: model.apiStatus.zaiApiKey,
            openaiBaseUrlOverride: model.apiStatus.zaiBaseUrl,
            forceChatCompletions: true,
          }
        : model.fixedModelSpec.requiredEnv === "NVIDIA_API_KEY"
          ? {
              openaiApiKeyOverride: model.apiStatus.nvidiaApiKey,
              openaiBaseUrlOverride: model.apiStatus.nvidiaBaseUrl,
              forceChatCompletions: true,
            }
          : model.fixedModelSpec.requiredEnv === "MINIMAX_API_KEY"
            ? {
                openaiApiKeyOverride: model.apiStatus.minimaxApiKey,
                openaiBaseUrlOverride: model.apiStatus.minimaxBaseUrl,
                forceChatCompletions: true,
              }
            : model.fixedModelSpec.requiredEnv === "OLLAMA_BASE_URL"
              ? {
                  openaiBaseUrlOverride: model.apiStatus.ollamaBaseUrl,
                  forceChatCompletions: true,
                }
              : model.fixedModelSpec.requiredEnv === "GITHUB_TOKEN"
                ? {
                    openaiApiKeyOverride: resolveGitHubModelsApiKey(io.envForRun),
                    openaiBaseUrlOverride: model.fixedModelSpec.openaiBaseUrlOverride ?? null,
                    forceChatCompletions: true,
                  }
                : {};
    return [
      {
        transport: model.fixedModelSpec.transport === "openrouter" ? "openrouter" : "native",
        userModelId: model.fixedModelSpec.userModelId,
        llmModelId: model.fixedModelSpec.llmModelId,
        openrouterProviders: model.fixedModelSpec.openrouterProviders,
        forceOpenRouter: model.fixedModelSpec.forceOpenRouter,
        requiredEnv: model.fixedModelSpec.requiredEnv,
        ...(model.fixedModelSpec.requestOptions
          ? { requestOptions: model.fixedModelSpec.requestOptions }
          : {}),
        ...openaiOverrides,
      },
    ];
  })();
  ctx.perfTrace?.mark("summary:attempts", attempts[0]?.userModelId ?? null);

  const cacheStore =
    cacheState.mode === "default" && !flags.summaryCacheBypass ? cacheState.store : null;
  const contentHash = cacheStore
    ? buildPromptContentHash({ prompt, fallbackContent: extracted.content })
    : null;
  const promptHash = cacheStore ? buildPromptHash(prompt) : null;
  const lengthKey = buildLengthKey(flags.lengthArg);
  const languageKey = buildLanguageKey(flags.outputLanguage);
  const autoSelectionCacheModel = model.isFallbackModel
    ? `selection:${model.requestedModelInput.toLowerCase()}`
    : null;

  const isTweet = extracted.siteName?.toLowerCase() === "x" || isTwitterStatusUrl(extracted.url);
  const isYouTube = extracted.siteName === "YouTube" || isYouTubeUrl(url);
  const hasMedia =
    Boolean(extracted.video) ||
    (extracted.transcriptSource != null && extracted.transcriptSource !== "unavailable") ||
    (typeof extracted.mediaDurationSeconds === "number" && extracted.mediaDurationSeconds > 0) ||
    extracted.isVideoOnly === true;
  const autoBypass = ctx.model.isFallbackModel && !ctx.model.isNamedModelSelection;
  const canBypassShortContent =
    (autoBypass || isTweet) &&
    !flags.slides &&
    !hasMedia &&
    flags.streamMode !== "on" &&
    !isYouTube &&
    shouldBypassShortContentSummary({
      extracted,
      lengthArg: flags.lengthArg,
      forceSummary: flags.forceSummary,
      maxOutputTokensArg: flags.maxOutputTokensArg,
      json: flags.json,
      countTokens,
    });

  if (canBypassShortContent) {
    return {
      kind: "use-extracted",
      footerLabel: "short content",
      verboseMessage: "short content: skipping summary",
    };
  }

  const execution = await executeSummaryAttempts({
    attempts,
    isFallbackModel: model.isFallbackModel,
    isNamedModelSelection: model.isNamedModelSelection,
    wantsFreeNamedModel: model.wantsFreeNamedModel,
    requestedModelInput: model.requestedModelInput,
    envHasKeyFor: model.summaryEngine.envHasKeyFor,
    formatMissingModelError: model.summaryEngine.formatMissingModelError,
    cache: {
      store: cacheStore,
      ttlMs: cacheState.ttlMs,
      contentHash,
      promptHash,
      lengthKey,
      languageKey,
      autoSelectionModel: autoSelectionCacheModel,
    },
    verbose: (message) =>
      writeVerbose(io.stderr, flags.verbose, message, flags.verboseColor, io.envForRun),
    onModelChosen,
    onCacheResolved: (hit) => {
      ctx.hooks.onSummaryCached?.(hit);
      ctx.perfTrace?.mark(hit ? "summary:cache-hit" : "summary:cache-miss");
    },
    buildCachedResult: (attempt, summary) => ({
      summary,
      summaryAlreadyPrinted: false,
      modelMeta: buildModelMetaFromAttempt(attempt),
      maxOutputTokensForCall: null,
    }),
    runAttempt: (attempt) =>
      model.summaryEngine.runSummaryAttempt({
        attempt,
        prompt: promptPayload,
        allowStreaming: flags.streamingEnabled && !sanitizeKeyMoments,
        onModelChosen: onModelChosen ?? null,
        streamHandler: slidesOutput?.streamHandler ?? null,
      }),
    normalizeResult: (result) => {
      const normalizedSummaryBase =
        slides && slides.slides.length > 0
          ? normalizeSummarySlideHeadings(result.summary)
          : result.summary;
      const sanitizedSummary = sanitizeSummaryKeyMoments({
        markdown: normalizedSummaryBase,
        maxSeconds: timestampUpperBound,
      });
      return {
        ...result,
        summary: ensureSummaryKeyMoments({
          markdown: sanitizedSummary,
          extracted,
          maxSeconds: timestampUpperBound,
        }),
      };
    },
    onFixedModelError: (_attempt, error) => {
      throw error;
    },
    fetchImpl: io.fetch,
    timeoutMs: flags.timeoutMs,
    rememberCliProvider: (provider) =>
      writeLastSuccessfulCliProvider({ env: io.envForRun, provider }),
  });

  if (!execution.result || !execution.usedAttempt) {
    return {
      kind: "use-extracted",
      footerLabel: "no model",
      verboseMessage:
        execution.failure.lastError instanceof Error
          ? `auto failed all models: ${execution.failure.lastError.message}`
          : null,
    };
  }

  const {
    summary: normalizedSummary,
    summaryAlreadyPrinted,
    modelMeta,
    maxOutputTokensForCall,
  } = execution.result;
  const usedAttempt = execution.usedAttempt;
  const summaryFromCache = execution.summaryFromCache;

  return {
    kind: "summary",
    normalizedSummary,
    summaryAlreadyPrinted,
    summaryFromCache,
    usedAttempt,
    modelMeta,
    maxOutputTokensForCall,
  };
}
