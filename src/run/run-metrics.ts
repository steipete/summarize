import { fetchWithDnsPinnedAddresses } from "@steipete/summarize-core/content";
import {
  isNativeOrBoundGlobalFetch,
  markFetchAsDnsPinned,
  resolveDnsPinnedFetch,
  supportsDnsPinnedFetch,
} from "@steipete/summarize-core/content";
import { normalizeTokenUsage, tallyCosts } from "tokentally";
import { fetch as undiciFetch } from "undici";
import type { LlmCall, RunMetricsReport } from "../costs.js";
import { buildRunMetricsReport } from "../costs.js";
import {
  loadCachedLiteLlmCatalog,
  loadLiteLlmCatalog,
  resolveLiteLlmMaxInputTokensForModelId,
  resolveLiteLlmMaxOutputTokensForModelId,
  resolveLiteLlmPricingForModelId,
} from "../pricing/litellm.js";

export type RunMetrics = {
  llmCalls: LlmCall[];
  trackedFetch: typeof fetch;
  buildReport: () => Promise<RunMetricsReport>;
  estimateCostUsd: () => Promise<number | null>;
  getLiteLlmCatalog: () => Promise<Awaited<ReturnType<typeof loadLiteLlmCatalog>>["catalog"]>;
  resolveMaxOutputTokensForCall: (modelId: string) => Promise<number | null>;
  resolveMaxInputTokensForCall: (modelId: string) => Promise<number | null>;
  setTranscriptionCost: (costUsd: number | null, label: string | null) => void;
};

function explicitCallCostUsd(call: LlmCall): number | null {
  if (typeof call.costUsd === "number" && Number.isFinite(call.costUsd)) return call.costUsd;
  return null;
}

export function createRunMetrics({
  env,
  fetchImpl,
  maxOutputTokensArg,
}: {
  env: Record<string, string | undefined>;
  fetchImpl: typeof fetch;
  maxOutputTokensArg: number | null;
}): RunMetrics {
  const llmCalls: LlmCall[] = [];
  let firecrawlRequests = 0;
  let apifyRequests = 0;
  const transcriptionCost = {
    value: null as number | null,
    label: null as string | null,
  };

  const setTranscriptionCost = (costUsd: number | null, label: string | null) => {
    transcriptionCost.value = costUsd;
    transcriptionCost.label = label;
  };

  let liteLlmCatalogPromise: ReturnType<typeof loadLiteLlmCatalog> | null = null;
  let cachedLiteLlmCatalogPromise: ReturnType<typeof loadCachedLiteLlmCatalog> | null = null;
  const getLiteLlmCatalog = async () => {
    if (!liteLlmCatalogPromise) {
      liteLlmCatalogPromise = loadLiteLlmCatalog({
        env,
        fetchImpl: globalThis.fetch.bind(globalThis),
      });
    }
    const result = await liteLlmCatalogPromise;
    return result.catalog;
  };
  const getCachedLiteLlmCatalog = async () => {
    if (!cachedLiteLlmCatalogPromise) {
      cachedLiteLlmCatalogPromise = loadCachedLiteLlmCatalog({ env });
    }
    return cachedLiteLlmCatalogPromise;
  };

  const capMaxOutputTokensForModel = async ({
    modelId,
    requested,
  }: {
    modelId: string;
    requested: number;
  }): Promise<number> => {
    const catalog = await getCachedLiteLlmCatalog();
    if (!catalog) return requested;
    const limit = resolveLiteLlmMaxOutputTokensForModelId(catalog, modelId);
    if (typeof limit === "number" && Number.isFinite(limit) && limit > 0) {
      return Math.min(requested, limit);
    }
    return requested;
  };

  const resolveMaxOutputTokensForCall = async (modelId: string): Promise<number | null> => {
    if (typeof maxOutputTokensArg !== "number") return null;
    return capMaxOutputTokensForModel({ modelId, requested: maxOutputTokensArg });
  };

  const resolveMaxInputTokensForCall = async (modelId: string): Promise<number | null> => {
    const catalog = await getCachedLiteLlmCatalog();
    if (!catalog) return null;
    const limit = resolveLiteLlmMaxInputTokensForModelId(catalog, modelId);
    if (typeof limit === "number" && Number.isFinite(limit) && limit > 0) {
      return limit;
    }
    return null;
  };

  const estimateCostUsd = async (): Promise<number | null> => {
    const extraCosts = [
      typeof transcriptionCost.value === "number" && Number.isFinite(transcriptionCost.value)
        ? transcriptionCost.value
        : null,
    ].filter((value): value is number => typeof value === "number");
    const extraTotal =
      extraCosts.length > 0 ? extraCosts.reduce((sum, value) => sum + value, 0) : 0;
    const hasExtra = extraCosts.length > 0;

    const explicitCosts = llmCalls
      .map((call) => explicitCallCostUsd(call))
      .filter((value): value is number => typeof value === "number");
    const explicitTotal =
      explicitCosts.length > 0 ? explicitCosts.reduce((sum, value) => sum + value, 0) : 0;

    const callsWithoutExplicitCost = llmCalls.filter((call) => explicitCallCostUsd(call) === null);
    const hasUnknownLlmCost = callsWithoutExplicitCost.some((call) => {
      const promptTokens = call.usage?.promptTokens ?? null;
      const completionTokens = call.usage?.completionTokens ?? null;
      return !(
        typeof promptTokens === "number" &&
        Number.isFinite(promptTokens) &&
        typeof completionTokens === "number" &&
        Number.isFinite(completionTokens)
      );
    });
    if (hasUnknownLlmCost) return null;

    const calls = callsWithoutExplicitCost.map((call) => {
      const promptTokens = call.usage?.promptTokens ?? null;
      const completionTokens = call.usage?.completionTokens ?? null;
      const hasTokens =
        typeof promptTokens === "number" &&
        Number.isFinite(promptTokens) &&
        typeof completionTokens === "number" &&
        Number.isFinite(completionTokens);
      const usage = hasTokens
        ? normalizeTokenUsage({
            inputTokens: promptTokens,
            outputTokens: completionTokens,
            totalTokens: call.usage?.totalTokens ?? undefined,
          })
        : null;
      return { model: call.model, usage };
    });
    if (calls.length === 0) {
      if (explicitCosts.length > 0 || hasExtra) return explicitTotal + extraTotal;
      return null;
    }

    const catalog = await getCachedLiteLlmCatalog();
    if (!catalog) return null;
    const result = await tallyCosts({
      calls,
      resolvePricing: (modelId) => resolveLiteLlmPricingForModelId(catalog, modelId),
    });
    if (Object.values(result.byModel).some((row) => row.cost === null)) return null;
    const catalogTotal = result.total?.totalUsd ?? null;
    if (catalogTotal === null) return null;
    return catalogTotal + explicitTotal + extraTotal;
  };

  const buildReport = async () => {
    return buildRunMetricsReport({ llmCalls, firecrawlRequests, apifyRequests });
  };

  const recordFetch = (input: RequestInfo | URL): void => {
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    let hostname: string | null = null;
    try {
      hostname = new URL(url).hostname.toLowerCase();
    } catch {
      hostname = null;
    }
    if (hostname === "api.firecrawl.dev") {
      firecrawlRequests += 1;
    } else if (hostname === "api.apify.com") {
      apifyRequests += 1;
    }
  };
  const fetchAndTrack = async (
    targetFetch: typeof fetch,
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> => {
    recordFetch(input);
    return await targetFetch(input as RequestInfo, init);
  };
  const trackedFetch: typeof fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    return await fetchAndTrack(fetchImpl, input, init);
  };
  const isBunRuntime = typeof (process.versions as { bun?: string }).bun === "string";
  const isNativeFetch = isNativeOrBoundGlobalFetch(fetchImpl);
  const pinnedFetchImpl =
    resolveDnsPinnedFetch(fetchImpl) ??
    (isNativeFetch
      ? isBunRuntime
        ? fetchWithDnsPinnedAddresses
        : (undiciFetch as unknown as typeof fetch)
      : null);
  if ((isNativeFetch || supportsDnsPinnedFetch(fetchImpl)) && pinnedFetchImpl) {
    const trackedPinnedFetch: typeof fetch = async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      return await fetchAndTrack(pinnedFetchImpl, input, init);
    };
    markFetchAsDnsPinned(trackedFetch, trackedPinnedFetch);
  }

  return {
    llmCalls,
    trackedFetch,
    buildReport,
    estimateCostUsd,
    getLiteLlmCatalog,
    resolveMaxOutputTokensForCall,
    resolveMaxInputTokensForCall,
    setTranscriptionCost,
  };
}
