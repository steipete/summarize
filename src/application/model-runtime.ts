import type { SummaryStreamHandler } from "../engine/events.js";
import { createModelExecutor, type ModelExecutorDeps } from "../engine/model-executor.js";
import type { ExecFileFn } from "../markitdown.js";
import { resolveRunApiStatus } from "./api-status.js";
import type { RunContextState } from "./context.js";
import { createRunMetrics } from "./metrics.js";
import type { RunModelSpec } from "./model-selection.js";
import { resolveProviderRuntimeBindings } from "./provider-runtime.js";
import type { ResolvedSummarizeRun } from "./run-spec.js";

export type ModelExecutorRequestOptions = Pick<
  ModelExecutorDeps,
  "openaiRequestOptions" | "openaiRequestOptionsOverride" | "cliReasoningEffortOverride"
>;

type RunModelRuntime = {
  metrics: ReturnType<typeof createRunMetrics>;
  apiStatus: ReturnType<typeof resolveRunApiStatus>;
  summaryEngine: ReturnType<typeof createModelExecutor>;
};

export type SummarizeModelResources = {
  context: RunContextState;
  envForRun: Record<string, string | undefined>;
  runtime: RunModelRuntime;
  model: ExecutableRunModel;
};

export type ExecutableRunModel = RunModelSpec &
  ModelExecutorRequestOptions & {
    allowAutoCliFallback: boolean;
    envForAuto: RunContextState["envForAuto"];
    cliAvailability: RunContextState["cliAvailability"];
    openaiUseChatCompletions: RunContextState["openaiUseChatCompletions"];
    openaiWhisperUsdPerMinute: RunContextState["openaiWhisperUsdPerMinute"];
    apiStatus: RunModelRuntime["apiStatus"];
    summaryEngine: RunModelRuntime["summaryEngine"];
    summaryStream: SummaryStreamHandler | null;
    getLiteLlmCatalog: RunModelRuntime["metrics"]["getLiteLlmCatalog"];
    llmCalls: RunModelRuntime["metrics"]["llmCalls"];
  };

export function createSummarizeModelResources({
  resolvedRun,
  env,
  metricsEnv = env,
  fetchImpl,
  execFileImpl,
  streamingEnabled,
  summaryStream,
  requestOptions = {},
  log,
  trace,
}: {
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
  const { context, envForRun } = resolvedRun.bindings;
  const { maxOutputTokensArg, timeoutMs, retries, allowAutoCliFallback } = resolvedRun.spec;
  const metrics = createRunMetrics({
    env: metricsEnv,
    fetchImpl,
    maxOutputTokensArg,
  });
  const apiStatus = resolveRunApiStatus(context);
  const providerRuntime = resolveProviderRuntimeBindings({
    env: envForRun,
    envState: context,
    configForCli: context.configForCli,
  });
  const summaryEngine = createModelExecutor({
    env,
    envForRun,
    execFileImpl,
    timeoutMs,
    retries,
    streamingEnabled,
    ...requestOptions,
    cliConfigForRun: context.cliConfigForRun ?? null,
    cliAvailability: context.cliAvailability,
    trackedFetch: metrics.trackedFetch,
    resolveMaxOutputTokensForCall: metrics.resolveMaxOutputTokensForCall,
    resolveMaxInputTokensForCall: metrics.resolveMaxInputTokensForCall,
    llmCalls: metrics.llmCalls,
    log,
    trace,
    providerRuntime,
    openrouterApiKey: apiStatus.openrouterApiKey,
  });

  const model: ExecutableRunModel = {
    ...resolvedRun.bindings.model,
    allowAutoCliFallback,
    envForAuto: context.envForAuto,
    cliAvailability: context.cliAvailability,
    openaiUseChatCompletions: context.openaiUseChatCompletions,
    openaiWhisperUsdPerMinute: context.openaiWhisperUsdPerMinute,
    ...requestOptions,
    apiStatus,
    summaryEngine,
    summaryStream,
    getLiteLlmCatalog: metrics.getLiteLlmCatalog,
    llmCalls: metrics.llmCalls,
  };

  return { context, envForRun, runtime: { metrics, apiStatus, summaryEngine }, model };
}
