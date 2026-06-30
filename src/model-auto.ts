import * as piAi from "@earendil-works/pi-ai/compat";
import type { AutoRuleKind, CliProvider, SummarizeConfig } from "./config.js";
import { normalizeGatewayStyleModelId, parseGatewayStyleModelId } from "./llm/model-id.js";
import type { ModelRequestOptions } from "./llm/model-options.js";
import {
  DEFAULT_CLI_MODELS,
  envHasRequiredKey,
  isVideoUnderstandingCapableModelId,
  parseCliProviderName,
  resolveRequiredEnvForModelId,
  type RequiredModelEnv,
} from "./llm/provider-capabilities.js";
import {
  prependCliCandidates,
  resolveCliAutoFallbackConfig,
  type ResolvedCliAutoFallbackConfig,
} from "./model-auto-cli.js";
import { resolveRuleCandidates } from "./model-auto-rules.js";
import { resolveOpenAiFastModelId } from "./model-spec.js";
import type { LiteLlmCatalog } from "./pricing/litellm.js";
import {
  resolveLiteLlmMaxInputTokensForModelId,
  resolveLiteLlmPricingForModelId,
} from "./pricing/litellm.js";

export { resolveCliAutoFallbackConfig };
export type { ResolvedCliAutoFallbackConfig };

export type AutoSelectionInput = {
  kind: AutoRuleKind;
  promptTokens: number | null;
  desiredOutputTokens: number | null;
  requiresVideoUnderstanding: boolean;
  env: Record<string, string | undefined>;
  config: SummarizeConfig | null;
  catalog: LiteLlmCatalog | null;
  openrouterProvidersFromEnv: string[] | null;
  openrouterModelIds?: string[] | null;
  cliAvailability?: Partial<Record<CliProvider, boolean>>;
  isImplicitAutoSelection?: boolean;
  allowAutoCliFallback?: boolean;
  lastSuccessfulCliProvider?: CliProvider | null;
};

export type AutoModelAttempt = {
  transport: "native" | "openrouter" | "cli";
  userModelId: string;
  llmModelId: string | null;
  openrouterProviders: string[] | null;
  forceOpenRouter: boolean;
  requiredEnv: RequiredModelEnv;
  requestOptions?: ModelRequestOptions;
  debug: string;
};

type OpenRouterModelIndex = {
  byId: Map<string, string>;
  bySlug: Map<string, Set<string>>;
  bySlugNormalized: Map<string, Set<string>>;
};

let cachedOpenRouterIndex: OpenRouterModelIndex | null = null;
let cachedOpenRouterIndexReady = false;

function buildOpenRouterModelIndex(modelIds: string[]): OpenRouterModelIndex {
  const byId = new Map<string, string>();
  const bySlug = new Map<string, Set<string>>();
  const bySlugNormalized = new Map<string, Set<string>>();
  for (const raw of modelIds) {
    const trimmed = raw.trim();
    if (trimmed.length === 0) continue;
    if (!trimmed.includes("/")) continue;
    const normalized = trimmed.toLowerCase();
    // Preserve original casing for display while indexing by lowercase.
    if (!byId.has(normalized)) byId.set(normalized, trimmed);
    const slash = normalized.indexOf("/");
    if (slash === -1 || slash === normalized.length - 1) continue;
    const slug = normalized.slice(slash + 1);
    let matches = bySlug.get(slug);
    if (!matches) {
      matches = new Set();
      bySlug.set(slug, matches);
    }
    matches.add(normalized);
    const normalizedSlug = normalizeSlugForMatch(slug);
    if (normalizedSlug.length > 0) {
      let normalizedMatches = bySlugNormalized.get(normalizedSlug);
      if (!normalizedMatches) {
        normalizedMatches = new Set();
        bySlugNormalized.set(normalizedSlug, normalizedMatches);
      }
      normalizedMatches.add(normalized);
    }
  }
  return { byId, bySlug, bySlugNormalized };
}

function getOpenRouterModelIndex(
  override: string[] | null | undefined,
): OpenRouterModelIndex | null {
  // Tests can inject a deterministic OpenRouter model list to avoid SDK coupling.
  if (Array.isArray(override)) return buildOpenRouterModelIndex(override);
  // Lazy, process-wide cache to avoid recomputing the SDK catalog.
  if (cachedOpenRouterIndexReady) return cachedOpenRouterIndex;
  cachedOpenRouterIndexReady = true;
  const ids =
    typeof piAi.getModels === "function"
      ? piAi.getModels("openrouter").map((model) => model.id)
      : [];
  cachedOpenRouterIndex = ids.length > 0 ? buildOpenRouterModelIndex(ids) : null;
  return cachedOpenRouterIndex;
}

function resolveOpenRouterModelIdForNative({
  nativeModelId,
  index,
}: {
  nativeModelId: string;
  index: OpenRouterModelIndex | null;
}): string | null {
  if (!index) return null;
  const canonical = normalizeGatewayStyleModelId(nativeModelId);
  const canonicalLower = canonical.toLowerCase();
  // Prefer exact match on canonical <provider>/<model> when OpenRouter mirrors the id.
  const direct = index.byId.get(canonicalLower);
  if (direct) return direct;
  const slash = canonicalLower.indexOf("/");
  if (slash === -1 || slash === canonicalLower.length - 1) return null;
  // Fall back to a unique slug match (author differs, e.g. xai → x-ai).
  const slug = canonicalLower.slice(slash + 1);
  const matches = index.bySlug.get(slug);
  if (matches && matches.size === 1) {
    const only = matches.values().next().value as string | undefined;
    const exactMatch = only ? (index.byId.get(only) ?? null) : null;
    if (exactMatch) return exactMatch;
  }
  // Retry with punctuation-insensitive slug (e.g. grok-4-1-fast → grok-4.1-fast).
  const normalizedSlug = normalizeSlugForMatch(slug);
  if (!normalizedSlug) return null;
  const normalizedMatches = index.bySlugNormalized.get(normalizedSlug);
  if (!normalizedMatches || normalizedMatches.size !== 1) return null;
  const normalizedOnly = normalizedMatches.values().next().value as string | undefined;
  return normalizedOnly ? (index.byId.get(normalizedOnly) ?? null) : null;
}

function normalizeSlugForMatch(slug: string): string {
  return slug.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function isCandidateOpenRouter(modelId: string): boolean {
  return modelId.trim().toLowerCase().startsWith("openrouter/");
}

function isCandidateCli(modelId: string): boolean {
  return modelId.trim().toLowerCase().startsWith("cli/");
}

function parseCliCandidate(
  modelId: string,
): { provider: CliProvider; model: string | null } | null {
  if (!isCandidateCli(modelId)) return null;
  const parts = modelId
    .trim()
    .split("/")
    .map((entry) => entry.trim());
  if (parts.length < 2) return null;
  const provider = parseCliProviderName(parts[1] ?? "");
  if (!provider) return null;
  const model = parts.slice(2).join("/").trim();
  return { provider, model: model.length > 0 ? model : null };
}

function normalizeOpenRouterModelId(raw: string): string | null {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  if (!trimmed.includes("/")) return null;
  return trimmed.toLowerCase();
}

function requiredEnvForCandidate(modelId: string): AutoModelAttempt["requiredEnv"] {
  return resolveRequiredEnvForModelId(modelId);
}

export function envHasKey(
  env: Record<string, string | undefined>,
  requiredEnv: AutoModelAttempt["requiredEnv"],
): boolean {
  return envHasRequiredKey(env, requiredEnv);
}

function estimateCostUsd({
  pricing,
  promptTokens,
  outputTokens,
}: {
  pricing: { inputUsdPerToken: number; outputUsdPerToken: number } | null;
  promptTokens: number | null;
  outputTokens: number | null;
}): number | null {
  if (!pricing) return null;
  if (typeof pricing.inputUsdPerToken !== "number" || typeof pricing.outputUsdPerToken !== "number")
    return null;
  const inTok =
    typeof promptTokens === "number" && Number.isFinite(promptTokens) && promptTokens > 0
      ? promptTokens
      : 0;
  const outTok =
    typeof outputTokens === "number" && Number.isFinite(outputTokens) && outputTokens > 0
      ? outputTokens
      : 0;
  const cost = inTok * pricing.inputUsdPerToken + outTok * pricing.outputUsdPerToken;
  return Number.isFinite(cost) ? cost : null;
}

export function buildAutoModelAttempts(input: AutoSelectionInput): AutoModelAttempt[] {
  const baseCandidates = resolveRuleCandidates({
    kind: input.kind,
    promptTokens: input.promptTokens,
    config: input.config,
  });
  const candidates = prependCliCandidates({
    candidates: baseCandidates,
    config: input.config,
    env: input.env,
    isImplicitAutoSelection: input.isImplicitAutoSelection ?? false,
    allowAutoCliFallback: input.allowAutoCliFallback ?? false,
    lastSuccessfulCliProvider: input.lastSuccessfulCliProvider ?? null,
  });
  const shouldResolveOpenRouterIndex =
    !input.requiresVideoUnderstanding && envHasKey(input.env, "OPENROUTER_API_KEY");
  // Resolve OpenRouter ids once per run (or use injected test list).
  const openrouterIndex = shouldResolveOpenRouterIndex
    ? getOpenRouterModelIndex(input.openrouterModelIds)
    : null;

  const attempts: AutoModelAttempt[] = [];
  for (const modelRawEntry of candidates) {
    const modelRaw = modelRawEntry.trim();
    if (modelRaw.length === 0) continue;

    const explicitCli = isCandidateCli(modelRaw);
    const explicitOpenRouter = isCandidateOpenRouter(modelRaw);

    const shouldSkipForVideo =
      input.requiresVideoUnderstanding &&
      (explicitOpenRouter || explicitCli || !isVideoUnderstandingCapableModelId(modelRaw));
    if (shouldSkipForVideo) {
      continue;
    }

    const addAttempt = (
      modelId: string,
      options: {
        openrouter: boolean;
        openrouterProviders: string[] | null;
        transport: AutoModelAttempt["transport"];
      },
    ) => {
      const required = requiredEnvForCandidate(modelId);
      const hasKey =
        options.transport === "cli"
          ? Boolean(
              input.cliAvailability?.[parseCliCandidate(modelId)?.provider ?? "claude"] ?? false,
            )
          : envHasKey(input.env, required);
      if (options.transport === "cli" && !hasKey) {
        return;
      }

      const catalog = options.transport === "cli" ? null : input.catalog;
      const catalogModelId = options.openrouter ? modelId.slice("openrouter/".length) : modelId;
      const maxIn = catalog
        ? resolveLiteLlmMaxInputTokensForModelId(catalog, catalogModelId)
        : null;
      const promptTokens = input.promptTokens;
      if (
        options.transport !== "cli" &&
        typeof promptTokens === "number" &&
        Number.isFinite(promptTokens) &&
        typeof maxIn === "number" &&
        Number.isFinite(maxIn) &&
        maxIn > 0 &&
        promptTokens > maxIn
      ) {
        return;
      }

      const pricing = catalog ? resolveLiteLlmPricingForModelId(catalog, catalogModelId) : null;
      const estimated = estimateCostUsd({
        pricing,
        promptTokens: input.promptTokens,
        outputTokens: input.desiredOutputTokens,
      });

      const userModelId =
        options.transport === "cli"
          ? modelId
          : options.openrouter
            ? modelId
            : normalizeGatewayStyleModelId(modelId);
      const openrouterModelId = options.openrouter
        ? normalizeOpenRouterModelId(modelId.slice("openrouter/".length))
        : null;
      if (options.openrouter && !openrouterModelId) {
        return;
      }
      const llmModelId =
        options.transport === "cli"
          ? null
          : options.openrouter
            ? `openai/${openrouterModelId}`
            : normalizeGatewayStyleModelId(modelId);
      const parsedLlmModelId =
        options.transport === "native" && llmModelId ? parseGatewayStyleModelId(llmModelId) : null;
      const fastOpenAi =
        parsedLlmModelId?.provider === "openai"
          ? resolveOpenAiFastModelId(parsedLlmModelId.model)
          : null;
      const effectiveLlmModelId = fastOpenAi ? `openai/${fastOpenAi.modelId}` : llmModelId;
      const debugParts = [
        `model=${
          options.transport === "cli"
            ? userModelId
            : options.openrouter
              ? `openrouter/${openrouterModelId}`
              : userModelId
        }`,
        `transport=${options.transport}`,
        `order=${attempts.length + 1}`,
        `key=${hasKey ? "yes" : "no"}(${required})`,
        `promptTok=${typeof input.promptTokens === "number" ? input.promptTokens : "unknown"}`,
        `maxIn=${typeof maxIn === "number" ? maxIn : "unknown"}`,
        `estUsd=${typeof estimated === "number" ? estimated.toExponential(2) : "unknown"}`,
      ];

      attempts.push({
        transport: options.transport,
        userModelId: options.openrouter ? `openrouter/${openrouterModelId}` : userModelId,
        llmModelId: effectiveLlmModelId,
        openrouterProviders: options.openrouterProviders,
        forceOpenRouter: options.openrouter,
        requiredEnv: required,
        ...(fastOpenAi ? { requestOptions: fastOpenAi.options } : {}),
        debug: debugParts.join(" "),
      });
    };

    if (explicitCli) {
      addAttempt(modelRaw, {
        openrouter: false,
        openrouterProviders: null,
        transport: "cli",
      });
      continue;
    }

    if (explicitOpenRouter) {
      addAttempt(modelRaw, {
        openrouter: true,
        openrouterProviders: input.openrouterProvidersFromEnv,
        transport: "openrouter",
      });
      continue;
    }

    addAttempt(modelRaw, {
      openrouter: false,
      openrouterProviders: input.openrouterProvidersFromEnv,
      transport: "native",
    });

    const canAddOpenRouterFallback =
      !input.requiresVideoUnderstanding && envHasKey(input.env, "OPENROUTER_API_KEY");
    if (canAddOpenRouterFallback) {
      // Map native provider/model to OpenRouter author/slug; skip when ambiguous.
      const openrouterModelId = resolveOpenRouterModelIdForNative({
        nativeModelId: modelRaw,
        index: openrouterIndex,
      });
      if (openrouterModelId) {
        addAttempt(`openrouter/${openrouterModelId}`, {
          openrouter: true,
          openrouterProviders: input.openrouterProvidersFromEnv,
          transport: "openrouter",
        });
      }
    }
  }

  const seen = new Set<string>();
  const unique: AutoModelAttempt[] = [];
  for (const a of attempts) {
    const key = `${a.transport}:${a.forceOpenRouter ? "or" : "native"}:${a.userModelId}:${a.openrouterProviders?.join(",") ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(a);
  }
  return unique;
}
