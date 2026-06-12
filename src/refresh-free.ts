import {
  benchmarkOpenRouterModels,
  refineBenchmarkCandidates,
  selectBenchmarkCandidates,
} from "./refresh-free/benchmark.js";
import {
  filterOpenRouterFreeModels,
  parseOpenRouterCatalog,
  rankOpenRouterModelsForBenchmark,
} from "./refresh-free/catalog.js";
import { writeFreeModelConfig } from "./refresh-free/config.js";

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

function supportsColor(
  stream: NodeJS.WritableStream,
  env: Record<string, string | undefined>,
): boolean {
  if (env.NO_COLOR) return false;
  if (env.FORCE_COLOR && env.FORCE_COLOR !== "0") return true;
  if (!(stream as unknown as { isTTY?: boolean }).isTTY) return false;
  const term = env.TERM?.toLowerCase();
  if (!term || term === "dumb") return false;
  return true;
}

function ansi(code: string, input: string, enabled: boolean): string {
  if (!enabled) return input;
  return `\u001b[${code}m${input}\u001b[0m`;
}

function formatMs(ms: number): string {
  if (!Number.isFinite(ms)) return `${ms}`;
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${Math.round(ms / 100) / 10}s`;
}

function formatTokenK(value: number): string {
  if (!Number.isFinite(value)) return `${value}`;
  if (value < 1024) return `${Math.round(value)}`;
  const k = Math.round(value / 1024);
  return `${k}k`;
}

export async function refreshFree({
  env,
  fetchImpl,
  stdout,
  stderr,
  verbose = false,
  options = {},
}: {
  env: Record<string, string | undefined>;
  fetchImpl: typeof fetch;
  stdout: NodeJS.WritableStream;
  stderr: NodeJS.WritableStream;
  verbose?: boolean;
  options?: Partial<GenerateFreeOptions>;
}): Promise<void> {
  const color = supportsColor(stderr, env);
  const okLabel = (text: string) => ansi("1;32", text, color);
  const failLabel = (text: string) => ansi("1;31", text, color);
  const dim = (text: string) => ansi("2", text, color);
  const heading = (text: string) => ansi("1;36", text, color);
  const cmdName = heading("Refresh Free");

  const openrouterKey =
    typeof env.OPENROUTER_API_KEY === "string" && env.OPENROUTER_API_KEY.trim().length > 0
      ? env.OPENROUTER_API_KEY.trim()
      : null;
  if (!openrouterKey) {
    throw new Error("Missing OPENROUTER_API_KEY (required for refresh-free)");
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

  stderr.write(`${cmdName}: fetching OpenRouter models…\n`);
  const response = await fetchImpl("https://openrouter.ai/api/v1/models", {
    headers: { Accept: "application/json" },
  });
  if (!response.ok) {
    throw new Error(`OpenRouter /models failed: HTTP ${response.status}`);
  }
  const catalogModels = parseOpenRouterCatalog(await response.json());
  const { freeModelsAll, freeModelsAgeFiltered, freeModels, ageFilteredIds, smallFilteredIds } =
    filterOpenRouterFreeModels(catalogModels, {
      maxAgeDays: MAX_AGE_DAYS,
      minParamB: MIN_PARAM_B,
    });
  if (freeModels.length === 0) {
    if (applyMaxAgeFilter) {
      throw new Error(
        `OpenRouter /models returned no :free models from the last ${MAX_AGE_DAYS} days`,
      );
    }
    throw new Error("OpenRouter /models returned no :free models");
  }

  const ageFilteredCount = freeModelsAll.length - freeModelsAgeFiltered.length;
  if (ageFilteredCount > 0) {
    stderr.write(
      `${cmdName}: filtered ${ageFilteredCount}/${freeModelsAll.length} old models (>${MAX_AGE_DAYS}d)\n`,
    );
    if (verbose) {
      for (const id of ageFilteredIds) stderr.write(`${dim(`skip ${id}`)}\n`);
    }
  }

  const filteredCount = freeModelsAgeFiltered.length - freeModels.length;
  if (filteredCount > 0) {
    stderr.write(
      `${cmdName}: filtered ${filteredCount}/${freeModelsAgeFiltered.length} small models (<${MIN_PARAM_B}B)\n`,
    );
    if (verbose) {
      for (const id of smallFilteredIds) stderr.write(`${dim(`skip ${id}`)}\n`);
    }
  }

  const smartSorted = rankOpenRouterModelsForBenchmark(freeModels);

  const freeIds = smartSorted.map((m) => m.id);

  stderr.write(
    `${cmdName}: found ${freeIds.length} :free models; testing (runs=${TOTAL_RUNS}, concurrency=${CONCURRENCY}, timeout=${formatMs(TIMEOUT_MS)})…\n`,
  );

  const isTty = Boolean((stderr as unknown as { isTTY?: boolean }).isTTY);
  let lastProgressPrint = 0;

  const progress = ({
    done,
    total,
    okCount,
    elapsedMs,
  }: {
    done: number;
    total: number;
    okCount: number;
    elapsedMs: number;
  }) => {
    const now = Date.now();
    const everyMs = isTty ? 150 : 1500;
    if (now - lastProgressPrint < everyMs) return;
    lastProgressPrint = now;
    const elapsedSec = Math.round(elapsedMs / 100) / 10;
    const line = `Refresh Free: tested ${done}/${total}, ok=${okCount} (elapsed ${elapsedSec}s)…`;
    if (isTty) {
      stderr.write(`\x1b[2K\r${line}`);
    } else {
      stderr.write(`${line}\n`);
    }
  };

  const note = (line: string) => {
    if (isTty) {
      // Clear current progress line, print note, then progress will redraw on next tick.
      stderr.write(`\x1b[2K\r${line}\n`);
      lastProgressPrint = 0;
      return;
    }
    stderr.write(`${line}\n`);
  };

  const benchmark = await benchmarkOpenRouterModels({
    models: smartSorted,
    openrouterKey,
    concurrency: CONCURRENCY,
    timeoutMs: TIMEOUT_MS,
    fetchImpl,
    onProgress: progress,
    onSuccess: ({ modelId, latencyMs }) =>
      note(`${okLabel("ok")} ${modelId} ${dim(`(${formatMs(latencyMs)})`)}`),
    onFailure: ({ modelId, kind, message }) => {
      if (verbose) note(`${failLabel("fail")} ${modelId} ${dim(`(${kind})`)}: ${message}`);
    },
    onCooldown: (remainingMs) =>
      note(`${dim(`rate limit hit; sleeping ${formatMs(remainingMs)}…`)}`),
  });

  if (isTty) stderr.write("\n");

  const ok = benchmark.working;
  if (ok.length === 0) {
    throw new Error(`No working :free models found (tested ${benchmark.testedCount})`);
  }

  {
    const failed = benchmark.testedCount - ok.length;
    const parts = [
      `ok=${ok.length}`,
      `failed=${failed}`,
      ...Object.entries(benchmark.failureCounts)
        .filter(([, v]) => v > 0)
        .map(([k, v]) => `${k}=${v}`),
    ];
    stderr.write(`${cmdName}: results ${parts.join(" ")}\n`);
    if (benchmark.failureCounts.rateLimitMin > 0) {
      stderr.write(
        `${dim("Note: OpenRouter free-model rate limits were hit; retrying later may find more working models.")}\n`,
      );
    }
    if (benchmark.failureCounts.rateLimitDay > 0) {
      stderr.write(`${dim("Note: OpenRouter per-day free-model quota was hit.")}\n`);
    }
  }

  const selectionOptions = { smart: SMART, maxCandidates: MAX_CANDIDATES };
  const selectedIdsInitial = selectBenchmarkCandidates(ok, selectionOptions);

  if (EXTRA_RUNS > 0 && selectedIdsInitial.length > 0) {
    stderr.write(
      `${cmdName}: refining ${selectedIdsInitial.length} candidates (extra runs=${EXTRA_RUNS})…\n`,
    );
  }

  const refined = await refineBenchmarkCandidates({
    working: ok,
    selectedIds: selectedIdsInitial,
    extraRuns: EXTRA_RUNS,
    openrouterKey,
    timeoutMs: TIMEOUT_MS,
    fetchImpl,
    onFailure: ({ modelId, error }) => {
      if (verbose) stderr.write(`fail refine ${modelId}: ${String(error)}\n`);
    },
  });
  const selectedIds = selectBenchmarkCandidates(refined, selectionOptions);

  const selected =
    selectedIds.length > 0
      ? selectedIds.map((id) => `openrouter/${id}`)
      : refined.slice(0, MAX_CANDIDATES).map((r) => `openrouter/${r.openrouterModelId}`);
  stderr.write(`${cmdName}: selected ${selected.length} candidates.\n`);

  const configPath = await writeFreeModelConfig({
    env,
    candidates: selected,
    setDefault: resolved.setDefault,
  });
  stdout.write(`Wrote ${configPath} (models.free)\n`);

  const refinedById = new Map(refined.map((m) => [m.openrouterModelId, m] as const));
  stderr.write(`\n${heading("Selected")} (sorted, Δ latency)\n`);
  for (const modelId of selectedIds) {
    const r = refinedById.get(modelId);
    if (!r) continue;
    const avg = r.successCount > 0 ? r.totalLatencyMs / r.successCount : r.medianLatencyMs;
    const ctx = typeof r.contextLength === "number" ? `ctx=${formatTokenK(r.contextLength)}` : null;
    const out =
      typeof r.maxCompletionTokens === "number"
        ? `out=${formatTokenK(r.maxCompletionTokens)}`
        : null;
    const modality = r.modality ? r.modality : null;
    const params = typeof r.inferredParamB === "number" ? `~${r.inferredParamB}B` : null;
    const meta = [params, ctx, out, modality].filter(Boolean).join(" ");
    stderr.write(`- ${modelId} ${dim(`Δ ${formatMs(avg)} (n=${r.successCount})`)} ${dim(meta)}\n`);
  }
}
