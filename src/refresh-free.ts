import { CliError, emitCliMessage, type CliProgressCallback } from "./locale.js";
import { createCliTranslator, resolveCliLocaleFromEnv } from "./locale.js";
import {
  benchmarkOpenRouterModels,
  refineBenchmarkCandidates,
  selectBenchmarkCandidates,
} from "./refresh-free/benchmark.js";
import {
  fetchOpenRouterCatalog,
  filterOpenRouterFreeModels,
  rankOpenRouterModelsForBenchmark,
} from "./refresh-free/catalog.js";
import { writeFreeModelConfig } from "./refresh-free/config.js";
import { RefreshFreeReporter } from "./refresh-free/presentation.js";

type GenerateFreeOptions = {
  runs: number;
  smart: number;
  maxCandidates: number;
  concurrency: number;
  timeoutMs: number;
  minParamB: number;
  maxAgeDays: number;
  setDefault: boolean;
};

export async function refreshFree({
  env,
  fetchImpl,
  stdout,
  stderr,
  verbose = false,
  options = {},
  onMessage,
}: {
  env: Record<string, string | undefined>;
  fetchImpl: typeof fetch;
  stdout: NodeJS.WritableStream;
  stderr: NodeJS.WritableStream;
  verbose?: boolean;
  options?: Partial<GenerateFreeOptions>;
  onMessage?: CliProgressCallback;
}): Promise<void> {
  const reporter = new RefreshFreeReporter({ stderr, env, verbose, onMessage });

  const openrouterKey =
    typeof env.OPENROUTER_API_KEY === "string" && env.OPENROUTER_API_KEY.trim().length > 0
      ? env.OPENROUTER_API_KEY.trim()
      : null;
  if (!openrouterKey) {
    throw new CliError("error.openrouterKey");
  }

  const resolved: GenerateFreeOptions = {
    runs: 2,
    smart: 3,
    maxCandidates: 10,
    concurrency: 4,
    timeoutMs: 10_000,
    minParamB: 27,
    maxAgeDays: 180,
    setDefault: false,
    ...options,
  };
  const EXTRA_RUNS = Math.max(0, Math.floor(resolved.runs));
  const TOTAL_RUNS = 1 + EXTRA_RUNS;
  const SMART = Math.max(0, Math.floor(resolved.smart));
  const MAX_CANDIDATES = Math.max(1, Math.floor(resolved.maxCandidates));
  const CONCURRENCY = Math.max(1, Math.floor(resolved.concurrency));
  const TIMEOUT_MS = Math.max(1, Math.floor(resolved.timeoutMs));
  const MIN_PARAM_B = Math.max(0, Math.floor(resolved.minParamB));
  const MAX_AGE_DAYS = Math.max(0, Math.floor(resolved.maxAgeDays));
  const applyMaxAgeFilter = MAX_AGE_DAYS > 0;

  reporter.fetchingCatalog();
  const catalogModels = await fetchOpenRouterCatalog(fetchImpl);
  const { freeModelsAll, freeModelsAgeFiltered, freeModels, ageFilteredIds, smallFilteredIds } =
    filterOpenRouterFreeModels(catalogModels, {
      maxAgeDays: MAX_AGE_DAYS,
      minParamB: MIN_PARAM_B,
    });
  if (freeModels.length === 0) {
    if (applyMaxAgeFilter) {
      throw new CliError("error.noRecentFreeModels", { MAX_AGE_DAYS });
    }
    throw new CliError("error.noFreeModels");
  }

  const ageFilteredCount = freeModelsAll.length - freeModelsAgeFiltered.length;
  reporter.filteredOldModels({
    count: ageFilteredCount,
    total: freeModelsAll.length,
    maxAgeDays: MAX_AGE_DAYS,
    ids: ageFilteredIds,
  });

  const filteredCount = freeModelsAgeFiltered.length - freeModels.length;
  reporter.filteredSmallModels({
    count: filteredCount,
    total: freeModelsAgeFiltered.length,
    minParamB: MIN_PARAM_B,
    ids: smallFilteredIds,
  });

  const smartSorted = rankOpenRouterModelsForBenchmark(freeModels);

  const freeIds = smartSorted.map((m) => m.id);

  reporter.benchmarkStarting({
    modelCount: freeIds.length,
    totalRuns: TOTAL_RUNS,
    concurrency: CONCURRENCY,
    timeoutMs: TIMEOUT_MS,
  });

  const benchmark = await benchmarkOpenRouterModels({
    models: smartSorted,
    openrouterKey,
    concurrency: CONCURRENCY,
    timeoutMs: TIMEOUT_MS,
    fetchImpl,
    onProgress: (state) => reporter.benchmarkProgress(state),
    onSuccess: (result) => reporter.benchmarkSuccess(result),
    onFailure: (result) => reporter.benchmarkFailure(result),
    onCooldown: (remainingMs) => reporter.cooldown(remainingMs),
  });

  reporter.benchmarkFinished();

  const ok = benchmark.working;
  if (ok.length === 0) {
    throw new CliError("error.noWorkingFreeModels", { testedCount: benchmark.testedCount });
  }

  reporter.benchmarkResults({
    workingCount: ok.length,
    testedCount: benchmark.testedCount,
    failureCounts: benchmark.failureCounts,
  });

  const selectionOptions = { smart: SMART, maxCandidates: MAX_CANDIDATES };
  const selectedIdsInitial = selectBenchmarkCandidates(ok, selectionOptions);

  if (EXTRA_RUNS > 0 && selectedIdsInitial.length > 0) {
    reporter.refining(selectedIdsInitial.length, EXTRA_RUNS);
  }

  const refined = await refineBenchmarkCandidates({
    working: ok,
    selectedIds: selectedIdsInitial,
    extraRuns: EXTRA_RUNS,
    openrouterKey,
    timeoutMs: TIMEOUT_MS,
    fetchImpl,
    onFailure: ({ modelId, error }) => reporter.refinementFailure(modelId, error),
  });
  const selectedIds = selectBenchmarkCandidates(refined, selectionOptions);

  const selected =
    selectedIds.length > 0
      ? selectedIds.map((id) => `openrouter/${id}`)
      : refined.slice(0, MAX_CANDIDATES).map((r) => `openrouter/${r.openrouterModelId}`);
  reporter.selected(selected.length);

  const configPath = await writeFreeModelConfig({
    env,
    candidates: selected,
    setDefault: resolved.setDefault,
  });
  stdout.write(
    `${createCliTranslator(resolveCliLocaleFromEnv(env))("refresh.wroteConfig", { path: configPath })}\n`,
  );

  emitCliMessage(onMessage, resolveCliLocaleFromEnv(env), "refresh.wroteConfig", {
    path: configPath,
  });
  reporter.selectedModels(selectedIds, refined);
}
