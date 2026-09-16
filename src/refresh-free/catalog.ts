import { CliError } from "../locale.js";
export type OpenRouterModelEntry = {
  id: string;
  contextLength: number | null;
  maxCompletionTokens: number | null;
  supportedParametersCount: number;
  modality: string | null;
  inferredParamB: number | null;
  createdAtMs: number | null;
};

export type FilteredOpenRouterCatalog = {
  freeModelsAll: OpenRouterModelEntry[];
  freeModelsAgeFiltered: OpenRouterModelEntry[];
  freeModels: OpenRouterModelEntry[];
  ageFilteredIds: string[];
  smallFilteredIds: string[];
};

export async function fetchOpenRouterCatalog(
  fetchImpl: typeof fetch,
): Promise<OpenRouterModelEntry[]> {
  const response = await fetchImpl("https://openrouter.ai/api/v1/models", {
    headers: { Accept: "application/json" },
  });
  if (!response.ok) {
    throw new CliError("error.openrouterModels", { status: String(response.status) });
  }
  return parseOpenRouterCatalog(await response.json());
}

export function inferParamBFromIdOrName(text: string): number | null {
  const raw = text.toLowerCase();
  const matches = raw.matchAll(/(?:^|[^a-z0-9])[a-z]?(\d+(?:\.\d+)?)b(?:[^a-z0-9]|$)/g);
  let best: number | null = null;
  for (const match of matches) {
    const value = Number(match[1]);
    if (!Number.isFinite(value) || value <= 0) continue;
    if (best === null || value > best) best = value;
  }
  return best;
}

export function parseOpenRouterCatalog(payload: unknown): OpenRouterModelEntry[] {
  if (!payload || typeof payload !== "object") return [];
  const entries = Array.isArray((payload as { data?: unknown }).data)
    ? ((payload as { data: unknown[] }).data ?? [])
    : [];

  return entries
    .map((entry) => {
      if (!entry || typeof entry !== "object") return null;
      const obj = entry as Record<string, unknown>;
      const id = typeof obj.id === "string" ? obj.id.trim() : "";
      if (!id) return null;
      const name = typeof obj.name === "string" ? obj.name.trim() : "";
      const contextLength =
        typeof obj.context_length === "number" && Number.isFinite(obj.context_length)
          ? obj.context_length
          : null;
      const topProvider =
        obj.top_provider && typeof obj.top_provider === "object"
          ? (obj.top_provider as Record<string, unknown>)
          : null;
      const maxCompletionTokens =
        typeof topProvider?.max_completion_tokens === "number" &&
        Number.isFinite(topProvider.max_completion_tokens)
          ? (topProvider.max_completion_tokens as number)
          : null;
      const supportedParametersCount = Array.isArray(obj.supported_parameters)
        ? obj.supported_parameters.filter(
            (value) => typeof value === "string" && value.trim().length > 0,
          ).length
        : 0;
      const architecture =
        obj.architecture && typeof obj.architecture === "object"
          ? (obj.architecture as Record<string, unknown>)
          : null;
      const rawModality =
        typeof architecture?.modality === "string" ? architecture.modality.trim() : "";
      const created =
        typeof obj.created === "number" && Number.isFinite(obj.created) && obj.created > 0
          ? Math.round(obj.created * 1000)
          : null;

      return {
        id,
        contextLength,
        maxCompletionTokens,
        supportedParametersCount,
        modality: rawModality || null,
        inferredParamB: inferParamBFromIdOrName(`${id} ${name}`),
        createdAtMs: created,
      } satisfies OpenRouterModelEntry;
    })
    .filter((entry): entry is OpenRouterModelEntry => Boolean(entry));
}

export function filterOpenRouterFreeModels(
  catalog: OpenRouterModelEntry[],
  {
    maxAgeDays,
    minParamB,
    nowMs = Date.now(),
  }: {
    maxAgeDays: number;
    minParamB: number;
    nowMs?: number;
  },
): FilteredOpenRouterCatalog {
  const freeModelsAll = catalog.filter((model) => model.id.endsWith(":free"));
  const maxAgeMs = maxAgeDays * 24 * 60 * 60 * 1000;
  const freeModelsAgeFiltered = freeModelsAll.filter((model) => {
    if (maxAgeDays <= 0) return true;
    if (model.createdAtMs === null) return false;
    const ageMs = nowMs - model.createdAtMs;
    return ageMs >= 0 && ageMs <= maxAgeMs;
  });
  const freeModels = freeModelsAgeFiltered.filter(
    (model) => model.inferredParamB === null || model.inferredParamB >= minParamB,
  );
  const eligibleByAge = new Set(freeModelsAgeFiltered.map((model) => model.id));
  const eligibleBySize = new Set(freeModels.map((model) => model.id));

  return {
    freeModelsAll,
    freeModelsAgeFiltered,
    freeModels,
    ageFilteredIds: freeModelsAll
      .filter((model) => !eligibleByAge.has(model.id))
      .map((model) => model.id)
      .sort((a, b) => a.localeCompare(b)),
    smallFilteredIds: freeModelsAgeFiltered
      .filter((model) => !eligibleBySize.has(model.id))
      .map((model) => model.id)
      .sort((a, b) => a.localeCompare(b)),
  };
}

export function rankOpenRouterModelsForBenchmark(
  models: OpenRouterModelEntry[],
): OpenRouterModelEntry[] {
  return models.slice().sort((a, b) => {
    const aCreated = a.createdAtMs ?? -1;
    const bCreated = b.createdAtMs ?? -1;
    if (aCreated !== bCreated) return bCreated - aCreated;
    const aContext = a.contextLength ?? -1;
    const bContext = b.contextLength ?? -1;
    if (aContext !== bContext) return bContext - aContext;
    const aOut = a.maxCompletionTokens ?? -1;
    const bOut = b.maxCompletionTokens ?? -1;
    if (aOut !== bOut) return bOut - aOut;
    if (a.supportedParametersCount !== b.supportedParametersCount) {
      return b.supportedParametersCount - a.supportedParametersCount;
    }
    return a.id.localeCompare(b.id);
  });
}
