import { isTwitterStatusUrl, isYouTubeUrl } from "@steipete/summarize-core/content/url";
import { normalizeSummarySlideHeadings } from "@steipete/summarize-core/slides";
import { resolveModelAttempts } from "../application/model-attempts.js";
import {
  buildLanguageKey,
  buildLengthKey,
  buildPromptContentHash,
  buildPromptHash,
  type CacheState,
} from "../cache.js";
import type { CliProvider, SummarizeConfig } from "../config.js";
import type { ExtractedLinkContent } from "../content/index.js";
import type { StreamMode } from "../flags.js";
import type { OutputLanguage } from "../language.js";
import type { Prompt } from "../llm/prompt.js";
import type { FixedModelSpec } from "../model-spec.js";
import { SUMMARY_SYSTEM_PROMPT } from "../prompts/index.js";
import type { RunApiStatus } from "../shared/run-api-status.js";
import type { SummaryLengthArg } from "../shared/summary-length.js";
import { countTokens } from "../tokenizer.js";
import type { SummaryStreamHandler } from "./events.js";
import type { createModelExecutor } from "./model-executor.js";
import { buildModelMetaFromAttempt } from "./model-meta.js";
import { executeSummaryAttempts } from "./summary-execution.js";
import {
  ensureSummaryKeyMoments,
  resolveSummaryTimestampUpperBound,
  sanitizeSummaryKeyMoments,
  shouldSanitizeSummaryKeyMoments,
} from "./summary-timestamps.js";
import type { ModelAttempt } from "./types.js";
import { shouldBypassShortContentSummary } from "./web-prompt.js";

type SlidesResult = Awaited<ReturnType<typeof import("../slides/index.js").extractSlidesForSource>>;

export type WebSummaryContext = {
  io: {
    envForRun: Record<string, string | undefined>;
    fetch: typeof fetch;
  };
  flags: {
    timeoutMs: number;
    lengthArg: SummaryLengthArg;
    outputLanguage: OutputLanguage;
    summaryCacheBypass: boolean;
    forceSummary: boolean;
    maxOutputTokensArg: number | null;
    json: boolean;
    slides: unknown;
    streamMode: StreamMode;
    streamingEnabled: boolean;
  };
  model: {
    requestedModelInput: string;
    fixedModelSpec: FixedModelSpec | null;
    isFallbackModel: boolean;
    isImplicitAutoSelection: boolean;
    allowAutoCliFallback: boolean;
    isNamedModelSelection: boolean;
    wantsFreeNamedModel: boolean;
    desiredOutputTokens: number | null;
    configForModelSelection: SummarizeConfig | null;
    envForAuto: Record<string, string | undefined>;
    cliAvailability: Partial<Record<CliProvider, boolean>>;
    apiStatus: Pick<
      RunApiStatus,
      | "zaiApiKey"
      | "zaiBaseUrl"
      | "nvidiaApiKey"
      | "nvidiaBaseUrl"
      | "minimaxApiKey"
      | "minimaxBaseUrl"
      | "orcarouterApiKey"
      | "orcarouterBaseUrl"
      | "ollamaBaseUrl"
    >;
    summaryEngine: ReturnType<typeof createModelExecutor>;
    summaryStream: SummaryStreamHandler | null;
    getLiteLlmCatalog: () => Promise<
      Awaited<ReturnType<typeof import("../pricing/litellm.js").loadLiteLlmCatalog>>["catalog"]
    >;
  };
  cache: CacheState;
};

export type WebSummaryRuntime = {
  log?: ((message: string) => void) | null;
  trace?: ((name: string, detail?: string | null) => void) | null;
  onSummaryCached?: ((cached: boolean) => void) | null;
  readLastSuccessfulCliProvider?: (() => Promise<CliProvider | null>) | null;
  rememberCliProvider?: ((provider: CliProvider) => Promise<void>) | null;
};

type SummaryResolutionUseExtracted = {
  kind: "use-extracted";
  footerLabel: string;
  verboseMessage: string | null;
};

type SummaryResolutionSummary = {
  kind: "summary";
  normalizedSummary: string;
  summaryEmitted: boolean;
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
  streamHandler,
  runtime = {},
}: {
  ctx: WebSummaryContext;
  url: string;
  extracted: ExtractedLinkContent;
  prompt: string;
  onModelChosen?: ((modelId: string) => void) | null;
  slides?: SlidesResult | null;
  streamHandler?: SummaryStreamHandler | null;
  runtime?: WebSummaryRuntime;
}): Promise<UrlSummaryResolution> {
  const { io, flags, model, cache: cacheState } = ctx;
  runtime.trace?.("summary:resolve-start");
  const lastSuccessfulCliProvider =
    model.isFallbackModel && runtime.readLastSuccessfulCliProvider
      ? await runtime.readLastSuccessfulCliProvider()
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
    /* v8 ignore next */
    if (!model.isFallbackModel && !model.fixedModelSpec) {
      throw new Error("Internal error: missing fixed model spec");
    }
    const list = resolveModelAttempts({
      requestedModel: model.fixedModelSpec
        ? { kind: "fixed", ...model.fixedModelSpec }
        : { kind: "auto" },
      kind: kindForAuto,
      promptTokens,
      desiredOutputTokens: model.desiredOutputTokens,
      requiresVideoUnderstanding: false,
      envForAuto: model.envForAuto,
      configForModelSelection: model.configForModelSelection,
      catalog: model.isFallbackModel ? await model.getLiteLlmCatalog() : null,
      openrouterProvidersFromEnv: null,
      cliAvailability: model.cliAvailability,
      isImplicitAutoSelection: model.isImplicitAutoSelection,
      allowAutoCliFallback: model.allowAutoCliFallback,
      lastSuccessfulCliProvider,
      providerRuntime: model.summaryEngine.providerRuntime,
    });
    if (model.isFallbackModel) {
      for (const attempt of list.slice(0, 8)) {
        runtime.log?.(`auto candidate ${attempt.debug ?? attempt.userModelId}`);
      }
    }
    return list;
  })();
  runtime.trace?.("summary:attempts", attempts[0]?.userModelId ?? null);

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
  const autoBypass = model.isFallbackModel && !model.isNamedModelSelection;
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
    verbose: (message) => runtime.log?.(message),
    onModelChosen,
    onCacheResolved: (hit) => {
      runtime.onSummaryCached?.(hit);
      runtime.trace?.(hit ? "summary:cache-hit" : "summary:cache-miss");
    },
    buildCachedResult: (attempt, summary) => ({
      summary,
      summaryEmitted: false,
      modelMeta: buildModelMetaFromAttempt(attempt),
      maxOutputTokensForCall: null,
    }),
    runAttempt: (attempt) =>
      model.summaryEngine.runSummaryAttempt({
        attempt,
        prompt: promptPayload,
        allowStreaming: flags.streamingEnabled && !sanitizeKeyMoments,
        onModelChosen: onModelChosen ?? null,
        streamHandler: streamHandler ?? model.summaryStream,
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
    rememberCliProvider: runtime.rememberCliProvider ?? null,
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
    summaryEmitted,
    modelMeta,
    maxOutputTokensForCall,
  } = execution.result;
  const usedAttempt = execution.usedAttempt;
  const summaryFromCache = execution.summaryFromCache;

  return {
    kind: "summary",
    normalizedSummary,
    summaryEmitted,
    summaryFromCache,
    usedAttempt,
    modelMeta,
    maxOutputTokensForCall,
  };
}
