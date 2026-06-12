import type { LlmApiKeys } from "../llm/generate-text.js";
import { generateTextWithModelId } from "../llm/generate-text.js";
import type { OpenRouterModelEntry } from "./catalog.js";

export type BenchmarkFailureKind =
  | "empty"
  | "rateLimitMin"
  | "rateLimitDay"
  | "noProviders"
  | "timeout"
  | "providerError"
  | "other";

export type BenchmarkFailureCounts = Record<BenchmarkFailureKind, number>;

export type BenchmarkedOpenRouterModel = {
  openrouterModelId: string;
  initialLatencyMs: number;
  medianLatencyMs: number;
  totalLatencyMs: number;
  successCount: number;
  contextLength: number | null;
  maxCompletionTokens: number | null;
  supportedParametersCount: number;
  modality: string | null;
  inferredParamB: number | null;
};

type GenerateModel = typeof generateTextWithModelId;

function classifyOpenRouterRateLimit(message: string): "perMin" | "perDay" | null {
  const normalized = message.toLowerCase();
  if (!normalized.includes("rate limit exceeded")) return null;
  if (
    normalized.includes("per-day") ||
    normalized.includes("per day") ||
    normalized.includes("free-models-per-day")
  ) {
    return "perDay";
  }
  if (
    normalized.includes("per-min") ||
    normalized.includes("per min") ||
    normalized.includes("free-models-per-min")
  ) {
    return "perMin";
  }
  return "perMin";
}

export function classifyBenchmarkFailure(message: string): BenchmarkFailureKind {
  const normalized = message.toLowerCase();
  if (normalized.includes("empty summary")) return "empty";
  const rateLimit = classifyOpenRouterRateLimit(message);
  if (rateLimit === "perMin") return "rateLimitMin";
  if (rateLimit === "perDay") return "rateLimitDay";
  if (normalized.includes("no allowed providers are available")) return "noProviders";
  if (
    normalized.includes("timed out") ||
    normalized.includes("timeout") ||
    normalized.includes("aborted")
  ) {
    return "timeout";
  }
  if (normalized.includes("provider returned error") || normalized.includes("provider error")) {
    return "providerError";
  }
  return "other";
}

async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const limit = Math.max(1, Math.floor(concurrency));
  const results: R[] = new Array(items.length);
  let nextIndex = 0;

  const worker = async () => {
    while (true) {
      const current = nextIndex;
      nextIndex += 1;
      if (current >= items.length) return;
      results[current] = await fn(items[current] as T, current);
    }
  };

  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()));
  return results;
}

function createApiKeys(openrouterKey: string): LlmApiKeys {
  return {
    xaiApiKey: null,
    openaiApiKey: null,
    googleApiKey: null,
    anthropicApiKey: null,
    openrouterApiKey: openrouterKey,
  };
}

function buildModelResult(
  model: OpenRouterModelEntry,
  latencyMs: number,
): BenchmarkedOpenRouterModel {
  return {
    openrouterModelId: model.id,
    initialLatencyMs: latencyMs,
    medianLatencyMs: latencyMs,
    totalLatencyMs: latencyMs,
    successCount: 1,
    contextLength: model.contextLength,
    maxCompletionTokens: model.maxCompletionTokens,
    supportedParametersCount: model.supportedParametersCount,
    modality: model.modality,
    inferredParamB: model.inferredParamB,
  };
}

async function runProbe({
  modelId,
  apiKeys,
  timeoutMs,
  fetchImpl,
  generate,
}: {
  modelId: string;
  apiKeys: LlmApiKeys;
  timeoutMs: number;
  fetchImpl: typeof fetch;
  generate: GenerateModel;
}) {
  await generate({
    modelId: `openai/${modelId}`,
    apiKeys,
    prompt: { userText: "Reply with a single word: OK" },
    temperature: 0,
    maxOutputTokens: 16,
    timeoutMs,
    fetchImpl,
    forceOpenRouter: true,
    retries: 0,
  });
}

export async function benchmarkOpenRouterModels({
  models,
  openrouterKey,
  concurrency,
  timeoutMs,
  fetchImpl,
  cooldownMs = 65_000,
  generate = generateTextWithModelId,
  now = Date.now,
  sleep = (ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
  onProgress,
  onSuccess,
  onFailure,
  onCooldown,
}: {
  models: OpenRouterModelEntry[];
  openrouterKey: string;
  concurrency: number;
  timeoutMs: number;
  fetchImpl: typeof fetch;
  cooldownMs?: number;
  generate?: GenerateModel;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  onProgress?:
    | ((state: { done: number; total: number; okCount: number; elapsedMs: number }) => void)
    | null;
  onSuccess?: ((result: { modelId: string; latencyMs: number }) => void) | null;
  onFailure?:
    | ((result: { modelId: string; kind: BenchmarkFailureKind; message: string }) => void)
    | null;
  onCooldown?: ((remainingMs: number) => void) | null;
}): Promise<{
  working: BenchmarkedOpenRouterModel[];
  testedCount: number;
  failureCounts: BenchmarkFailureCounts;
}> {
  const failureCounts: BenchmarkFailureCounts = {
    empty: 0,
    rateLimitMin: 0,
    rateLimitDay: 0,
    noProviders: 0,
    timeout: 0,
    providerError: 0,
    other: 0,
  };
  const apiKeys = createApiKeys(openrouterKey);
  const startedAt = now();
  let done = 0;
  let okCount = 0;
  let cooldownUntilMs = 0;
  let cooldownNotifiedAtMs = 0;

  const reportProgress = () =>
    onProgress?.({
      done,
      total: models.length,
      okCount,
      elapsedMs: now() - startedAt,
    });

  const waitForCooldown = async () => {
    const current = now();
    if (cooldownUntilMs <= current) return;
    const remaining = cooldownUntilMs - current;
    if (current - cooldownNotifiedAtMs > 5_000) {
      cooldownNotifiedAtMs = current;
      onCooldown?.(remaining);
    }
    await sleep(remaining);
  };

  const results = await mapWithConcurrency(models, concurrency, async (model) => {
    const runStartedAt = now();
    try {
      await waitForCooldown();
      await runProbe({
        modelId: model.id,
        apiKeys,
        timeoutMs,
        fetchImpl,
        generate,
      });
      const latencyMs = now() - runStartedAt;
      done += 1;
      okCount += 1;
      reportProgress();
      onSuccess?.({ modelId: model.id, latencyMs });
      return buildModelResult(model, latencyMs);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const kind = classifyBenchmarkFailure(message);
      failureCounts[kind] += 1;

      if (kind === "rateLimitMin") {
        cooldownUntilMs = Math.max(cooldownUntilMs, now() + cooldownMs);
        await waitForCooldown();
        try {
          const retryStartedAt = now();
          await runProbe({
            modelId: model.id,
            apiKeys,
            timeoutMs,
            fetchImpl,
            generate,
          });
          const latencyMs = now() - retryStartedAt;
          done += 1;
          okCount += 1;
          reportProgress();
          onSuccess?.({ modelId: model.id, latencyMs });
          return buildModelResult(model, latencyMs);
        } catch {
          // Keep the original rate-limit failure for reporting.
        }
      }

      done += 1;
      reportProgress();
      onFailure?.({ modelId: model.id, kind, message });
      return null;
    }
  });

  return {
    working: results
      .filter((result): result is BenchmarkedOpenRouterModel => Boolean(result))
      .sort((a, b) => a.medianLatencyMs - b.medianLatencyMs),
    testedCount: results.length,
    failureCounts,
  };
}

export function selectBenchmarkCandidates(
  working: BenchmarkedOpenRouterModel[],
  {
    smart,
    maxCandidates,
  }: {
    smart: number;
    maxCandidates: number;
  },
): string[] {
  const smartFirst = working.slice().sort((a, b) => {
    const aContext = a.contextLength ?? -1;
    const bContext = b.contextLength ?? -1;
    if (aContext !== bContext) return bContext - aContext;
    const aOut = a.maxCompletionTokens ?? -1;
    const bOut = b.maxCompletionTokens ?? -1;
    if (aOut !== bOut) return bOut - aOut;
    if (a.supportedParametersCount !== b.supportedParametersCount) {
      return b.supportedParametersCount - a.supportedParametersCount;
    }
    if (a.successCount !== b.successCount) return b.successCount - a.successCount;
    if (a.medianLatencyMs !== b.medianLatencyMs) {
      return a.medianLatencyMs - b.medianLatencyMs;
    }
    return a.openrouterModelId.localeCompare(b.openrouterModelId);
  });
  const fastFirst = working.slice().sort((a, b) => {
    if (a.successCount !== b.successCount) return b.successCount - a.successCount;
    if (a.medianLatencyMs !== b.medianLatencyMs) {
      return a.medianLatencyMs - b.medianLatencyMs;
    }
    return a.openrouterModelId.localeCompare(b.openrouterModelId);
  });
  const picked = new Set<string>();
  const ordered: string[] = [];

  for (const model of smartFirst) {
    if (ordered.length >= Math.min(smart, maxCandidates)) break;
    if (picked.has(model.openrouterModelId)) continue;
    picked.add(model.openrouterModelId);
    ordered.push(model.openrouterModelId);
  }
  for (const model of fastFirst) {
    if (ordered.length >= maxCandidates) break;
    if (picked.has(model.openrouterModelId)) continue;
    picked.add(model.openrouterModelId);
    ordered.push(model.openrouterModelId);
  }
  return ordered;
}

export async function refineBenchmarkCandidates({
  working,
  selectedIds,
  extraRuns,
  openrouterKey,
  timeoutMs,
  fetchImpl,
  generate = generateTextWithModelId,
  now = Date.now,
  onFailure,
}: {
  working: BenchmarkedOpenRouterModel[];
  selectedIds: string[];
  extraRuns: number;
  openrouterKey: string;
  timeoutMs: number;
  fetchImpl: typeof fetch;
  generate?: GenerateModel;
  now?: () => number;
  onFailure?: ((result: { modelId: string; error: unknown }) => void) | null;
}): Promise<BenchmarkedOpenRouterModel[]> {
  const refined = working.slice();
  if (extraRuns <= 0 || selectedIds.length === 0) return refined;

  const apiKeys = createApiKeys(openrouterKey);
  const byId = new Map(refined.map((model) => [model.openrouterModelId, model] as const));
  for (const modelId of selectedIds) {
    const entry = byId.get(modelId);
    if (!entry) continue;
    const latencies = [entry.initialLatencyMs];
    let successCount = entry.successCount;
    let lastError: unknown = null;

    for (let run = 0; run < extraRuns; run += 1) {
      const runStartedAt = now();
      try {
        await runProbe({ modelId, apiKeys, timeoutMs, fetchImpl, generate });
        successCount += 1;
        const latencyMs = now() - runStartedAt;
        entry.totalLatencyMs += latencyMs;
        latencies.push(latencyMs);
      } catch (error) {
        lastError = error;
      }
    }

    if (successCount === 0 && lastError) {
      onFailure?.({ modelId, error: lastError });
      continue;
    }
    latencies.sort((a, b) => a - b);
    entry.medianLatencyMs = latencies[Math.floor(latencies.length / 2)] ?? entry.medianLatencyMs;
    entry.successCount = successCount;
  }
  return refined;
}
