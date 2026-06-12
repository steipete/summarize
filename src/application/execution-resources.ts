import type { CacheState } from "../cache.js";
import type { MediaCache } from "../content/index.js";
import type { SummaryStreamHandler } from "../engine/events.js";
import type { ModelExecutorDeps } from "../engine/model-executor.js";
import type { ExecFileFn } from "../markitdown.js";
import type {
  UrlFlowContext,
  UrlFlowEventHooks,
  UrlFlowFlags,
  UrlFlowRuntimeHooks,
} from "../run/flows/url/types.js";
import type { PerfTrace } from "../run/perf-trace.js";
import { scopeTranscriptCacheForDiarization } from "../shared/transcript-diarization-cache-scope.js";
import { createRunFlowContexts } from "./flow-contexts.js";
import {
  createExecutableRunModel,
  createRunModelRuntime,
  type ExecutableRunModel,
  type ModelExecutorRequestOptions,
  type RunModelRuntime,
} from "./model-runtime.js";
import type { ResolvedSummarizeRun, ResolvedSummarizeSpec } from "./run-spec.js";

export type SummarizeModelResources = {
  context: ResolvedSummarizeRun["bindings"]["context"];
  envForRun: Record<string, string | undefined>;
  runtime: RunModelRuntime;
  model: ExecutableRunModel;
};

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

export function createSummarizeModelResources(options: {
  resolvedRun: ResolvedSummarizeRun;
  env: Record<string, string | undefined>;
  metricsEnv?: Record<string, string | undefined>;
  fetchImpl: typeof fetch;
  execFileImpl: ExecFileFn;
  streamingEnabled: boolean;
  summaryStream: SummaryStreamHandler | null;
  requestOptions?: ModelExecutorRequestOptions;
  log?: ModelExecutorDeps["log"];
  trace?: ModelExecutorDeps["trace"];
}): SummarizeModelResources {
  const {
    resolvedRun,
    env,
    metricsEnv = env,
    fetchImpl,
    execFileImpl,
    streamingEnabled,
    summaryStream,
    requestOptions,
    log,
    trace,
  } = options;
  const { context, envForRun } = resolvedRun.bindings;
  const runtime = createRunModelRuntime({
    context,
    env,
    envForRun,
    metricsEnv,
    fetchImpl,
    execFileImpl,
    maxOutputTokensArg: resolvedRun.spec.maxOutputTokensArg,
    timeoutMs: resolvedRun.spec.timeoutMs,
    retries: resolvedRun.spec.retries,
    streamingEnabled,
    requestOptions,
    log,
    trace,
  });
  const model = createExecutableRunModel({
    spec: resolvedRun.bindings.model,
    runtime,
    context,
    allowAutoCliFallback: resolvedRun.spec.allowAutoCliFallback,
    summaryStream,
    requestOptions,
  });

  return { context, envForRun, runtime, model };
}

export function createSummarizeExecutionResources(options: {
  resolvedRun: ResolvedSummarizeRun;
  env: Record<string, string | undefined>;
  metricsEnv?: Record<string, string | undefined>;
  fetchImpl: typeof fetch;
  execFileImpl: ExecFileFn;
  cacheState: CacheState;
  mediaCache: MediaCache | null;
  stdout: NodeJS.WritableStream;
  stderr: NodeJS.WritableStream;
  urlFetch?: typeof fetch | null;
  summaryStream: SummaryStreamHandler | null;
  requestOptions?: ModelExecutorRequestOptions;
  log?: ModelExecutorDeps["log"];
  trace?: ModelExecutorDeps["trace"];
  flow: SummarizeFlowOptions;
  adapterHooks: SummarizeFlowAdapterHooks;
  eventHooks?: Partial<UrlFlowEventHooks>;
  assetSummaryOverrides?: Parameters<typeof createRunFlowContexts>[0]["assetSummaryOverrides"];
  perfTrace?: PerfTrace | null;
}): SummarizeExecutionResources {
  const { resolvedRun, flow } = options;
  const { spec } = resolvedRun;
  const modelResources = createSummarizeModelResources({
    resolvedRun,
    env: options.env,
    metricsEnv: options.metricsEnv,
    fetchImpl: options.fetchImpl,
    execFileImpl: options.execFileImpl,
    streamingEnabled: flow.streamingEnabled,
    summaryStream: options.summaryStream,
    requestOptions: options.requestOptions,
    log: options.log,
    trace: options.trace,
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
    assetSummaryOverrides: options.assetSummaryOverrides,
    perfTrace: options.perfTrace,
  });

  return { ...contexts, cacheState, modelResources };
}
