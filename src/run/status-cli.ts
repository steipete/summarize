import { isOpenRouterBaseUrl } from "@steipete/summarize-core";
import { resolveEnvState } from "../application/environment-state.js";
import { resolveCliAvailability, resolveExecutableInPath } from "../application/environment.js";
import { resolveProviderRuntimeBindings } from "../application/provider-runtime.js";
import type { CliProvider, ModelConfig, SummarizeConfig } from "../config.js";
import { loadSummarizeConfig } from "../config.js";
import { discoverOpenAiCompatibleModels } from "../daemon/model-discovery.js";
import { buildModelPickerOptions } from "../daemon/models.js";
import { resolveCliBinary } from "../llm/cli.js";
import { getGatewayProviderProfile, type GatewayProvider } from "../llm/provider-capabilities.js";
import { buildStatusHelp } from "./help.js";

type StatusModel = {
  selection: string;
  source: "config" | "environment" | "default";
};

type StatusPreset = {
  name: string;
  model: string;
  candidates?: string[];
};

type StatusProvider = {
  id: string;
  label: string;
  kind: "api" | "cli" | "local";
  state: "configured" | "available" | "usable";
  source?: string;
  model?: string;
  path?: string;
  endpoint?: string;
  models?: string[];
};

export type StatusReport = {
  model: StatusModel;
  presets: StatusPreset[];
  providers: StatusProvider[];
  probed: boolean;
  config?: { path: string };
};

const CLI_PROVIDERS: Array<{ id: CliProvider; label: string }> = [
  { id: "claude", label: "Claude CLI" },
  { id: "codex", label: "Codex CLI" },
  { id: "gemini", label: "Gemini CLI" },
  { id: "agent", label: "Cursor Agent CLI" },
  { id: "openclaw", label: "OpenClaw CLI" },
  { id: "opencode", label: "OpenCode CLI" },
  { id: "copilot", label: "GitHub Copilot CLI" },
  { id: "agy", label: "Antigravity CLI" },
  { id: "pi", label: "Pi CLI" },
];

const API_STATUS_PROVIDERS = [
  { provider: "xai", id: "xai", label: "xAI API", sources: ["XAI_API_KEY"] },
  {
    provider: "google",
    id: "google",
    label: "Google Gemini API",
    sources: ["GEMINI_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY", "GOOGLE_API_KEY"],
  },
  {
    provider: "anthropic",
    id: "anthropic",
    label: "Anthropic API",
    sources: ["ANTHROPIC_API_KEY"],
  },
  {
    provider: "evolink",
    id: "evolink",
    label: "EvoLink API",
    sources: ["EVOLINK_API_KEY"],
  },
  {
    provider: "zai",
    id: "zai",
    label: "Z.AI API",
    sources: ["Z_AI_API_KEY", "ZAI_API_KEY"],
  },
  {
    provider: "nvidia",
    id: "nvidia",
    label: "NVIDIA API",
    sources: ["NVIDIA_API_KEY", "NGC_API_KEY"],
  },
  {
    provider: "minimax",
    id: "minimax",
    label: "MiniMax API",
    sources: ["MINIMAX_API_KEY"],
  },
  {
    provider: "github-copilot",
    id: "github-models",
    label: "GitHub Models API",
    sources: ["GITHUB_TOKEN", "GH_TOKEN"],
  },
] as const satisfies ReadonlyArray<{
  provider: Exclude<GatewayProvider, "openai" | "ollama">;
  id: string;
  label: string;
  sources: readonly string[];
}>;

function nonEmpty(value: string | undefined): string | null {
  const trimmed = value?.trim() ?? "";
  return trimmed.length > 0 ? trimmed : null;
}

function firstConfiguredEnv(
  env: Record<string, string | undefined>,
  names: string[],
): string | null {
  return names.find((name) => nonEmpty(env[name])) ?? null;
}

function describeModelConfig(model: ModelConfig): string {
  if ("id" in model) return model.id;
  if ("name" in model) return model.name;
  return "auto";
}

function collectModelCandidates(model: ModelConfig): string[] {
  if (!("mode" in model) || !model.rules) return [];
  const candidates = model.rules.flatMap((rule) => [
    ...(rule.candidates ?? []),
    ...(rule.bands?.flatMap((band) => band.candidates) ?? []),
  ]);
  return Array.from(new Set(candidates));
}

function resolveStatusModel(
  config: SummarizeConfig | null,
  env: Record<string, string | undefined>,
): StatusModel {
  const envModel = nonEmpty(env.SUMMARIZE_MODEL);
  if (envModel) return { selection: envModel, source: "environment" };
  if (config?.model) {
    return { selection: describeModelConfig(config.model), source: "config" };
  }
  return { selection: "auto", source: "default" };
}

function resolvePresets(config: SummarizeConfig | null): StatusPreset[] {
  return Object.entries(config?.models ?? {})
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, model]) => {
      const candidates = collectModelCandidates(model);
      return {
        name,
        model: describeModelConfig(model),
        ...(candidates.length > 0 ? { candidates } : {}),
      };
    });
}

function resolveConfiguredCliModel(
  provider: CliProvider,
  config: SummarizeConfig | null,
): string | null {
  if (provider === "agy") return null;
  const providerConfig = config?.cli?.[provider];
  return nonEmpty(providerConfig?.model);
}

function endpointHost(baseUrl: string | null): string | undefined {
  if (!baseUrl) return undefined;
  try {
    return new URL(baseUrl).host || undefined;
  } catch {
    return undefined;
  }
}

function pushProvider(providers: StatusProvider[], provider: StatusProvider): void {
  if (!providers.some((entry) => entry.id === provider.id)) providers.push(provider);
}

function resolveConfiguredProviders({
  env,
  config,
}: {
  env: Record<string, string | undefined>;
  config: SummarizeConfig | null;
}): StatusProvider[] {
  const providers: StatusProvider[] = [];
  const envState = resolveEnvState({ env, envForRun: env, configForCli: config });
  const runtime = resolveProviderRuntimeBindings({ env, envState, configForCli: config });
  const openaiBaseUrl = envState.providerBaseUrls.openai;
  const openaiHost = endpointHost(openaiBaseUrl);
  const openaiBaseIsOpenRouter = Boolean(openaiBaseUrl && isOpenRouterBaseUrl(openaiBaseUrl));
  const openaiBaseIsDefault = !openaiHost || openaiHost === "api.openai.com";

  if (openaiBaseIsOpenRouter && envState.apiKey) {
    pushProvider(providers, {
      id: "openrouter",
      label: "OpenRouter API",
      kind: "api",
      state: "configured",
      source: firstConfiguredEnv(env, ["OPENROUTER_API_KEY", "OPENAI_API_KEY"]) ?? undefined,
      endpoint: openaiHost,
    });
  } else if (!openaiBaseIsDefault) {
    pushProvider(providers, {
      id: "openai-compatible",
      label: openaiHost ? `OpenAI-compatible API (${openaiHost})` : "OpenAI-compatible API",
      kind: "local",
      state: "configured",
      source: firstConfiguredEnv(env, ["OPENAI_BASE_URL"]) ?? undefined,
      endpoint: openaiHost,
    });
  } else if (runtime.apiKeys.openai) {
    pushProvider(providers, {
      id: "openai",
      label: "OpenAI API",
      kind: "api",
      state: "configured",
      source: "OPENAI_API_KEY",
      endpoint: openaiHost,
    });
  }

  if (envState.openrouterApiKey) {
    pushProvider(providers, {
      id: "openrouter",
      label: "OpenRouter API",
      kind: "api",
      state: "configured",
      source: firstConfiguredEnv(env, ["OPENROUTER_API_KEY", "OPENAI_API_KEY"]) ?? undefined,
    });
  }
  for (const entry of API_STATUS_PROVIDERS) {
    if (!runtime.apiKeys[entry.provider]) continue;
    const baseUrl =
      runtime.baseUrls[entry.provider] ??
      getGatewayProviderProfile(entry.provider).defaultBaseUrl ??
      null;
    pushProvider(providers, {
      id: entry.id,
      label: entry.label,
      kind: "api",
      state: "configured",
      source: firstConfiguredEnv(env, [...entry.sources]) ?? undefined,
      endpoint: endpointHost(baseUrl),
    });
  }

  const ollamaSource =
    firstConfiguredEnv(env, ["OLLAMA_BASE_URL"]) ??
    (nonEmpty(config?.ollama?.baseUrl) ? "config: ollama.baseUrl" : null);
  if (ollamaSource) {
    pushProvider(providers, {
      id: "ollama",
      label: "Ollama",
      kind: "local",
      state: "configured",
      source: ollamaSource,
      endpoint: endpointHost(envState.ollamaBaseUrl),
    });
  }

  const cliAvailability = resolveCliAvailability({ env, config });
  for (const { id, label } of CLI_PROVIDERS) {
    if (!cliAvailability[id]) continue;
    const binary = resolveCliBinary(id, config?.cli, env);
    const executablePath = resolveExecutableInPath(binary, env);
    pushProvider(providers, {
      id: `cli-${id}`,
      label,
      kind: "cli",
      state: "available",
      model: resolveConfiguredCliModel(id, config) ?? undefined,
      path: executablePath ?? undefined,
    });
  }

  return providers;
}

function discoveredModels(
  options: Array<{ id: string; label: string }>,
  labelPrefix: string,
): string[] {
  return options
    .filter((option) => option.label.startsWith(labelPrefix))
    .map((option) => option.id);
}

async function applyProviderProbes({
  providers,
  env,
  config,
  fetchImpl,
}: {
  providers: StatusProvider[];
  env: Record<string, string | undefined>;
  config: SummarizeConfig | null;
  fetchImpl: typeof fetch;
}): Promise<void> {
  let result: Awaited<ReturnType<typeof buildModelPickerOptions>>;
  try {
    result = await buildModelPickerOptions({
      env,
      envForRun: env,
      configForCli: config,
      fetchImpl,
    });
  } catch {
    return;
  }

  const probeModels = new Map<string, string[]>([
    ["openai-compatible", discoveredModels(result.options, "Local (")],
    ["ollama", discoveredModels(result.options, "Ollama (")],
    ["evolink", discoveredModels(result.options, "EvoLink (")],
    ["nvidia", discoveredModels(result.options, "NVIDIA (")],
    ["minimax", discoveredModels(result.options, "MiniMax (")],
  ]);

  for (const provider of providers) {
    const models = probeModels.get(provider.id) ?? [];
    if (models.length === 0) continue;
    provider.state = "usable";
    provider.models = models;
  }

  if (!providers.some((provider) => provider.id === "ollama")) {
    const envState = resolveEnvState({ env, envForRun: env, configForCli: config });
    const discovery = await discoverOpenAiCompatibleModels({
      baseUrl: envState.ollamaBaseUrl,
      apiKey: null,
      fetchImpl,
      timeoutMs: 1200,
    });
    const models = discovery?.modelIds ?? [];
    if (models.length > 0) {
      pushProvider(providers, {
        id: "ollama",
        label: "Ollama",
        kind: "local",
        state: "usable",
        endpoint: endpointHost(envState.ollamaBaseUrl),
        models: models.map((model) => `ollama/${model}`),
      });
    }
  }
}

export async function buildStatusReport({
  env,
  fetchImpl,
  probe,
}: {
  env: Record<string, string | undefined>;
  fetchImpl: typeof fetch;
  probe: boolean;
}): Promise<StatusReport> {
  const { config, path } = loadSummarizeConfig({ env });
  const providers = resolveConfiguredProviders({ env, config });
  if (probe) {
    await applyProviderProbes({ providers, env, config, fetchImpl });
  }
  return {
    model: resolveStatusModel(config, env),
    presets: resolvePresets(config),
    providers,
    probed: probe,
    ...(config && path ? { config: { path } } : {}),
  };
}

function formatHumanStatus(report: StatusReport, verbose: boolean): string {
  const lines = [
    `Model: ${report.model.selection} (${report.model.source})`,
    ...(report.config ? [`Config: ${report.config.path}`] : []),
  ];

  if (report.presets.length > 0) {
    lines.push("", "Presets:");
    for (const preset of report.presets) {
      const candidates =
        verbose && preset.candidates?.length ? ` -> ${preset.candidates.join(", ")}` : "";
      lines.push(`  ${preset.name}: ${preset.model}${candidates}`);
    }
  }

  if (report.providers.length > 0) {
    lines.push("", "Providers:");
    for (const provider of report.providers) {
      const details = [
        provider.model ? `model ${provider.model}` : null,
        verbose && provider.path ? provider.path : null,
        verbose && provider.endpoint ? provider.endpoint : null,
        verbose && provider.source ? `via ${provider.source}` : null,
      ].filter((value): value is string => Boolean(value));
      lines.push(
        `  ${provider.label}: ${provider.state}${details.length > 0 ? ` (${details.join(", ")})` : ""}`,
      );
      if (provider.models?.length) {
        for (const model of provider.models) lines.push(`    ${model}`);
      }
    }
  }

  return `${lines.join("\n")}\n`;
}

export async function handleStatusCliRequest({
  normalizedArgv,
  envForRun,
  fetchImpl,
  stdout,
}: {
  normalizedArgv: string[];
  envForRun: Record<string, string | undefined>;
  fetchImpl: typeof fetch;
  stdout: NodeJS.WritableStream;
}): Promise<boolean> {
  if (normalizedArgv[0]?.toLowerCase() !== "status") return false;

  const help =
    normalizedArgv.includes("--help") ||
    normalizedArgv.includes("-h") ||
    normalizedArgv.includes("help");
  if (help) {
    stdout.write(`${buildStatusHelp()}\n`);
    return true;
  }

  const allowed = new Set(["status", "--json", "--probe", "--verbose", "--no-color"]);
  const unknown = normalizedArgv.find((arg) => !allowed.has(arg));
  if (unknown) throw new Error(`Unknown status option: ${unknown}`);

  const report = await buildStatusReport({
    env: envForRun,
    fetchImpl,
    probe: normalizedArgv.includes("--probe"),
  });
  if (normalizedArgv.includes("--json")) {
    stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    stdout.write(formatHumanStatus(report, normalizedArgv.includes("--verbose")));
  }
  return true;
}
