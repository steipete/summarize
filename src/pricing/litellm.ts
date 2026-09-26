import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import {
  type LiteLlmCatalog,
  type LiteLlmLoadResult,
  loadLiteLlmCatalog as loadLiteLlmCatalogTokentally,
  resolveLiteLlmMaxInputTokens as resolveLiteLlmMaxInputTokensTokentally,
  resolveLiteLlmMaxOutputTokens as resolveLiteLlmMaxOutputTokensTokentally,
  resolveLiteLlmPricing as resolveLiteLlmPricingTokentally,
} from "tokentally/node";
import { getOpenAiGpt6Model } from "../llm/openai-catalog.js";

function withDefaultCacheDir(
  env: Record<string, string | undefined>,
): Record<string, string | undefined> {
  if (typeof env.TOKENTALLY_CACHE_DIR === "string" && env.TOKENTALLY_CACHE_DIR.trim().length > 0) {
    return env;
  }
  const home = env.HOME?.trim();
  if (!home) return env;
  return { ...env, TOKENTALLY_CACHE_DIR: path.join(home, ".summarize", "cache") };
}

function resolveCacheDir(env: Record<string, string | undefined>): string | null {
  const effectiveEnv = withDefaultCacheDir(env);
  const override = effectiveEnv.TOKENTALLY_CACHE_DIR?.trim();
  if (override) return override;
  const home = effectiveEnv.HOME?.trim();
  return home ? path.join(home, ".tokentally", "cache") : null;
}

function cacheCatalogPath(env: Record<string, string | undefined>): string | null {
  const cacheDir = resolveCacheDir(env);
  return cacheDir ? path.join(cacheDir, "litellm-model_prices_and_context_window.json") : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export type { LiteLlmCatalog, LiteLlmLoadResult };

export async function loadLiteLlmCatalog({
  env,
  fetchImpl,
  nowMs = Date.now(),
}: {
  env: Record<string, string | undefined>;
  fetchImpl: typeof fetch;
  nowMs?: number;
}): Promise<LiteLlmLoadResult> {
  return loadLiteLlmCatalogTokentally({
    env: withDefaultCacheDir(env),
    fetchImpl,
    nowMs,
  });
}

export async function loadCachedLiteLlmCatalog({
  env,
}: {
  env: Record<string, string | undefined>;
}): Promise<LiteLlmCatalog | null> {
  const catalogPath = cacheCatalogPath(env);
  if (!catalogPath || !existsSync(catalogPath)) return null;
  try {
    const raw = await fs.readFile(catalogPath, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    return isRecord(parsed) ? (parsed as LiteLlmCatalog) : null;
  } catch {
    return null;
  }
}

export type LlmPerTokenPricing = { inputUsdPerToken: number; outputUsdPerToken: number };

export function resolveLiteLlmPricingForModelId(
  catalog: LiteLlmCatalog,
  modelId: string,
): LlmPerTokenPricing | null {
  const model = getOpenAiGpt6Model(modelId.replace(/^openai\//, ""));
  if (model) {
    return {
      inputUsdPerToken: model.cost.input / 1_000_000,
      outputUsdPerToken: model.cost.output / 1_000_000,
    };
  }
  return resolveLiteLlmPricingTokentally(catalog, modelId);
}

export function resolveLiteLlmMaxOutputTokensForModelId(
  catalog: LiteLlmCatalog,
  modelId: string,
): number | null {
  if (getOpenAiGpt6Model(modelId.replace(/^openai\//, ""))) return 128_000;
  return resolveLiteLlmMaxOutputTokensTokentally(catalog, modelId);
}

export function resolveLiteLlmMaxInputTokensForModelId(
  catalog: LiteLlmCatalog,
  modelId: string,
): number | null {
  if (getOpenAiGpt6Model(modelId.replace(/^openai\//, ""))) return 922_000;
  return resolveLiteLlmMaxInputTokensTokentally(catalog, modelId);
}
