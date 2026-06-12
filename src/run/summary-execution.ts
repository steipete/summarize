import { buildSummaryCacheKey, type CacheStore } from "../cache.js";
import type { CliProvider } from "../config.js";
import { runModelAttempts } from "./model-attempts.js";
import { buildOpenRouterNoAllowedProvidersMessage } from "./openrouter.js";
import type { ModelAttempt, ModelAttemptRequiredEnv } from "./types.js";

type SummaryResult = {
  summary: string;
};

type SummaryCacheConfig = {
  store: CacheStore | null;
  ttlMs: number;
  contentHash: string | null;
  promptHash: string | null;
  lengthKey: string;
  languageKey: string;
  autoSelectionModel: string | null;
};

export type SummaryExecutionFailure = {
  lastError: unknown;
  missingRequiredEnvs: Set<ModelAttemptRequiredEnv>;
  sawOpenRouterNoAllowedProviders: boolean;
};

export async function executeSummaryAttempts<T extends SummaryResult>({
  attempts,
  isFallbackModel,
  isNamedModelSelection,
  wantsFreeNamedModel,
  requestedModelInput,
  envHasKeyFor,
  formatMissingModelError,
  cache,
  verbose,
  onModelChosen,
  onCacheResolved,
  buildCachedResult,
  runAttempt,
  normalizeResult,
  onFixedModelError,
  fetchImpl,
  timeoutMs,
  rememberCliProvider,
}: {
  attempts: ModelAttempt[];
  isFallbackModel: boolean;
  isNamedModelSelection: boolean;
  wantsFreeNamedModel: boolean;
  requestedModelInput: string;
  envHasKeyFor: (requiredEnv: ModelAttemptRequiredEnv) => boolean;
  formatMissingModelError: (attempt: ModelAttempt) => string;
  cache: SummaryCacheConfig;
  verbose: (message: string) => void;
  onModelChosen?: ((modelId: string) => void) | null;
  onCacheResolved?: ((hit: boolean) => void) | null;
  buildCachedResult: (attempt: ModelAttempt, summary: string) => T;
  runAttempt: (attempt: ModelAttempt) => Promise<T>;
  normalizeResult?: ((result: T, attempt: ModelAttempt) => T | Promise<T>) | null;
  onFixedModelError?: ((attempt: ModelAttempt, error: unknown) => never) | null;
  fetchImpl: typeof fetch;
  timeoutMs: number;
  rememberCliProvider?: ((provider: CliProvider) => Promise<void>) | null;
}): Promise<{
  result: T | null;
  usedAttempt: ModelAttempt | null;
  summaryFromCache: boolean;
  failure: SummaryExecutionFailure;
}> {
  const { store, ttlMs, contentHash, promptHash, lengthKey, languageKey, autoSelectionModel } =
    cache;
  let result: T | null = null;
  let usedAttempt: ModelAttempt | null = null;
  let summaryFromCache = false;
  let cacheChecked = false;

  if (store && contentHash && promptHash) {
    cacheChecked = true;
    if (autoSelectionModel) {
      const key = buildSummaryCacheKey({
        contentHash,
        promptHash,
        model: autoSelectionModel,
        lengthKey,
        languageKey,
      });
      const cached = store.getJson<{ summary?: unknown; model?: unknown }>("summary", key);
      const summary = cached && typeof cached.summary === "string" ? cached.summary.trim() : null;
      const cachedModelId = cached && typeof cached.model === "string" ? cached.model.trim() : null;
      if (summary) {
        const cachedAttempt = cachedModelId
          ? (attempts.find((attempt) => attempt.userModelId === cachedModelId) ?? null)
          : null;
        const fallbackAttempt =
          attempts.find((attempt) => envHasKeyFor(attempt.requiredEnv)) ?? attempts[0] ?? null;
        const matchedAttempt =
          cachedAttempt && envHasKeyFor(cachedAttempt.requiredEnv)
            ? cachedAttempt
            : fallbackAttempt;
        if (matchedAttempt) {
          verbose("cache hit summary (auto selection)");
          onModelChosen?.(cachedModelId || matchedAttempt.userModelId);
          result = buildCachedResult(matchedAttempt, summary);
          usedAttempt = matchedAttempt;
          summaryFromCache = true;
        }
      }
    }

    if (!summaryFromCache) {
      for (const attempt of attempts) {
        if (!envHasKeyFor(attempt.requiredEnv)) continue;
        const key = buildSummaryCacheKey({
          contentHash,
          promptHash,
          model: attempt.userModelId,
          lengthKey,
          languageKey,
        });
        const summary = store.getText("summary", key);
        if (!summary) continue;
        verbose("cache hit summary");
        onModelChosen?.(attempt.userModelId);
        result = buildCachedResult(attempt, summary);
        usedAttempt = attempt;
        summaryFromCache = true;
        break;
      }
    }
  }

  if (cacheChecked && !summaryFromCache) {
    verbose("cache miss summary");
  }
  onCacheResolved?.(summaryFromCache);

  let failure: SummaryExecutionFailure = {
    lastError: null,
    missingRequiredEnvs: new Set(),
    sawOpenRouterNoAllowedProviders: false,
  };

  if (!result || !usedAttempt) {
    const outcome = await runModelAttempts({
      attempts,
      isFallbackModel,
      isNamedModelSelection,
      envHasKeyFor,
      formatMissingModelError,
      onAutoSkip: (attempt) =>
        verbose(`auto skip ${attempt.userModelId}: missing ${attempt.requiredEnv}`),
      onAutoFailure: (attempt, error) =>
        verbose(
          `auto failed ${attempt.userModelId}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        ),
      onFixedModelError: onFixedModelError ?? undefined,
      runAttempt,
    });
    result = outcome.result;
    usedAttempt = outcome.usedAttempt;
    failure = {
      lastError: outcome.lastError,
      missingRequiredEnvs: outcome.missingRequiredEnvs,
      sawOpenRouterNoAllowedProviders: outcome.sawOpenRouterNoAllowedProviders,
    };
  }

  if (!result || !usedAttempt) {
    if (isNamedModelSelection) {
      const withFreeTip = (message: string) => {
        if (!wantsFreeNamedModel) return message;
        return (
          `${message}\n` +
          `Tip: run "summarize refresh-free" to refresh the free model candidates (writes ~/.summarize/config.json).`
        );
      };
      if (failure.lastError === null && failure.missingRequiredEnvs.size > 0) {
        throw new Error(
          withFreeTip(
            `Missing ${Array.from(failure.missingRequiredEnvs).sort().join(", ")} for --model ${requestedModelInput}.`,
          ),
        );
      }
      if (failure.lastError instanceof Error) {
        if (failure.sawOpenRouterNoAllowedProviders) {
          const message = await buildOpenRouterNoAllowedProvidersMessage({
            attempts,
            fetchImpl,
            timeoutMs,
          });
          throw new Error(withFreeTip(message), { cause: failure.lastError });
        }
        throw new Error(withFreeTip(failure.lastError.message), { cause: failure.lastError });
      }
      throw new Error(withFreeTip(`No model available for --model ${requestedModelInput}`));
    }
    return { result: null, usedAttempt: null, summaryFromCache, failure };
  }

  if (normalizeResult) {
    result = await normalizeResult(result, usedAttempt);
  }

  if (!summaryFromCache && store && contentHash && promptHash) {
    const perModelKey = buildSummaryCacheKey({
      contentHash,
      promptHash,
      model: usedAttempt.userModelId,
      lengthKey,
      languageKey,
    });
    store.setText("summary", perModelKey, result.summary, ttlMs);
    verbose("cache write summary");
    if (autoSelectionModel) {
      const selectionKey = buildSummaryCacheKey({
        contentHash,
        promptHash,
        model: autoSelectionModel,
        lengthKey,
        languageKey,
      });
      store.setJson(
        "summary",
        selectionKey,
        { summary: result.summary, model: usedAttempt.userModelId },
        ttlMs,
      );
      verbose("cache write summary (auto selection)");
    }
  }

  if (
    !summaryFromCache &&
    isFallbackModel &&
    usedAttempt.transport === "cli" &&
    usedAttempt.cliProvider &&
    rememberCliProvider
  ) {
    await rememberCliProvider(usedAttempt.cliProvider);
  }

  return { result, usedAttempt, summaryFromCache, failure };
}
