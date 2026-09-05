import type { CacheState } from "../cache.js";
import type { MediaCache } from "../content/index.js";
import { executeAssetSummary } from "../run/flows/asset/summary.js";
import type { AssetSummaryContext } from "../run/flows/asset/types.js";
import type {
  UrlFlowContext,
  UrlFlowEventHooks,
  UrlFlowFlags,
  UrlFlowRuntimeHooks,
} from "../run/flows/url/types.js";
import type { PerfTrace } from "../run/perf-trace.js";
import { scopeTranscriptCacheForDiarization } from "../shared/transcript-diarization-cache-scope.js";
import { createRunFlowContexts } from "./flow-contexts.js";
import { createSummarizeModelResources, type SummarizeModelResources } from "./model-runtime.js";
import type { ResolvedSummarizeSpec } from "./run-spec.js";
import type { SummarizeEventSink } from "./summarize-contracts.js";

type SummarizeFlowAdapterHooks = Pick<
  UrlFlowRuntimeHooks,
  | "writeViaFooter"
  | "clearProgressForStdout"
  | "restoreProgressAfterStdout"
  | "setClearProgressBeforeStdout"
  | "clearProgressIfCurrent"
>;

export type SummarizeFlowOptions = Pick<
  UrlFlowFlags,
  "runStartedAtMs" | "streamingEnabled" | "extractMode"
> &
  Partial<
    Pick<
      UrlFlowFlags,
      | "maxExtractCharacters"
      | "transcriptTimestamps"
      | "speakerIdentification"
      | "summaryCacheBypass"
      | "json"
      | "metricsEnabled"
      | "metricsDetailed"
      | "shouldComputeReport"
      | "verbose"
      | "verboseColor"
      | "progressEnabled"
      | "streamMode"
      | "plain"
      | "slides"
      | "slidesDebug"
      | "slidesOutput"
      | "throwOnAssetLikeHtmlError"
    >
  >;

export type SummarizeExecutionResources = ReturnType<typeof createRunFlowContexts> & {
  cacheState: CacheState;
  modelResources: SummarizeModelResources;
};

export type PreparedSummarizeExecution = {
  urlFlowContext: UrlFlowContext;
  assetSummaryContext?: AssetSummaryContext | null;
  isYoutubeUrl?: boolean;
};

function chainCallback<Args extends unknown[]>(
  first: ((...args: Args) => void) | null | undefined,
  second: (...args: Args) => void,
): (...args: Args) => void {
  return (...args) => {
    first?.(...args);
    second(...args);
  };
}

export function bindSummarizeExecutionEvents(
  prepared: PreparedSummarizeExecution,
  emit: SummarizeEventSink,
): PreparedSummarizeExecution {
  const baseHooks = prepared.urlFlowContext.hooks;
  const assetSummaryContext = prepared.assetSummaryContext
    ? {
        ...prepared.assetSummaryContext,
        onSummaryCached: chainCallback(prepared.assetSummaryContext.onSummaryCached, (cached) =>
          emit({ type: "summary-cache", cached }),
        ),
      }
    : null;
  const summarizeAsset = assetSummaryContext
    ? (args: Parameters<typeof executeAssetSummary>[1]) =>
        executeAssetSummary(assetSummaryContext, args)
    : baseHooks.summarizeAsset;

  return {
    assetSummaryContext,
    isYoutubeUrl: prepared.isYoutubeUrl,
    urlFlowContext: {
      ...prepared.urlFlowContext,
      hooks: {
        ...baseHooks,
        onModelChosen: chainCallback(baseHooks.onModelChosen, (modelId) =>
          emit({ type: "model-selected", modelId }),
        ),
        onExtracted: chainCallback(baseHooks.onExtracted, (content) =>
          emit({ type: "content-extracted", content }),
        ),
        onSlidesExtracted: chainCallback(baseHooks.onSlidesExtracted, (slides) =>
          emit({ type: "slides-extracted", slides }),
        ),
        onSlidesProgress: chainCallback(baseHooks.onSlidesProgress, (text) =>
          emit({ type: "slides-progress", text }),
        ),
        onSlidesDone: chainCallback(baseHooks.onSlidesDone, (result) =>
          emit({ type: "slides-completed", ...result }),
        ),
        onSlideChunk: chainCallback(baseHooks.onSlideChunk, ({ slide, meta }) =>
          emit({ type: "slide", slide, meta }),
        ),
        onLinkPreviewProgress: chainCallback(baseHooks.onLinkPreviewProgress, (event) =>
          emit({ type: "extraction-progress", event }),
        ),
        onSummaryCached: chainCallback(baseHooks.onSummaryCached, (cached) =>
          emit({ type: "summary-cache", cached }),
        ),
        summarizeAsset,
      },
    },
  };
}

export function createSummarizeFlowFlags(
  spec: ResolvedSummarizeSpec,
  flow: SummarizeFlowOptions,
): UrlFlowFlags {
  return {
    timeoutMs: spec.timeoutMs,
    maxExtractCharacters:
      flow.maxExtractCharacters === undefined
        ? spec.maxExtractCharacters
        : flow.maxExtractCharacters,
    retries: spec.retries,
    format: spec.format,
    markdownMode: spec.markdownMode,
    preprocessMode: spec.preprocessMode,
    youtubeMode: spec.youtubeMode,
    firecrawlMode: spec.firecrawlMode,
    videoMode: spec.videoMode,
    embeddedVideoMode: spec.embeddedVideoMode,
    transcriptTimestamps: flow.transcriptTimestamps ?? spec.transcriptTimestamps,
    transcriptDiarization: spec.transcriptDiarization,
    speakerIdentification: flow.speakerIdentification ?? null,
    outputLanguage: spec.outputLanguage,
    lengthArg: spec.lengthArg,
    forceSummary: spec.forceSummary,
    promptOverride: spec.promptOverride,
    lengthInstruction: spec.lengthInstruction,
    languageInstruction: spec.languageInstruction,
    summaryCacheBypass: flow.summaryCacheBypass ?? false,
    maxOutputTokensArg: spec.maxOutputTokensArg,
    json: flow.json ?? false,
    extractMode: flow.extractMode,
    metricsEnabled: flow.metricsEnabled ?? false,
    metricsDetailed: flow.metricsDetailed ?? false,
    shouldComputeReport: flow.shouldComputeReport ?? false,
    runStartedAtMs: flow.runStartedAtMs,
    verbose: flow.verbose ?? false,
    verboseColor: flow.verboseColor ?? false,
    progressEnabled: flow.progressEnabled ?? false,
    streamMode: flow.streamMode ?? (flow.streamingEnabled ? "on" : "off"),
    streamingEnabled: flow.streamingEnabled,
    plain: flow.plain ?? true,
    configPath: spec.configPath,
    configModelLabel: spec.configModelLabel,
    slides: flow.slides ?? null,
    slidesDebug: flow.slidesDebug ?? false,
    slidesOutput: flow.slidesOutput ?? false,
    throwOnAssetLikeHtmlError: flow.throwOnAssetLikeHtmlError,
  };
}

export function createSummarizeExecutionResources(
  options: Omit<Parameters<typeof createSummarizeModelResources>[0], "streamingEnabled"> & {
    cacheState: CacheState;
    mediaCache: MediaCache | null;
    stdout: NodeJS.WritableStream;
    stderr: NodeJS.WritableStream;
    urlFetch?: typeof fetch | null;
    flow: SummarizeFlowOptions;
    adapterHooks: SummarizeFlowAdapterHooks;
    eventHooks?: Partial<UrlFlowEventHooks>;
    assetFormat?: Parameters<typeof createRunFlowContexts>[0]["assetFormat"];
    perfTrace?: PerfTrace | null;
  },
): SummarizeExecutionResources {
  const { resolvedRun, flow } = options;
  const { spec } = resolvedRun;
  const modelResources = createSummarizeModelResources({
    ...options,
    streamingEnabled: flow.streamingEnabled,
  });
  const { metrics } = modelResources.runtime;
  const cacheState = scopeTranscriptCacheForDiarization(
    options.cacheState,
    spec.transcriptDiarization,
  );
  const flags = createSummarizeFlowFlags(spec, flow);
  const contexts = createRunFlowContexts({
    cacheState,
    mediaCache: options.mediaCache,
    io: {
      env: options.env,
      envForRun: modelResources.envForRun,
      stdout: options.stdout,
      stderr: options.stderr,
      execFileImpl: options.execFileImpl,
      fetch: metrics.trackedFetch,
      ...(options.urlFetch ? { urlFetch: options.urlFetch } : {}),
    },
    flags,
    model: modelResources.model,
    runtimeHooks: {
      setTranscriptionCost: metrics.setTranscriptionCost,
      ...options.adapterHooks,
      buildReport: metrics.buildReport,
      estimateCostUsd: metrics.estimateCostUsd,
    },
    eventHooks: options.eventHooks,
    assetFormat: options.assetFormat,
    perfTrace: options.perfTrace,
  });

  return { ...contexts, cacheState, modelResources };
}
