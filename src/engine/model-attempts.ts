import { hasEngineErrorCode } from "./errors.js";
import type { ModelAttempt, ModelAttemptRequiredEnv } from "./types.js";

export async function runModelAttempts<T>({
  attempts,
  isFallbackModel,
  isNamedModelSelection,
  envHasKeyFor,
  formatMissingModelError,
  onAutoSkip,
  onAutoFailure,
  onFixedModelError,
  runAttempt,
}: {
  attempts: ModelAttempt[];
  isFallbackModel: boolean;
  isNamedModelSelection: boolean;
  envHasKeyFor: (requiredEnv: ModelAttemptRequiredEnv) => boolean;
  formatMissingModelError: (attempt: ModelAttempt) => string;
  onAutoSkip?: (attempt: ModelAttempt) => void;
  onAutoFailure?: (attempt: ModelAttempt, error: unknown) => void;
  onFixedModelError?: (attempt: ModelAttempt, error: unknown) => never;
  runAttempt: (attempt: ModelAttempt) => Promise<T>;
}): Promise<{
  result: T | null;
  usedAttempt: ModelAttempt | null;
  missingRequiredEnvs: Set<ModelAttemptRequiredEnv>;
  lastError: unknown;
  sawOpenRouterNoAllowedProviders: boolean;
}> {
  let result: T | null = null;
  let usedAttempt: ModelAttempt | null = null;
  let lastError: unknown = null;
  let sawOpenRouterNoAllowedProviders = false;
  const missingRequiredEnvs = new Set<ModelAttemptRequiredEnv>();

  for (const attempt of attempts) {
    const hasKey = envHasKeyFor(attempt.requiredEnv);
    if (!hasKey) {
      if (isFallbackModel) {
        // Auto mode keeps going; named auto presets should still surface missing keys later.
        if (isNamedModelSelection) {
          missingRequiredEnvs.add(attempt.requiredEnv);
        } else {
          onAutoSkip?.(attempt);
        }
        continue;
      }
      throw new Error(formatMissingModelError(attempt));
    }

    try {
      result = await runAttempt(attempt);
      usedAttempt = attempt;
      break;
    } catch (error) {
      if (hasEngineErrorCode(error, "SUMMARY_STREAM_INTERRUPTED")) {
        throw error;
      }
      lastError = error;
      if (
        isNamedModelSelection &&
        error instanceof Error &&
        /* i18n-ignore: OpenRouter provider-availability diagnostic. */ /No allowed providers are available for the selected model/i.test(
          error.message,
        )
      ) {
        sawOpenRouterNoAllowedProviders = true;
      }

      if (!isFallbackModel) {
        if (onFixedModelError) {
          onFixedModelError(attempt, error);
        }
        throw error;
      }
      onAutoFailure?.(attempt, error);
    }
  }

  return { result, usedAttempt, missingRequiredEnvs, lastError, sawOpenRouterNoAllowedProviders };
}
