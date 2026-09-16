import { getModels } from "@earendil-works/pi-ai/compat";
import { isOpenRouterBaseUrl } from "@steipete/summarize-core";
import { resolveEnvState } from "../application/environment-state.js";
import { resolveCliAvailability } from "../application/environment.js";
import type { CliProvider, SummarizeConfig } from "../config.js";
import type { GatewayProvider } from "../llm/provider-capabilities.js";
import { createCliTranslator, type CliMessage } from "../locale.js";
import { discoverOpenAiCompatibleModels } from "./model-discovery.js";

export type ModelPickerOption = {
  id: string;
  label: string;
  labelMessage?: CliMessage;
};

type ModelPickerProviders = {
  xai: boolean;
  openai: boolean;
  nvidia: boolean;
  minimax: boolean;
  google: boolean;
  anthropic: boolean;
  openrouter: boolean;
  zai: boolean;
  ollama: boolean;
  cliClaude: boolean;
  cliGemini: boolean;
  cliCodex: boolean;
  cliAgent: boolean;
  cliOpenclaw: boolean;
  cliOpencode: boolean;
  cliCopilot: boolean;
  cliAgy: boolean;
  cliPi: boolean;
};

function modelOption(
  id: string,
  key: CliMessage["key"],
  values: CliMessage["values"] = {},
): ModelPickerOption {
  return { id, label: createCliTranslator("en")(key, values), labelMessage: { key, values } };
}

const CLI_PICKER_OPTIONS = [
  { provider: "claude", status: "cliClaude", id: "cli/claude", name: "Claude" },
  { provider: "gemini", status: "cliGemini", id: "cli/gemini", name: "Gemini" },
  { provider: "codex", status: "cliCodex", id: "cli/codex", name: "Codex" },
  { provider: "agent", status: "cliAgent", id: "cli/agent", name: "Cursor Agent" },
  {
    provider: "openclaw",
    status: "cliOpenclaw",
    id: "cli/openclaw",
    name: "OpenClaw",
  },
  {
    provider: "opencode",
    status: "cliOpencode",
    id: "cli/opencode",
    name: "OpenCode",
  },
  {
    provider: "copilot",
    status: "cliCopilot",
    id: "cli/copilot",
    name: "GitHub Copilot",
  },
  { provider: "agy", status: "cliAgy", id: "cli/agy", name: "Antigravity (agy)" },
  { provider: "pi", status: "cliPi", id: "cli/pi", name: "pi" },
] as const satisfies ReadonlyArray<{
  provider: CliProvider;
  status: keyof ModelPickerProviders;
  id: string;
  name: string;
}>;

const CATALOG_PICKER_PROVIDERS = [
  {
    provider: "openrouter",
    status: "openrouter",
    prefix: "openrouter/",
    labelPrefix: "OpenRouter: ",
  },
  { provider: "openai", status: "openai", prefix: "openai/", labelPrefix: "OpenAI: " },
  {
    provider: "anthropic",
    status: "anthropic",
    prefix: "anthropic/",
    labelPrefix: "Anthropic: ",
  },
  { provider: "google", status: "google", prefix: "google/", labelPrefix: "Google: " },
  { provider: "xai", status: "xai", prefix: "xai/", labelPrefix: "xAI: " },
  { provider: "zai", status: "zai", prefix: "zai/", labelPrefix: "Z.AI: " },
] as const satisfies ReadonlyArray<{
  provider: Parameters<typeof getModels>[0];
  status: keyof ModelPickerProviders;
  prefix: string;
  labelPrefix: string;
}>;

function uniqById(options: ModelPickerOption[]): ModelPickerOption[] {
  const seen = new Set<string>();
  const out: ModelPickerOption[] = [];
  for (const opt of options) {
    const id = opt.id.trim();
    if (!id) continue;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push({ id, label: opt.label.trim() || id });
  }
  return out;
}

function isProbablyOpenRouterBaseUrl(baseUrl: string): boolean {
  return isOpenRouterBaseUrl(baseUrl);
}

function isProbablyZaiBaseUrl(baseUrl: string): boolean {
  return /api\.z\.ai/i.test(baseUrl);
}

function pushPiAiModels({
  options,
  provider,
  prefix,
  labelPrefix,
}: {
  options: ModelPickerOption[];
  provider: Parameters<typeof getModels>[0];
  prefix: string;
  labelPrefix: string;
}) {
  const models = getModels(provider)
    .slice()
    .sort((a, b) => (a.name || a.id).localeCompare(b.name || b.id));
  for (const m of models) {
    const id = `${prefix}${m.id}`;
    const label = `${labelPrefix}${m.name || m.id}`;
    options.push({ id, label });
  }
}

async function appendDiscoveredOpenAiCompatibleModels({
  options,
  provider,
  label,
  local = false,
  baseUrl,
  apiKey,
  fetchImpl,
  timeoutMs,
}: {
  options: ModelPickerOption[];
  provider: Extract<GatewayProvider, "openai" | "nvidia" | "minimax" | "ollama">;
  label: string;
  local?: boolean;
  baseUrl: string;
  apiKey: string | null;
  fetchImpl: typeof fetch;
  timeoutMs: number;
}): Promise<{ baseUrlHost: string; count: number } | null> {
  const result = await discoverOpenAiCompatibleModels({
    baseUrl,
    apiKey,
    fetchImpl,
    timeoutMs,
  });
  if (!result) return null;
  for (const id of result.modelIds) {
    options.push(
      modelOption(`${provider}/${id}`, "model.discovered", {
        local,
        provider: label,
        host: result.baseUrlHost,
        model: id,
      }),
    );
  }
  return { baseUrlHost: result.baseUrlHost, count: result.modelIds.length };
}

export async function buildModelPickerOptions({
  env,
  envForRun,
  configForCli,
  fetchImpl,
}: {
  env: Record<string, string | undefined>;
  envForRun: Record<string, string | undefined>;
  configForCli: SummarizeConfig | null;
  fetchImpl: typeof fetch;
}): Promise<{
  ok: true;
  options: ModelPickerOption[];
  providers: ModelPickerProviders;
  openaiBaseUrl: string | null;
  localModelsSource: { kind: "openai-compatible"; baseUrlHost: string } | null;
}> {
  const envState = resolveEnvState({ env, envForRun, configForCli });

  const providers = {
    xai: Boolean(envState.xaiApiKey),
    openai: Boolean(envState.apiKey),
    nvidia: Boolean(envState.nvidiaApiKey),
    minimax: Boolean(envState.minimaxApiKey),
    google: envState.googleConfigured,
    anthropic: envState.anthropicConfigured,
    openrouter: envState.openrouterConfigured,
    zai: Boolean(envState.zaiApiKey),
    ollama: false,
    cliClaude: false,
    cliGemini: false,
    cliCodex: false,
    cliAgent: false,
    cliOpenclaw: false,
    cliOpencode: false,
    cliCopilot: false,
    cliAgy: false,
    cliPi: false,
  };
  const cliAvailability = resolveCliAvailability({ env: envForRun, config: configForCli });

  const options: ModelPickerOption[] = [
    modelOption("auto", "model.auto"),
    modelOption("fast", "model.fast"),
    modelOption("codex-fast", "model.codexFast"),
  ];

  for (const entry of CLI_PICKER_OPTIONS) {
    const available = Boolean(cliAvailability[entry.provider]);
    providers[entry.status] = available;
    if (available) {
      options.push(modelOption(entry.id, "model.cli", { name: entry.name }));
    }
  }

  for (const entry of CATALOG_PICKER_PROVIDERS) {
    if (!providers[entry.status]) continue;
    if (entry.provider === "openrouter") {
      options.push(modelOption("free", "model.free"));
    }
    pushPiAiModels({
      options,
      provider: entry.provider,
      prefix: entry.prefix,
      labelPrefix: entry.labelPrefix,
    });
  }

  const discoveryProviders = [
    {
      provider: "nvidia",
      label: "NVIDIA",
      enabled: providers.nvidia,
      baseUrl: envState.nvidiaBaseUrl,
      apiKey: envState.nvidiaApiKey,
    },
    {
      provider: "minimax",
      label: "MiniMax",
      enabled: providers.minimax,
      baseUrl: envState.minimaxBaseUrl,
      apiKey: envState.minimaxApiKey,
    },
  ] as const;
  for (const entry of discoveryProviders) {
    if (entry.enabled) {
      await appendDiscoveredOpenAiCompatibleModels({
        options,
        provider: entry.provider,
        label: entry.label,
        baseUrl: entry.baseUrl,
        apiKey: entry.apiKey,
        fetchImpl,
        timeoutMs: 1200,
      });
    }
  }

  const ollamaExplicitlyConfigured =
    Boolean(envForRun.OLLAMA_BASE_URL?.trim()) || Boolean(configForCli?.ollama?.baseUrl?.trim());
  if (ollamaExplicitlyConfigured) {
    const result = await appendDiscoveredOpenAiCompatibleModels({
      options,
      provider: "ollama",
      label: "Ollama",
      baseUrl: envState.ollamaBaseUrl,
      // Bare Ollama ignores auth; proxies may use the same OpenAI key as agent calls.
      apiKey: envState.apiKey,
      fetchImpl,
      timeoutMs: 1200,
    });
    providers.ollama = Boolean(result && result.count > 0);
  }

  const openaiBaseUrl = envState.providerBaseUrls.openai;

  let localModelsSource: { kind: "openai-compatible"; baseUrlHost: string } | null = null;

  if (
    openaiBaseUrl &&
    !isProbablyOpenRouterBaseUrl(openaiBaseUrl) &&
    !isProbablyZaiBaseUrl(openaiBaseUrl)
  ) {
    const result = await appendDiscoveredOpenAiCompatibleModels({
      options,
      provider: "openai",
      label: "",
      local: true,
      baseUrl: openaiBaseUrl,
      apiKey: envState.apiKey,
      fetchImpl,
      timeoutMs: 900,
    });
    if (result && result.count > 0) {
      localModelsSource = { kind: "openai-compatible", baseUrlHost: result.baseUrlHost };
    }
  }

  return {
    ok: true,
    options: uniqById(options),
    providers,
    openaiBaseUrl,
    localModelsSource,
  };
}
