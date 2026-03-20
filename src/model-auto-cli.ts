import type { CliAutoFallbackConfig, CliProvider, SummarizeConfig } from "./config.js";
import { DEFAULT_AUTO_CLI_ORDER, DEFAULT_CLI_MODELS } from "./llm/provider-capabilities.js";

export type ResolvedCliAutoFallbackConfig = {
  enabled: boolean;
  onlyWhenNoApiKeys: boolean;
  order: CliProvider[];
};

function dedupeCliProviderOrder(order: CliProvider[]): CliProvider[] {
  const out: CliProvider[] = [];
  for (const provider of order) {
    if (!out.includes(provider)) out.push(provider);
  }
  return out;
}

export function resolveCliAutoFallbackConfig(
  config: SummarizeConfig | null,
): ResolvedCliAutoFallbackConfig {
  const raw = (config?.cli?.autoFallback ??
    config?.cli?.magicAuto ??
    null) as CliAutoFallbackConfig | null;
  const order =
    Array.isArray(raw?.order) && raw.order.length > 0 ? raw.order : DEFAULT_AUTO_CLI_ORDER;
  return {
    enabled: typeof raw?.enabled === "boolean" ? raw.enabled : true,
    onlyWhenNoApiKeys: typeof raw?.onlyWhenNoApiKeys === "boolean" ? raw.onlyWhenNoApiKeys : true,
    order: dedupeCliProviderOrder(order),
  };
}

function hasAnyApiKeysConfigured(env: Record<string, string | undefined>): boolean {
  const has = (value: string | undefined) => typeof value === "string" && value.trim().length > 0;
  return Boolean(
    has(env.OPENAI_API_KEY) ||
    has(env.GEMINI_API_KEY) ||
    has(env.GOOGLE_GENERATIVE_AI_API_KEY) ||
    has(env.GOOGLE_API_KEY) ||
    has(env.ANTHROPIC_API_KEY) ||
    has(env.XAI_API_KEY) ||
    has(env.OPENROUTER_API_KEY) ||
    has(env.Z_AI_API_KEY) ||
    has(env.ZAI_API_KEY),
  );
}

function prioritizeCliProvider(
  providers: CliProvider[],
  preferred: CliProvider | null | undefined,
): CliProvider[] {
  if (!preferred) return providers;
  const idx = providers.indexOf(preferred);
  if (idx <= 0) return providers;
  return [preferred, ...providers.slice(0, idx), ...providers.slice(idx + 1)];
}

function isCliProviderEnabled(provider: CliProvider, config: SummarizeConfig | null): boolean {
  const cli = config?.cli;
  if (!Array.isArray(cli?.enabled) || cli.enabled.length === 0) return false;
  return cli.enabled.includes(provider);
}

export function prependCliCandidates({
  candidates,
  config,
  env,
  isImplicitAutoSelection,
  allowAutoCliFallback,
  lastSuccessfulCliProvider,
}: {
  candidates: string[];
  config: SummarizeConfig | null;
  env: Record<string, string | undefined>;
  isImplicitAutoSelection: boolean;
  allowAutoCliFallback: boolean;
  lastSuccessfulCliProvider: CliProvider | null;
}): string[] {
  const cli = config?.cli;
  const autoFallback = resolveCliAutoFallbackConfig(config);
  const hasExplicitEnabledList = Array.isArray(cli?.enabled);
  const enabledOrder: CliProvider[] = (() => {
    if (hasExplicitEnabledList) return cli?.enabled ?? [];
    const shouldUseAutoFallback =
      autoFallback.enabled &&
      (isImplicitAutoSelection || allowAutoCliFallback) &&
      (!autoFallback.onlyWhenNoApiKeys || !hasAnyApiKeysConfigured(env));
    if (!shouldUseAutoFallback) return [];
    return autoFallback.order;
  })();
  if (enabledOrder.length === 0) return candidates;

  const providerOrder = prioritizeCliProvider(enabledOrder, lastSuccessfulCliProvider);
  const cliCandidates: string[] = [];

  const add = (provider: CliProvider, modelOverride?: string) => {
    if (hasExplicitEnabledList && !isCliProviderEnabled(provider, config)) return;
    const model = modelOverride?.trim() || DEFAULT_CLI_MODELS[provider] || null;
    const id = model ? `cli/${provider}/${model}` : `cli/${provider}`;
    if (!cliCandidates.includes(id)) cliCandidates.push(id);
  };

  for (const provider of providerOrder) {
    const modelOverride =
      provider === "gemini"
        ? cli?.gemini?.model
        : provider === "codex"
          ? cli?.codex?.model
          : provider === "agent"
            ? cli?.agent?.model
            : provider === "openclaw"
              ? cli?.openclaw?.model
            : provider === "opencode"
              ? cli?.opencode?.model
              : cli?.claude?.model;
    add(provider, modelOverride);
  }

  if (cliCandidates.length === 0) return candidates;
  return [...cliCandidates, ...candidates];
}
