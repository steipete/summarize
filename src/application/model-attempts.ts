import type { AutoRuleKind, CliProvider, SummarizeConfig } from "../config.js";
import { createFixedModelAttempt } from "../engine/fixed-model-attempt.js";
import { applyProviderRuntimeToModelAttempt } from "../engine/provider-attempt.js";
import type { ModelAttempt } from "../engine/types.js";
import { cliProviderForRequiredEnv, envHasRequiredKey } from "../llm/provider-capabilities.js";
import type { ProviderRuntimeBindings } from "../llm/provider-profile.js";
import { buildAutoModelAttempts } from "../model-auto.js";
import type { RequestedModel } from "../model-spec.js";
import type { LiteLlmCatalog } from "../pricing/litellm.js";
import { parseCliUserModelId } from "../run/env.js";

function bindAttempt(
  attempt: ModelAttempt,
  providerRuntime: ProviderRuntimeBindings,
): ModelAttempt {
  if (attempt.transport === "cli") {
    const parsed =
      attempt.cliProvider != null
        ? { provider: attempt.cliProvider, model: attempt.cliModel ?? null }
        : parseCliUserModelId(attempt.userModelId);
    return {
      ...attempt,
      cliProvider: parsed.provider,
      cliModel: parsed.model,
    };
  }
  return applyProviderRuntimeToModelAttempt(attempt, providerRuntime);
}

export function resolveModelAttempts({
  requestedModel,
  kind,
  promptTokens,
  desiredOutputTokens,
  requiresVideoUnderstanding,
  envForAuto,
  configForModelSelection,
  catalog,
  openrouterProvidersFromEnv,
  cliAvailability,
  isImplicitAutoSelection = false,
  allowAutoCliFallback = false,
  lastSuccessfulCliProvider = null,
  providerRuntime,
}: {
  requestedModel: RequestedModel;
  kind: AutoRuleKind;
  promptTokens: number | null;
  desiredOutputTokens: number | null;
  requiresVideoUnderstanding: boolean;
  envForAuto: Record<string, string | undefined>;
  configForModelSelection: SummarizeConfig | null;
  catalog: LiteLlmCatalog | null;
  openrouterProvidersFromEnv: string[] | null;
  cliAvailability: Partial<Record<CliProvider, boolean>>;
  isImplicitAutoSelection?: boolean;
  allowAutoCliFallback?: boolean;
  lastSuccessfulCliProvider?: CliProvider | null;
  providerRuntime: ProviderRuntimeBindings;
}): ModelAttempt[] {
  const attempts =
    requestedModel.kind === "fixed"
      ? [createFixedModelAttempt(requestedModel)]
      : buildAutoModelAttempts({
          kind,
          promptTokens,
          desiredOutputTokens,
          requiresVideoUnderstanding,
          env: envForAuto,
          config: configForModelSelection,
          catalog,
          openrouterProvidersFromEnv,
          cliAvailability,
          isImplicitAutoSelection,
          allowAutoCliFallback,
          lastSuccessfulCliProvider,
        });
  return attempts.map((attempt) => bindAttempt(attempt, providerRuntime));
}

export function selectPreferredInteractiveModelAttempt({
  attempts,
  envForAuto,
  cliAvailability,
  requireCliAvailability = true,
}: {
  attempts: ModelAttempt[];
  envForAuto: Record<string, string | undefined>;
  cliAvailability: Partial<Record<CliProvider, boolean>>;
  requireCliAvailability?: boolean;
}): ModelAttempt | null {
  const apiAttempt =
    attempts.find(
      (attempt) =>
        attempt.transport !== "cli" && envHasRequiredKey(envForAuto, attempt.requiredEnv),
    ) ?? null;
  if (apiAttempt) return apiAttempt;

  return (
    attempts.find((attempt) => {
      if (attempt.transport !== "cli") return false;
      const provider =
        attempt.cliProvider ?? cliProviderForRequiredEnv(attempt.requiredEnv) ?? null;
      return provider !== null && (!requireCliAvailability || Boolean(cliAvailability[provider]));
    }) ?? null
  );
}
